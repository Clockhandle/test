// CDT mesh generator — Constrained Delaunay + slope-only spike filter.
//
// Pipeline per boundary:
//   1. Collect contour lines whose first vertex lies inside this boundary.
//   2. Insert all contour + boundary vertices into a fresh CGAL CDT.
//   3. Insert every consecutive pair of contour vertices as a constrained edge
//      (breakline), so the CDT is forced to include those survey line edges.
//   4. Insert the closed boundary polygon as a constrained loop.
//   5. For each finite CDT triangle: compute centroid and test it against the
//      boundary polygon (point-in-polygon).  Triangles outside are dropped.
//   6. Slope filter: drop any remaining triangle where
//      (max_z - min_z) / longest_XY_edge > slope_threshold.
//   7. Emit JSON.
//
// Input grammar (whitespace-separated tokens on stdin):
//   POLYLINES  <N>    number of POLY blocks
//   BOUNDARIES <M>    number of BPOLY blocks
//   POLY  <K>         open contour: K vertices follow as "x y z"
//   BPOLY <K>         closed boundary loop: K vertices (no repeated first)
//   SLOPE <v>         max (delta_z / XY_edge) kept (default 5.0; <=0 = no filter)

#include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
#include <CGAL/Constrained_Delaunay_triangulation_2.h>
#include <CGAL/Triangulation_vertex_base_with_info_2.h>
#include <CGAL/Constrained_triangulation_face_base_2.h>
#include <CGAL/Triangulation_data_structure_2.h>
#include <CGAL/Advancing_front_surface_reconstruction.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <random>
#include <set>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>
#include "json.hpp"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// ---- CGAL type stack ----
using K   = CGAL::Exact_predicates_inexact_constructions_kernel;
// Each vertex stores Z as its "info" (double).
using Vb  = CGAL::Triangulation_vertex_base_with_info_2<double, K>;
using Fb  = CGAL::Constrained_triangulation_face_base_2<K>;
using Tds = CGAL::Triangulation_data_structure_2<Vb, Fb>;
using CDT = CGAL::Constrained_Delaunay_triangulation_2<K, Tds,
                  CGAL::Exact_predicates_tag>;
using Point = CDT::Point;
using VH    = CDT::Vertex_handle;

using Polyline = std::vector<std::array<double, 3>>;

// ---- helpers ----

static bool point_in_polygon_xy(double px, double py, const Polyline& poly)
{
    int n = static_cast<int>(poly.size());
    if (n < 3) return false;
    bool inside = false;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        double xi = poly[i][0], yi = poly[i][1];
        double xj = poly[j][0], yj = poly[j][1];
        if (((yi > py) != (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi))
            inside = !inside;
    }
    return inside;
}

// Hash vertex handle by the address of its underlying object.
struct VHHash {
    std::size_t operator()(VH vh) const noexcept {
        return std::hash<const void*>()(static_cast<const void*>(&*vh));
    }
};

// ---- per-boundary meshing ----

struct MeshOut {
    std::vector<std::array<double, 3>> vertices;
    std::vector<std::array<int, 3>>    triangles;
    int    num_contours  = 0;
    int    dropped_slope = 0;
    double slope_used    = 0.0;
};

