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

#include <algorithm>
#include <array>
#include <cmath>
#include <iostream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

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

// ---- main ----

int main()
{
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