static MeshOut mesh_boundary(const Polyline&                     boundary,
                              const std::vector<const Polyline*>& contours,
                              double                              slope_threshold)
{
    MeshOut out;
    out.num_contours = static_cast<int>(contours.size());
    out.slope_used   = slope_threshold;
    if (boundary.size() < 3) return out;

    CDT cdt;

    // Insert a vertex and set its Z info.  If CGAL returns an existing
    // vertex (identical XY), we overwrite Z with the last writer's value
    // — that's fine for our purposes.
    auto ins = [&](double x, double y, double z) -> VH {
        VH vh = cdt.insert(Point(x, y));
        vh->info() = z;
        return vh;
    };

    // --- boundary polygon as a closed constrained loop ---
    {
        const std::size_t n = boundary.size();
        std::vector<VH> bvh(n);
        for (std::size_t i = 0; i < n; ++i)
            bvh[i] = ins(boundary[i][0], boundary[i][1], boundary[i][2]);
        for (std::size_t i = 0; i < n; ++i) {
            VH a = bvh[i], b = bvh[(i + 1) % n];
            if (a != b) cdt.insert_constraint(a, b);
        }
    }

    // --- contour polylines as constrained breaklines ---
    // Contour lines are plan-view elevation curves that do not cross in XY.
    // Inserting them as constraints forces the CDT to include edges along each
    // contour, so Delaunay only fills the between-contour gaps.  Without
    // constraints the Delaunay criterion can connect vertices across multiple
    // Z-level contours, producing spike triangles.
    for (const Polyline* pp : contours) {
        const Polyline& p = *pp;
        if (p.size() < 2) continue;
        std::vector<VH> cvh(p.size());
        for (std::size_t i = 0; i < p.size(); ++i)
            cvh[i] = ins(p[i][0], p[i][1], p[i][2]);
        for (std::size_t i = 0; i + 1 < p.size(); ++i)
            if (cvh[i] != cvh[i + 1])
                cdt.insert_constraint(cvh[i], cvh[i + 1]);
    }

    // Build vertex-handle → output-index map on demand.
    std::unordered_map<VH, int, VHHash> vidx;
    auto get_idx = [&](VH vh) -> int {
        auto it = vidx.find(vh);
        if (it != vidx.end()) return it->second;
        int idx = static_cast<int>(out.vertices.size());
        out.vertices.push_back({ vh->point().x(), vh->point().y(), vh->info() });
        vidx[vh] = idx;
        return idx;
    };

    // Iterate finite faces; keep those whose centroid is inside the boundary.
    for (auto fit = cdt.finite_faces_begin(); fit != cdt.finite_faces_end(); ++fit) {
        VH v0 = fit->vertex(0), v1 = fit->vertex(1), v2 = fit->vertex(2);
        double x0 = v0->point().x(), y0 = v0->point().y();
        double x1 = v1->point().x(), y1 = v1->point().y();
        double x2 = v2->point().x(), y2 = v2->point().y();

        // Centroid containment test.
        double cx = (x0 + x1 + x2) / 3.0;
        double cy = (y0 + y1 + y2) / 3.0;
        if (!point_in_polygon_xy(cx, cy, boundary)) continue;

        // Slope filter — drop spike triangles.
        if (slope_threshold > 0.0) {
            double z0 = v0->info(), z1 = v1->info(), z2 = v2->info();
            double zmin = std::min({ z0, z1, z2 });
            double zmax = std::max({ z0, z1, z2 });
            double e01  = std::sqrt((x1-x0)*(x1-x0) + (y1-y0)*(y1-y0));
            double e12  = std::sqrt((x2-x1)*(x2-x1) + (y2-y1)*(y2-y1));
            double e20  = std::sqrt((x0-x2)*(x0-x2) + (y0-y2)*(y0-y2));
            double longest = std::max({ e01, e12, e20 });
            if (longest > 0.0 && (zmax - zmin) / longest > slope_threshold) {
                ++out.dropped_slope;
                continue;
            }
        }

        out.triangles.push_back({ get_idx(v0), get_idx(v1), get_idx(v2) });
    }
    return out;
}

// ---- File-mode support (main.cpp-style: JSON in → OBJ out) ----
// Activated when the binary is called with two file arguments:
//   mesh_gen.exe input.json output.obj

using json    = nlohmann::json;
using Point_3 = K::Point_3;

static const double SAME_Z_GAP_THRESHOLD = 50.0;

struct DepthConfig {
    double distance   = 100.0;
    double pitch_deg  =  60.0;
    double yaw_deg    =   0.0;
    double noise_band =   0.0;
    double color_tint =   0.6;
    bool   enabled    = true;
};
static const DepthConfig DEPTH_CFG;

struct Slice {
    int id = 0;
    std::string type, viaName, blockName, layer;
    std::vector<std::array<double, 3>> vertices;
    std::array<double, 3> centroid{};
    std::array<double, 3> color = {0.5, 0.5, 0.5};
    double perimeter = 0.0;
    bool active = true;
};

static double _dist(const std::array<double,3>& a, const std::array<double,3>& b) {
    double dx=a[0]-b[0], dy=a[1]-b[1], dz=a[2]-b[2];
    return std::sqrt(dx*dx+dy*dy+dz*dz);
}
static std::array<double,3> GetCentroid(const std::vector<std::array<double,3>>& v) {
    double sx=0,sy=0,sz=0;
    for(const auto& p:v){sx+=p[0];sy+=p[1];sz+=p[2];}
    double n=(double)v.size();
    return{sx/n,sy/n,sz/n};
}
static double GetPerimeter(const std::vector<std::array<double,3>>& v) {
    double p=0;
    for(size_t i=0;i+1<v.size();i++) p+=_dist(v[i],v[i+1]);
    return p;
}

static void StitchFragments(std::vector<Slice>& slices) {
    const double MERGE_THRESH = 1.0;
    bool merged = true;
    while (merged) {
        merged = false;
        for (size_t i = 0; i < slices.size(); i++) {
            if (!slices[i].active) continue;
            for (size_t j = 0; j < slices.size(); j++) {
                if (i == j || !slices[j].active) continue;
                auto& s1 = slices[i].vertices;
                auto& s2 = slices[j].vertices;
                double avgZ1 = (s1.front()[2]+s1.back()[2])/2.0;
                double avgZ2 = (s2.front()[2]+s2.back()[2])/2.0;
                if (std::abs(avgZ1-avgZ2) > SAME_Z_GAP_THRESHOLD) continue;
                double d1=_dist(s1.back(), s2.front());
                double d2=_dist(s1.back(), s2.back());
                double d3=_dist(s1.front(),s2.front());
                double d4=_dist(s1.front(),s2.back());
                double dMin=std::min({d1,d2,d3,d4});
                if (dMin > MERGE_THRESH) continue;
                if      (d1<=dMin) s1.insert(s1.end(),  s2.begin(), s2.end());
                else if (d2<=dMin) s1.insert(s1.end(),  s2.rbegin(),s2.rend());
                else if (d3<=dMin) s1.insert(s1.begin(),s2.rbegin(),s2.rend());
                else               s1.insert(s1.begin(),s2.begin(), s2.end());
                slices[j].active = false;
                merged = true;
            }
            if (merged) break;
        }
    }
    slices.erase(std::remove_if(slices.begin(),slices.end(),[](const Slice& s){return !s.active;}),slices.end());
}

static std::vector<size_t> ExtractBoundaryLoop(const std::vector<std::array<std::size_t,3>>& facets) {
    std::map<std::pair<size_t,size_t>,int> ec;
    for (const auto& f : facets)
        for (auto& e : std::vector<std::pair<size_t,size_t>>{{f[0],f[1]},{f[1],f[2]},{f[2],f[0]}})
            ec[{std::min(e.first,e.second),std::max(e.first,e.second)}]++;
    std::map<size_t,std::vector<size_t>> adj;
    for (const auto& [edge,cnt] : ec)
        if (cnt==1) { adj[edge.first].push_back(edge.second); adj[edge.second].push_back(edge.first); }
    if (adj.empty()) return {};
    std::vector<size_t> loop;
    std::set<size_t> visited;
    size_t cur = adj.begin()->first;
    while (true) {
        loop.push_back(cur); visited.insert(cur);
        bool adv = false;
        for (size_t nb : adj[cur])
            if (!visited.count(nb)) { cur=nb; adv=true; break; }
        if (!adv) break;
    }
    return loop;
}

static void ReconstructSurfaceWithCGAL(
    const std::vector<Slice>& slices,
    std::vector<std::array<double,3>>& gVerts,
    std::vector<std::array<double,3>>& gColors,
    std::vector<int>& gIdx,
    std::vector<std::array<double,3>>* outLoop = nullptr)
{
    if (slices.empty()) return;
    std::vector<Point_3> pts;
    std::vector<std::array<double,3>> cols;
    for (const auto& s : slices)
        for (const auto& v : s.vertices) {
            pts.push_back(Point_3(v[0],v[1],v[2]));
            cols.push_back(s.color);
        }
    std::cout << "  Points for reconstruction: " << pts.size() << std::endl;
    typedef std::array<std::size_t,3> Facet;
    std::vector<Facet> facets;
    CGAL::advancing_front_surface_reconstruction(pts.begin(), pts.end(), std::back_inserter(facets));
    std::cout << "  CGAL generated " << facets.size() << " triangles" << std::endl;
    size_t base = gVerts.size();
    for (size_t i = 0; i < pts.size(); i++) {
        gVerts.push_back({pts[i].x(), pts[i].y(), pts[i].z()});
        gColors.push_back(cols[i]);
    }
    for (const auto& f : facets) {
        gIdx.push_back((int)(base+f[0]));
        gIdx.push_back((int)(base+f[1]));
        gIdx.push_back((int)(base+f[2]));
    }
    if (outLoop) {
        auto li = ExtractBoundaryLoop(facets);
        outLoop->clear();
        for (size_t idx : li)
            outLoop->push_back({pts[idx].x(), pts[idx].y(), pts[idx].z()});
        std::cout << "  Boundary loop: " << outLoop->size() << " verts" << std::endl;
    }
}

static void WriteObj(const std::string& file,
                     const std::vector<std::array<double,3>>& v,
                     const std::vector<std::array<double,3>>& c,
                     const std::vector<int>& f)
{
    std::ofstream out(file);
    out << "o MiningMesh\n";
    for (size_t i = 0; i < v.size(); i++)
        out << "v " << v[i][0] << " " << v[i][1] << " " << v[i][2]
            << " " << c[i][0] << " " << c[i][1] << " " << c[i][2] << "\n";
    for (size_t i = 0; i < f.size(); i+=3)
        out << "f " << f[i]+1 << " " << f[i+1]+1 << " " << f[i+2]+1 << "\n";
}

static void StitchBoundaryLoops(
    const std::vector<std::array<double,3>>& top,
    const std::vector<std::array<double,3>>& bot,
    const std::array<double,3>& color,
    std::vector<std::array<double,3>>& gVerts,
    std::vector<std::array<double,3>>& gColors,
    std::vector<int>& gIdx)
{
    if (top.empty() || bot.empty()) return;
    size_t base = gVerts.size();
    for (const auto& p : top) { gVerts.push_back(p); gColors.push_back(color); }
    for (const auto& p : bot) { gVerts.push_back(p); gColors.push_back(color); }
    size_t nT = top.size(), nB = bot.size();
    size_t bestB = 0; double minD = std::numeric_limits<double>::max();
    for (size_t j = 0; j < nB; j++) {
        double d=(top[0][0]-bot[j][0])*(top[0][0]-bot[j][0])+(top[0][1]-bot[j][1])*(top[0][1]-bot[j][1]);
        if (d < minD) { minD=d; bestB=j; }
    }
    size_t nF=(bestB+1)%nB, nBk=(bestB+nB-1)%nB;
    double dF=(top[1%nT][0]-bot[nF][0])*(top[1%nT][0]-bot[nF][0])+(top[1%nT][1]-bot[nF][1])*(top[1%nT][1]-bot[nF][1]);
    double dBk=(top[1%nT][0]-bot[nBk][0])*(top[1%nT][0]-bot[nBk][0])+(top[1%nT][1]-bot[nBk][1])*(top[1%nT][1]-bot[nBk][1]);
    bool rev = dBk < dF;
    auto dSq=[](const std::array<double,3>& a,const std::array<double,3>& b){
        return (a[0]-b[0])*(a[0]-b[0])+(a[1]-b[1])*(a[1]-b[1])+(a[2]-b[2])*(a[2]-b[2]);};
    size_t tI=0, bI=bestB, tW=0, bW=0; int tris=0;
    while (tW < nT || bW < nB) {
        size_t t0=tI, b0=bI, t1=(tI+1)%nT, b1=rev?(bI+nB-1)%nB:(bI+1)%nB;
        bool mt = (tW==nT) ? false : (bW==nB) ? true : dSq(top[t1],bot[b0])<=dSq(top[t0],bot[b1]);
        if (mt) {
            gIdx.push_back((int)(base+t0)); gIdx.push_back((int)(base+t1)); gIdx.push_back((int)(base+nT+b0));
            tI=t1; tW++;
        } else {
            gIdx.push_back((int)(base+t0)); gIdx.push_back((int)(base+nT+b1)); gIdx.push_back((int)(base+nT+b0));
            bI=b1; bW++;
        }
        tris++;
    }
    std::cout << "  Side walls: " << tris << " triangles" << std::endl;
}

static int runFileMode(const std::string& inputFile, const std::string& outputFile)
{
    std::ifstream f(inputFile);
    if (!f.is_open()) { std::cerr << "Cannot open: " << inputFile << "\n"; return 1; }
    json data = json::parse(f);

    std::vector<Slice> slices; int idC = 0;
    if (data.is_array()) {
        for (auto& obj : data) {
            if (!obj.contains("FlattenedVertices")) continue;
            Slice s;
            s.id        = idC++;
            s.type      = obj.value("Type",      "Wall");
            s.viaName   = obj.value("ViaName",   "Unknown");
            s.blockName = obj.value("BlockName", "Default");
            s.layer     = obj.value("Layer",     "Default");
            std::hash<std::string> hasher;
            size_t h = hasher(s.viaName + "_" + s.layer);
            s.color[0] = ((h&0xFF)     /255.0)*0.6+0.4;
            s.color[1] = (((h>>8)&0xFF)/255.0)*0.6+0.4;
            s.color[2] = (((h>>16)&0xFF)/255.0)*0.6+0.4;
            for (auto& pt : obj["FlattenedVertices"])
                s.vertices.push_back({pt[0].get<double>(), pt[1].get<double>(), pt[2].get<double>()});
            if (s.vertices.size() > 1) slices.push_back(s);
        }
    }

    std::map<std::string,std::vector<Slice>> viaGroups;
    for (const auto& s : slices) viaGroups[s.viaName+"_"+s.blockName].push_back(s);

    std::vector<std::array<double,3>> gVerts, gColors;
    std::vector<int> gIdx;

    for (auto& [key, vs] : viaGroups) {
        std::cout << "\n=== Group: " << key << " (" << vs.size() << " entities) ===" << std::endl;
        std::vector<Slice> roofSl, floorSl;
        for (auto& s : vs) {
            if (s.type.find("V")!=std::string::npos || s.type=="Roof" || s.layer.find("CR")!=std::string::npos)
                roofSl.push_back(s);
            else
                floorSl.push_back(s);
        }
        std::cout << "  Roof: " << roofSl.size() << "  Floor: " << floorSl.size() << std::endl;
        StitchFragments(roofSl); StitchFragments(floorSl);
        for (auto& s : roofSl)  { s.centroid=GetCentroid(s.vertices); s.perimeter=GetPerimeter(s.vertices); }
        for (auto& s : floorSl) { s.centroid=GetCentroid(s.vertices); s.perimeter=GetPerimeter(s.vertices); }

        std::vector<std::array<double,3>> topLoop, botLoop;
        if (!roofSl.empty())  { std::cout << "Reconstructing Roof..."  << std::endl; ReconstructSurfaceWithCGAL(roofSl,  gVerts,gColors,gIdx,&topLoop); }
        if (!floorSl.empty()) { std::cout << "Reconstructing Floor..." << std::endl; ReconstructSurfaceWithCGAL(floorSl, gVerts,gColors,gIdx,&botLoop); }
        if (!topLoop.empty() && !botLoop.empty()) {
            auto sc = roofSl.empty() ? (floorSl.empty() ? std::array<double,3>{0.5,0.5,0.5} : floorSl[0].color) : roofSl[0].color;
            StitchBoundaryLoops(topLoop, botLoop, sc, gVerts, gColors, gIdx);
        }
        std::cout << "  Group done: " << gVerts.size() << " verts  " << gIdx.size()/3 << " tris" << std::endl;
    }

    std::cout << "\n=== FINAL: " << gVerts.size() << " vertices  " << gIdx.size()/3 << " triangles ===" << std::endl;
    WriteObj(outputFile, gVerts, gColors, gIdx);
    std::cout << "Written to " << outputFile << std::endl;
    return 0;
}

// ---- main ----

int main(int argc, char* argv[])
{
    if (argc >= 3) return runFileMode(argv[1], argv[2]);

    std::ios::sync_with_stdio(false);

    std::vector<Polyline> contours;
    std::vector<Polyline> boundaries;
    double slope_threshold = 5.0;

    std::string tok;
    while (std::cin >> tok) {
        if (tok == "POLYLINES" || tok == "BOUNDARIES") {
            int n; std::cin >> n;
            (void)n;  // informational only
        } else if (tok == "POLY" || tok == "BPOLY") {
            int k; std::cin >> k;
            Polyline poly;
            poly.reserve(static_cast<std::size_t>(std::max(0, k)));
            for (int i = 0; i < k; ++i) {
                double x, y, z; std::cin >> x >> y >> z;
                poly.push_back({ x, y, z });
            }
            if (tok == "POLY")  contours.push_back(std::move(poly));
            else                boundaries.push_back(std::move(poly));
        } else if (tok == "SLOPE") {
            std::cin >> slope_threshold;
        } else {
            std::cerr << "[mesh_gen] Unknown token: '" << tok << "'\n";
            return 2;
        }
    }

    // Assign each contour to the first boundary whose polygon contains it.
    // Contour lines in CAD data are clipped to the boundary, so their first and
    // last vertices land exactly ON the boundary edge — point-in-polygon is
    // unreliable for those.  Instead probe a few interior vertices (1/4, 1/2,
    // 3/4 positions); at least one of those is guaranteed to be clearly inside.
    auto contour_probe_inside = [&](const Polyline& c, std::size_t b) -> bool {
        if (c.empty()) return false;
        const std::size_t n = c.size();
        // Always try a handful of evenly-spaced interior indices.
        for (std::size_t frac : { 2u, 4u, 3u, 5u, 8u }) {
            std::size_t idx = (n > frac) ? (n / frac) : 0;
            if (point_in_polygon_xy(c[idx][0], c[idx][1], boundaries[b]))
                return true;
        }
        return false;
    };

    std::vector<std::vector<const Polyline*>> per_boundary(boundaries.size());
    int orphans = 0;
    for (const auto& c : contours) {
        if (c.empty()) continue;
        int hit = -1;
        for (std::size_t b = 0; b < boundaries.size(); ++b)
            if (contour_probe_inside(c, b)) { hit = static_cast<int>(b); break; }
        if (hit >= 0) per_boundary[hit].push_back(&c);
        else ++orphans;
    }
    if (orphans > 0)
        std::cerr << "[mesh_gen] " << orphans << " orphan contour(s) dropped.\n";

    std::size_t total_verts = 0;
    for (const auto& c : contours)   total_verts += c.size();
    for (const auto& b : boundaries) total_verts += b.size();

    std::vector<MeshOut> meshes;
    meshes.reserve(boundaries.size());
    for (std::size_t b = 0; b < boundaries.size(); ++b)
        meshes.push_back(mesh_boundary(boundaries[b], per_boundary[b], slope_threshold));

    // Emit JSON.
    std::ostringstream out;
    out.precision(10);
    out << "{\"ok\":true"
        << ",\"num_contours\":"        << contours.size()
        << ",\"num_boundaries\":"      << boundaries.size()
        << ",\"num_orphan_contours\":" << orphans
        << ",\"num_input_vertices\":"  << total_verts
        << ",\"num_meshes\":"          << meshes.size()
        << ",\"meshes\":[";

    for (std::size_t i = 0; i < meshes.size(); ++i) {
        if (i) out << ",";
        const auto& m = meshes[i];
        out << "{"
            << "\"num_contours\":"    << m.num_contours
            << ",\"dropped_slope\":"  << m.dropped_slope
            << ",\"slope_used\":"     << m.slope_used
            << ",\"num_vertices\":"   << m.vertices.size()
            << ",\"num_triangles\":"  << m.triangles.size()
            << ",\"vertices\":[";
        for (std::size_t k = 0; k < m.vertices.size(); ++k) {
            if (k) out << ",";
            out << "[" << m.vertices[k][0]
                << "," << m.vertices[k][1]
                << "," << m.vertices[k][2] << "]";
        }
        out << "],\"triangles\":[";
        for (std::size_t k = 0; k < m.triangles.size(); ++k) {
            if (k) out << ",";
            out << "[" << m.triangles[k][0]
                << "," << m.triangles[k][1]
                << "," << m.triangles[k][2] << "]";
        }
        out << "]}";
    }
    out << "]}";

    std::cout << out.str() << std::endl;
    return 0;
}
