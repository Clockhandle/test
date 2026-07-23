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
//   BREAKLINES <B>    number of BRLINE blocks
//   SCATTER <S>       number of PT tokens
//   BRLINE <K>        breakline polyline: K vertices as "x y z" (interior constraint;
//                     triangles adjacent to this edge are exempt from slope filter)
//   PT <x> <y> <z>    scatter free vertex (no constraint edges; improves surface detail)
//   CLIPPLANE <a> <b> <c> <d>  clip plane (ax+by+cz+d=0); used only with --mode=clip.
//                     The side where ax+by+cz+d > 0 is removed.
//
// Command-line flags:
//   --mode=mesh      (default) CDT triangulation only.
//   --mode=clip      CDT then PMP::clip — keeps the negative-side half (ax+by+cz+d ≤ 0).
//   --mode=split     CDT then two PMP::clip passes — outputs BOTH halves as separate meshes.
//   --mode=clip_mesh  skip CDT; clip a raw vertex+triangle mesh (NUMVERTS/NUMTRIS tokens).
//   --mode=slice     CDT then CGAL::Polygon_mesh_slicer sweep.
//                    Emits polyline JSON (not a mesh). Requires SLICEAXIS + SLICESTEP.
//   SLICEAXIS <nx> <ny> <nz>  slice-plane normal (e.g. 0 0 1 = horizontal).
//   SLICESTEP <d>             spacing between consecutive slice planes.

#include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
#include <CGAL/Constrained_Delaunay_triangulation_2.h>
#include <CGAL/Triangulation_vertex_base_with_info_2.h>
#include <CGAL/Constrained_triangulation_face_base_2.h>
#include <CGAL/Triangulation_data_structure_2.h>
#include <CGAL/Surface_mesh.h>
#include <CGAL/Polygon_mesh_processing/clip.h>
#include <CGAL/Polygon_mesh_processing/corefinement.h>
#include <CGAL/Polygon_mesh_processing/connected_components.h>
#include <CGAL/Polygon_mesh_slicer.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <iostream>
#include <limits>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
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
using SMesh    = CGAL::Surface_mesh<K::Point_3>;
namespace PMP  = CGAL::Polygon_mesh_processing;

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
    int    num_holes     = 0;
    int    dropped_slope = 0;
    int    dropped_hole  = 0;
    double slope_used    = 0.0;
};

static MeshOut mesh_boundary(const Polyline&                          boundary,
                              const std::vector<const Polyline*>&      contours,
                              const std::vector<const Polyline*>&      holes,
                              const std::vector<const Polyline*>&      breaklines,
                              const std::vector<std::array<double,3>>& scatter,
                              double                                   slope_threshold)
{
    MeshOut out;
    out.num_contours = static_cast<int>(contours.size());
    out.num_holes    = static_cast<int>(holes.size());
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

    // --- hole polygons as constrained closed loops ---
    // Each hole boundary is inserted as a constraint ring so the CDT respects
    // the hole edge exactly; triangles inside are removed in the filter below.
    for (const Polyline* hp : holes) {
        const Polyline& h = *hp;
        if (h.size() < 3) continue;
        std::vector<VH> hvh(h.size());
        for (std::size_t i = 0; i < h.size(); ++i)
            hvh[i] = ins(h[i][0], h[i][1], h[i][2]);
        for (std::size_t i = 0; i < h.size(); ++i) {
            VH a = hvh[i], b = hvh[(i + 1) % h.size()];
            if (a != b) cdt.insert_constraint(a, b);
        }
    }

    // --- breakline polylines (interior constraints, slope-filter exempt) ---
    using VHPair = std::pair<VH, VH>;
    auto make_vhpair = [](VH a, VH b) -> VHPair {
        return (a < b) ? VHPair{a, b} : VHPair{b, a};
    };
    struct VHPairHash {
        std::size_t operator()(const VHPair& p) const noexcept {
            std::size_t h1 = std::hash<const void*>()(static_cast<const void*>(&*p.first));
            std::size_t h2 = std::hash<const void*>()(static_cast<const void*>(&*p.second));
            return h1 ^ (h2 * 2654435761u);
        }
    };
    std::unordered_set<VHPair, VHPairHash> breakline_edges;
    for (const Polyline* bp : breaklines) {
        const Polyline& bl = *bp;
        if (bl.size() < 2) continue;
        std::vector<VH> bvh(bl.size());
        for (std::size_t i = 0; i < bl.size(); ++i)
            bvh[i] = ins(bl[i][0], bl[i][1], bl[i][2]);
        for (std::size_t i = 0; i + 1 < bl.size(); ++i) {
            if (bvh[i] != bvh[i + 1]) {
                cdt.insert_constraint(bvh[i], bvh[i + 1]);
                breakline_edges.insert(make_vhpair(bvh[i], bvh[i + 1]));
            }
        }
    }

    // --- scatter free vertices (no constraint edges) ---
    for (const auto& pt : scatter)
        ins(pt[0], pt[1], pt[2]);

    // Build vertex-handle -> output-index map on demand.
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

        // Hole exclusion — drop triangles whose centroid falls inside any hole.
        bool in_hole = false;
        for (const Polyline* hp : holes) {
            if (point_in_polygon_xy(cx, cy, *hp)) { in_hole = true; break; }
        }
        if (in_hole) { ++out.dropped_hole; continue; }

        // Slope filter — drop spike triangles (breakline-adjacent triangles exempt).
        if (slope_threshold > 0.0) {
            bool exempt = !breakline_edges.empty() &&
                          (breakline_edges.count(make_vhpair(v0, v1)) ||
                           breakline_edges.count(make_vhpair(v1, v2)) ||
                           breakline_edges.count(make_vhpair(v2, v0)));
            if (!exempt) {
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
        }

        out.triangles.push_back({ get_idx(v0), get_idx(v1), get_idx(v2) });
    }
    return out;
}

// ---- clip a MeshOut in-place using CGAL PMP::clip ----
// Keeps the half-space where plane(v) <= 0  (ax+by+cz+d <= 0).
// close_volume=true seals the cut boundary with a planar cap (needed for walls).
// On failure (exception or empty result) the MeshOut is left unchanged.
static void clip_meshout(MeshOut& m, const K::Plane_3& plane, bool close_volume = false)
{
    if (m.vertices.empty() || m.triangles.empty()) return;

    SMesh sm;

    // Populate vertices.
    for (const auto& v : m.vertices)
        sm.add_vertex(K::Point_3(v[0], v[1], v[2]));

    // Populate triangular faces.
    for (const auto& t : m.triangles) {
        SMesh::Vertex_index v0(t[0]), v1(t[1]), v2(t[2]);
        if (sm.add_face(v0, v1, v2) == SMesh::null_face())
            std::cerr << "[clip] degenerate/non-manifold face skipped\n";
    }

    try {
        // clip_volume controls whether the cut boundary is sealed with a planar cap.
        // false = open surface (terrain); true = seal the cut (walls/solids).
        PMP::clip(sm, plane, PMP::parameters::clip_volume(close_volume));
    } catch (const std::exception& e) {
        std::cerr << "[clip] PMP::clip threw: " << e.what() << " — mesh unchanged\n";
        return;
    }

    sm.collect_garbage(); // compact lazy-deleted vertices/faces

    // Extract clipped geometry back into MeshOut.
    m.vertices.clear();
    m.triangles.clear();

    std::unordered_map<std::size_t, int> vmap;
    vmap.reserve(sm.num_vertices());
    for (auto v : sm.vertices()) {
        vmap[v.idx()] = static_cast<int>(m.vertices.size());
        const auto& p = sm.point(v);
        m.vertices.push_back({ p.x(), p.y(), p.z() });
    }
    for (auto f : sm.faces()) {
        auto h  = sm.halfedge(f);
        int  i0 = vmap.at(CGAL::target(h,             sm).idx());
        int  i1 = vmap.at(CGAL::target(sm.next(h),    sm).idx());
        int  i2 = vmap.at(CGAL::target(sm.next(sm.next(h)), sm).idx());
        m.triangles.push_back({ i0, i1, i2 });
    }
}

// ---- main ----

int main(int argc, char** argv)
{
    std::ios::sync_with_stdio(false);

    // Parse --mode=<value> from command-line arguments.
    std::string mode = "mesh";
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg.rfind("--mode=", 0) == 0)
            mode = arg.substr(7);
    }

    std::vector<Polyline>               contours;
    std::vector<Polyline>               boundaries;
    std::vector<Polyline>               holes;
    std::vector<Polyline>               breaklines;
    std::vector<Polyline>               fault_polylines; // cutting tools only — never CDT constraints
    std::vector<std::array<double, 3>>  scatter;
    double slope_threshold = 15.0;
    double clip_a = 0, clip_b = 0, clip_c = 0, clip_d = 0;
    bool   clip_plane_set = false;

    // Raw mesh input (for --mode=clip_mesh / split_mesh).
    std::vector<std::array<double, 3>> raw_vertices;
    std::vector<std::array<int,    3>> raw_triangles;

    // Slice parameters (for --mode=slice).
    double slice_nx = 0.0, slice_ny = 0.0, slice_nz = 1.0; // default: horizontal (+Z)
    double slice_step = 5.0;

    std::string tok;
    while (std::cin >> tok) {
        if (tok == "POLYLINES" || tok == "BOUNDARIES" || tok == "HOLES") {
            int n; std::cin >> n;
            (void)n;  // informational only
        } else if (tok == "POLY" || tok == "BPOLY" || tok == "HOLE") {
            int k; std::cin >> k;
            Polyline poly;
            poly.reserve(static_cast<std::size_t>(std::max(0, k)));
            for (int i = 0; i < k; ++i) {
                double x, y, z; std::cin >> x >> y >> z;
                poly.push_back({ x, y, z });
            }
            if (tok == "POLY")  contours.push_back(std::move(poly));
            else if (tok == "BPOLY") boundaries.push_back(std::move(poly));
            else                holes.push_back(std::move(poly));
        } else if (tok == "SLOPE") {
            std::cin >> slope_threshold;
        } else if (tok == "BREAKLINES" || tok == "SCATTER") {
            int n; std::cin >> n;
            (void)n;
        } else if (tok == "FAULTLINES") {
            int n; std::cin >> n;
            (void)n;
        } else if (tok == "BRLINE") {
            int k; std::cin >> k;
            Polyline poly;
            poly.reserve(static_cast<std::size_t>(std::max(0, k)));
            for (int i = 0; i < k; ++i) {
                double x, y, z; std::cin >> x >> y >> z;
                poly.push_back({ x, y, z });
            }
            breaklines.push_back(std::move(poly));
        } else if (tok == "FAULTLINE") {
            int k; std::cin >> k;
            Polyline poly;
            poly.reserve(static_cast<std::size_t>(std::max(0, k)));
            for (int i = 0; i < k; ++i) {
                double x, y, z; std::cin >> x >> y >> z;
                poly.push_back({ x, y, z });
            }
            fault_polylines.push_back(std::move(poly));
        } else if (tok == "PT") {
            double x, y, z; std::cin >> x >> y >> z;
            scatter.push_back({ x, y, z });
        } else if (tok == "CLIPPLANE") {
            std::cin >> clip_a >> clip_b >> clip_c >> clip_d;
            clip_plane_set = true;
        } else if (tok == "NUMVERTS") {
            int n; std::cin >> n;
            raw_vertices.reserve(raw_vertices.size() + static_cast<std::size_t>(std::max(0, n)));
            for (int i = 0; i < n; ++i) {
                double x, y, z; std::cin >> x >> y >> z;
                raw_vertices.push_back({ x, y, z });
            }
        } else if (tok == "NUMTRIS") {
            int n; std::cin >> n;
            raw_triangles.reserve(raw_triangles.size() + static_cast<std::size_t>(std::max(0, n)));
            for (int i = 0; i < n; ++i) {
                int i0, i1, i2; std::cin >> i0 >> i1 >> i2;
                raw_triangles.push_back({ i0, i1, i2 });
            }
        } else if (tok == "SLICEAXIS") {
            std::cin >> slice_nx >> slice_ny >> slice_nz;
        } else if (tok == "SLICESTEP") {
            std::cin >> slice_step;
        } else {
            std::cerr << "[mesh_gen] Unknown token: '" << tok << "'\n";
            return 2;
        }
    }

    // ---- Raw mesh clip (--mode=clip_mesh) ----
    // Skips the CDT pipeline entirely: takes pre-built vertices + triangles,
    // clips them, and emits JSON. Used for wall meshes during Cut Shape.
    if (mode == "clip_mesh") {
        if (!clip_plane_set) {
            std::cerr << "[mesh_gen] clip_mesh requires CLIPPLANE\n"; return 2;
        }
        if (raw_vertices.empty() || raw_triangles.empty()) {
            std::cerr << "[mesh_gen] clip_mesh requires NUMVERTS + NUMTRIS\n"; return 2;
        }

        MeshOut base;
        base.vertices  = raw_vertices;
        base.triangles = raw_triangles;

        const K::Plane_3 plane(clip_a, clip_b, clip_c, clip_d);
        clip_meshout(base, plane, /*close_volume=*/false);
        std::cerr << "[mesh_gen] clip_mesh: " << base.triangles.size() << " tris after clip\n";

        std::ostringstream jout;
        jout.precision(10);
        jout << "{\"ok\":true,\"action_mode\":\"clip_mesh\""
             << ",\"num_meshes\":1"
             << ",\"num_contours\":0,\"num_boundaries\":0"
             << ",\"num_orphan_contours\":0,\"num_input_vertices\":" << raw_vertices.size()
             << ",\"num_warnings\":0,\"warnings\":[]"
             << ",\"meshes\":[{\"num_contours\":0,\"num_holes\":0"
             << ",\"dropped_slope\":0,\"dropped_hole\":0,\"slope_used\":0"
             << ",\"num_vertices\":"  << base.vertices.size()
             << ",\"num_triangles\":" << base.triangles.size()
             << ",\"vertices\":[";
        for (std::size_t k = 0; k < base.vertices.size(); ++k) {
            if (k) jout << ",";
            jout << "[" << base.vertices[k][0] << "," << base.vertices[k][1] << "," << base.vertices[k][2] << "]";
        }
        jout << "],\"triangles\":[";
        for (std::size_t k = 0; k < base.triangles.size(); ++k) {
            if (k) jout << ",";
            jout << "[" << base.triangles[k][0] << "," << base.triangles[k][1] << "," << base.triangles[k][2] << "]";
        }
        jout << "]}]}";
        std::cout << jout.str() << std::endl;
        return 0;
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

    // Store contour indices per boundary so we can trace bad lines back to the source.
    std::vector<std::vector<int>> per_boundary_idx(boundaries.size());
    std::vector<int> orphan_indices;
    for (int ci = 0; ci < static_cast<int>(contours.size()); ++ci) {
        const auto& c = contours[ci];
        if (c.empty()) continue;
        int hit = -1;
        for (std::size_t b = 0; b < boundaries.size(); ++b)
            if (contour_probe_inside(c, b)) { hit = static_cast<int>(b); break; }
        if (hit >= 0) per_boundary_idx[hit].push_back(ci);
        else orphan_indices.push_back(ci);
    }
    int orphans = static_cast<int>(orphan_indices.size());
    if (orphans > 0)
        std::cerr << "[mesh_gen] " << orphans << " orphan contour(s) dropped.\n";

    std::size_t total_verts = 0;
    for (const auto& c : contours)    total_verts += c.size();
    for (const auto& b : boundaries)  total_verts += b.size();
    for (const auto& h : holes)       total_verts += h.size();
    for (const auto& bl : breaklines) total_verts += bl.size();
    total_verts += scatter.size();

    // Assign each hole to the boundary whose polygon contains it.
    // Uses the same probe-inside logic as contours.
    std::vector<std::vector<int>> per_boundary_holes(boundaries.size());
    for (int hi = 0; hi < static_cast<int>(holes.size()); ++hi) {
        const auto& h = holes[hi];
        if (h.empty()) continue;
        int matched = -1;
        for (std::size_t b = 0; b < boundaries.size(); ++b) {
            if (contour_probe_inside(h, b)) { matched = static_cast<int>(b); break; }
        }
        if (matched >= 0) per_boundary_holes[matched].push_back(hi);
        else std::cerr << "[mesh_gen] hole " << hi << " did not match any boundary (orphan hole).\n";
    }
    std::cerr << "[mesh_gen] " << holes.size() << " hole(s) read, "
              << boundaries.size() << " boundary(s).\n";
    for (std::size_t b = 0; b < boundaries.size(); ++b)
        if (!per_boundary_holes[b].empty())
            std::cerr << "[mesh_gen]   boundary " << b << " -> "
                      << per_boundary_holes[b].size() << " hole(s)\n";

    // Assign each breakline to the boundary whose polygon contains it.
    std::vector<std::vector<int>> per_boundary_bl(boundaries.size());
    for (int bli = 0; bli < static_cast<int>(breaklines.size()); ++bli) {
        const auto& bl = breaklines[bli];
        if (bl.empty()) continue;
        int hit = -1;
        for (std::size_t b = 0; b < boundaries.size(); ++b)
            if (contour_probe_inside(bl, b)) { hit = static_cast<int>(b); break; }
        if (hit >= 0) per_boundary_bl[hit].push_back(bli);
        else std::cerr << "[mesh_gen] breakline " << bli << " did not match any boundary (orphan).\n";
    }

    // Assign each scatter point to the boundary whose polygon contains it.
    std::vector<std::vector<int>> per_boundary_sc(boundaries.size());
    for (int sci = 0; sci < static_cast<int>(scatter.size()); ++sci) {
        const auto& pt = scatter[sci];
        int hit = -1;
        for (std::size_t b = 0; b < boundaries.size(); ++b)
            if (point_in_polygon_xy(pt[0], pt[1], boundaries[b])) { hit = static_cast<int>(b); break; }
        if (hit >= 0) per_boundary_sc[hit].push_back(sci);
    }

    // Build per-mesh pointer lists and run meshing.
    std::vector<MeshOut> meshes;
    meshes.reserve(boundaries.size());
    for (std::size_t b = 0; b < boundaries.size(); ++b) {
        std::vector<const Polyline*> ptrs;
        ptrs.reserve(per_boundary_idx[b].size());
        for (int ci : per_boundary_idx[b]) ptrs.push_back(&contours[ci]);
        std::vector<const Polyline*> hptrs;
        hptrs.reserve(per_boundary_holes[b].size());
        for (int hi : per_boundary_holes[b]) hptrs.push_back(&holes[hi]);
        std::vector<const Polyline*> blptrs;
        blptrs.reserve(per_boundary_bl[b].size());
        for (int bli : per_boundary_bl[b]) blptrs.push_back(&breaklines[bli]);
        std::vector<std::array<double, 3>> scpts;
        scpts.reserve(per_boundary_sc[b].size());
        for (int sci : per_boundary_sc[b]) scpts.push_back(scatter[sci]);
        meshes.push_back(mesh_boundary(boundaries[b], ptrs, hptrs, blptrs, scpts, slope_threshold));
        std::cerr << "[mesh_gen] boundary " << b << ": "
                  << ptrs.size() << " contours, "
                  << hptrs.size() << " holes, "
                  << blptrs.size() << " breaklines, "
                  << scpts.size() << " scatter pts, "
                  << "dropped_hole=" << meshes.back().dropped_hole << "\n";
    }

    // ---- Clip pass (--mode=clip) ----
    if (mode == "clip" && clip_plane_set) {
        const K::Plane_3 plane(clip_a, clip_b, clip_c, clip_d);
        int clipped = 0;
        for (auto& m : meshes) { clip_meshout(m, plane); ++clipped; }
        std::cerr << "[mesh_gen] clip pass: " << clipped << " mesh(es) clipped by plane ("
                  << clip_a << " " << clip_b << " " << clip_c << " " << clip_d << ")\n";
    }

    // ---- Split pass (--mode=split) ----
    // Each boundary mesh becomes two entries: negative-side half then positive-side half.
    if (mode == "split" && clip_plane_set) {
        const K::Plane_3 plane(clip_a, clip_b, clip_c, clip_d);
        const K::Plane_3 opp   = plane.opposite();
        std::vector<MeshOut> halves;
        halves.reserve(meshes.size() * 2);
        for (const auto& m : meshes) {
            MeshOut neg = m; clip_meshout(neg, plane);  // keeps ax+by+cz+d <= 0
            MeshOut pos = m; clip_meshout(pos, opp);    // keeps ax+by+cz+d >= 0
            halves.push_back(std::move(neg));
            halves.push_back(std::move(pos));
        }
        std::cerr << "[mesh_gen] split pass: " << meshes.size() << " mesh(es) → "
                  << halves.size() << " halves\n";
        meshes = std::move(halves);
    }

    // ---- Polyline split (--mode=polyline_split) ----
    // Splits the combined CDT terrain along a fault/breakline polyline.
    // Each BRLINE is extruded into a tall vertical curtain wall; PMP::corefine
    // inserts intersection edges into the terrain, then connected_components
    // separates the two halves.
    if (mode == "polyline_split") {
        if (breaklines.empty() && fault_polylines.empty()) {
            std::cerr << "[mesh_gen] polyline_split: no BRLINE/FAULTLINE data supplied\n";
            return 2;
        }

        // Prefer fault_polylines (cutting tools only, no CDT contamination);
        // fall back to breaklines if no FAULTLINE tokens were sent.
        const std::vector<Polyline>& cutting_lines =
            !fault_polylines.empty() ? fault_polylines : breaklines;

        // Build combined terrain SMesh.
        SMesh sm;
        double zmin =  std::numeric_limits<double>::infinity();
        double zmax = -std::numeric_limits<double>::infinity();
        for (const auto& m : meshes) {
            if (m.vertices.empty()) continue;
            const std::size_t vbase = sm.number_of_vertices();
            for (const auto& v : m.vertices) {
                sm.add_vertex(K::Point_3(v[0], v[1], v[2]));
                if (v[2] < zmin) zmin = v[2];
                if (v[2] > zmax) zmax = v[2];
            }
            for (const auto& t : m.triangles)
                sm.add_face(SMesh::Vertex_index(vbase + t[0]),
                            SMesh::Vertex_index(vbase + t[1]),
                            SMesh::Vertex_index(vbase + t[2]));
        }
        if (sm.is_empty()) {
            std::cerr << "[mesh_gen] polyline_split: no mesh geometry after CDT\n";
            return 2;
        }

        const double zmargin = (zmax - zmin) * 0.5 + 1.0;
        const double z_bot   = zmin - zmargin;
        const double z_top   = zmax + zmargin;

        // For each breakline, build a tall vertical curtain wall and corefine.
        for (const auto& bl : cutting_lines) {
            const int N = static_cast<int>(bl.size());
            if (N < 2) continue;

            // Detect a closed loop: JS appends a copy of the first vertex at the
            // end for IsClosed fault lines.  If the last vertex ≈ the first, build
            // the cylinder using N-1 unique points + a wrap-around closing quad so
            // the wall is a proper manifold surface.  Using N separate vertices at
            // the seam creates two coincident-but-distinct edges that make the wall
            // non-manifold and break PMP::split's inner/outer separation.
            const bool closed_loop =
                N >= 4 &&
                std::abs(bl[0][0] - bl[N-1][0]) < 1e-6 &&
                std::abs(bl[0][1] - bl[N-1][1]) < 1e-6;
            const int wall_pts = closed_loop ? N - 1 : N;

            SMesh wall;
            std::vector<SMesh::Vertex_index> wbot, wtop;
            wbot.reserve(wall_pts);  wtop.reserve(wall_pts);
            for (int i = 0; i < wall_pts; ++i) {
                wbot.push_back(wall.add_vertex(K::Point_3(bl[i][0], bl[i][1], z_bot)));
                wtop.push_back(wall.add_vertex(K::Point_3(bl[i][0], bl[i][1], z_top)));
            }
            for (int i = 0; i < wall_pts - 1; ++i) {
                wall.add_face(wbot[i], wbot[i+1], wtop[i]);
                wall.add_face(wbot[i+1], wtop[i+1], wtop[i]);
            }
            // Wrap-around closing quad for closed loops — reuses wbot[0]/wtop[0].
            if (closed_loop) {
                wall.add_face(wbot[wall_pts-1], wbot[0], wtop[wall_pts-1]);
                wall.add_face(wbot[0],          wtop[0], wtop[wall_pts-1]);
            }

            std::cerr << "[mesh_gen] polyline_split: splitting with wall ("
                      << wall_pts << " pts, "
                      << (closed_loop ? "closed" : "open") << ")\n";
            try {
                PMP::split(sm, wall);
            } catch (const std::exception& e) {
                std::cerr << "[mesh_gen] polyline_split: split threw: " << e.what() << "\n";
                return 2;
            }
        }

        // Separate into connected components.
        auto comp_id = sm.add_property_map<SMesh::Face_index, std::size_t>("f:comp", 0).first;
        const std::size_t ncomp = PMP::connected_components(sm, comp_id);
        std::cerr << "[mesh_gen] polyline_split: " << ncomp << " component(s)\n";

        // Extract each component.
        std::vector<MeshOut> split_meshes(ncomp);
        for (std::size_t c = 0; c < ncomp; ++c) {
            MeshOut& out = split_meshes[c];
            std::unordered_map<std::size_t, int> vmap;
            for (auto f : sm.faces()) {
                if (comp_id[f] != c) continue;
                auto h = sm.halfedge(f);
                std::array<int,3> tri;
                for (int vi = 0; vi < 3; ++vi) {
                    auto v = CGAL::target(h, sm);
                    auto it = vmap.find(v.idx());
                    if (it == vmap.end()) {
                        const auto& p = sm.point(v);
                        int idx = static_cast<int>(out.vertices.size());
                        out.vertices.push_back({ p.x(), p.y(), p.z() });
                        vmap[v.idx()] = idx;
                        tri[vi] = idx;
                    } else {
                        tri[vi] = it->second;
                    }
                    h = sm.next(h);
                }
                out.triangles.push_back(tri);
            }
        }
        split_meshes.erase(
            std::remove_if(split_meshes.begin(), split_meshes.end(),
                           [](const MeshOut& m){ return m.triangles.empty(); }),
            split_meshes.end());

        // ── Debug summary ─────────────────────────────────────────────────────
        std::cerr << "[mesh_gen] polyline_split: " << split_meshes.size()
                  << " non-empty component(s) extracted\n";
        for (std::size_t mi = 0; mi < split_meshes.size(); ++mi) {
            const auto& m = split_meshes[mi];
            double x0 =  std::numeric_limits<double>::infinity(), x1 = -x0;
            double y0 =  std::numeric_limits<double>::infinity(), y1 = -y0;
            double z0 =  std::numeric_limits<double>::infinity(), z1 = -z0;
            for (const auto& v : m.vertices) {
                if (v[0] < x0) x0 = v[0]; if (v[0] > x1) x1 = v[0];
                if (v[1] < y0) y0 = v[1]; if (v[1] > y1) y1 = v[1];
                if (v[2] < z0) z0 = v[2]; if (v[2] > z1) z1 = v[2];
            }
            double cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5;
            std::cerr << "  component " << mi
                      << ": " << m.vertices.size() << " verts"
                      << ", " << m.triangles.size() << " tris"
                      << "  bbox X[" << x0 << "," << x1 << "]"
                      <<       " Y[" << y0 << "," << y1 << "]"
                      <<       " Z[" << z0 << "," << z1 << "]"
                      << "  centroid XY(" << cx << "," << cy << ")\n";
        }
        // ──────────────────────────────────────────────────────────────────────

        // Emit JSON.
        std::ostringstream jout;
        jout.precision(10);
        jout << "{\"ok\":true,\"action_mode\":\"polyline_split\""
             << ",\"num_meshes\":" << split_meshes.size()
             << ",\"num_contours\":0,\"num_boundaries\":0"
             << ",\"num_orphan_contours\":0,\"num_input_vertices\":0"
             << ",\"num_warnings\":0,\"warnings\":[]"
             << ",\"meshes\":[";
        for (std::size_t mi = 0; mi < split_meshes.size(); ++mi) {
            if (mi) jout << ",";
            const auto& m = split_meshes[mi];
            jout << "{\"num_contours\":0,\"num_holes\":0"
                 << ",\"dropped_slope\":0,\"dropped_hole\":0,\"slope_used\":0"
                 << ",\"num_vertices\":"  << m.vertices.size()
                 << ",\"num_triangles\":" << m.triangles.size()
                 << ",\"vertices\":[";
            for (std::size_t k = 0; k < m.vertices.size(); ++k) {
                if (k) jout << ",";
                jout << "[" << m.vertices[k][0] << "," << m.vertices[k][1]
                     << "," << m.vertices[k][2] << "]";
            }
            jout << "],\"triangles\":[";
            for (std::size_t k = 0; k < m.triangles.size(); ++k) {
                if (k) jout << ",";
                jout << "[" << m.triangles[k][0] << ","
                     << m.triangles[k][1] << "," << m.triangles[k][2] << "]";
            }
            jout << "]}";
        }
        jout << "]}";
        std::cout << jout.str() << std::endl;
        return 0;
    }

    // ---- Slice sweep (--mode=slice) ----
    // Builds a combined Surface_mesh from all CDT boundary meshes, preprocesses it
    // with CGAL::Polygon_mesh_slicer once, then sweeps parallel planes from min to max elevation.
    if (mode == "slice") {
        if (slice_step <= 0.0) {
            std::cerr << "[mesh_gen] SLICESTEP must be > 0\n"; return 2;
        }
        // Normalise axis.
        double axlen = std::sqrt(slice_nx*slice_nx + slice_ny*slice_ny + slice_nz*slice_nz);
        if (axlen < 1e-12) { std::cerr << "[mesh_gen] SLICEAXIS is zero vector\n"; return 2; }
        slice_nx /= axlen; slice_ny /= axlen; slice_nz /= axlen;

        // Build combined Surface_mesh.
        SMesh sm;
        double dmin =  std::numeric_limits<double>::infinity();
        double dmax = -std::numeric_limits<double>::infinity();
        for (const auto& m : meshes) {
            if (m.vertices.empty()) continue;
            const std::size_t vbase = sm.number_of_vertices();
            for (const auto& v : m.vertices) {
                sm.add_vertex(K::Point_3(v[0], v[1], v[2]));
                double d = slice_nx*v[0] + slice_ny*v[1] + slice_nz*v[2];
                if (d < dmin) dmin = d;
                if (d > dmax) dmax = d;
            }
            for (const auto& t : m.triangles)
                sm.add_face(SMesh::Vertex_index(vbase + t[0]),
                            SMesh::Vertex_index(vbase + t[1]),
                            SMesh::Vertex_index(vbase + t[2]));
        }
        std::cerr << "[mesh_gen] slice: axis=(" << slice_nx << "," << slice_ny << "," << slice_nz
                  << ") step=" << slice_step << " range=[" << dmin << "," << dmax << "]\n";

        if (sm.is_empty()) {
            std::cerr << "[mesh_gen] slice: no mesh geometry after CDT\n"; return 2;
        }

        // Preprocess mesh once — Slicer builds an AABB tree internally.
        CGAL::Polygon_mesh_slicer<SMesh, K> slicer(sm);

        struct SliceOut {
            double level;
            std::vector<std::vector<std::array<double,3>>> polylines;
        };
        std::vector<SliceOut> slice_results;

        // Shift slice levels by a half-step so they never land on a survey vertex
        // exactly.  CGAL::Polygon_mesh_slicer has undefined behaviour when a mesh
        // vertex lies exactly on the cutting plane, which produces vertical spikes.
        const double half_step = slice_step * 0.5;
        double first = std::floor(dmin / slice_step) * slice_step + half_step;
        if (first < dmin) first += slice_step;
        for (double lv = first; lv <= dmax + 1e-9; lv += slice_step) {
            K::Plane_3 plane(slice_nx, slice_ny, slice_nz, -lv);
            std::vector<std::vector<K::Point_3>> raw_polys;
            slicer(plane, std::back_inserter(raw_polys));
            if (raw_polys.empty()) continue;
            SliceOut so;
            so.level = lv;
            for (const auto& poly : raw_polys) {
                if (poly.size() < 2) continue;
                std::vector<std::array<double,3>> pts;
                pts.reserve(poly.size());
                for (const auto& p : poly)
                    pts.push_back({ p.x(), p.y(), p.z() });
                so.polylines.push_back(std::move(pts));
            }
            if (!so.polylines.empty())
                slice_results.push_back(std::move(so));
        }
        std::cerr << "[mesh_gen] slice: " << slice_results.size() << " non-empty level(s)\n";

        // Emit JSON.
        std::ostringstream jout;
        jout.precision(4); jout << std::fixed;
        jout << "{\"ok\":true,\"action_mode\":\"slice\""
             << ",\"axis\":[" << slice_nx << "," << slice_ny << "," << slice_nz << "]"
             << ",\"step\":" << slice_step
             << ",\"num_slices\":" << slice_results.size()
             << ",\"slices\":[";
        for (std::size_t si = 0; si < slice_results.size(); ++si) {
            if (si) jout << ",";
            const auto& s = slice_results[si];
            jout << "{\"level\":" << s.level
                 << ",\"num_polylines\":" << s.polylines.size()
                 << ",\"polylines\":[";
            for (std::size_t pi = 0; pi < s.polylines.size(); ++pi) {
                if (pi) jout << ",";
                jout << "[";
                for (std::size_t vi = 0; vi < s.polylines[pi].size(); ++vi) {
                    if (vi) jout << ",";
                    jout << "[" << s.polylines[pi][vi][0]
                         << "," << s.polylines[pi][vi][1]
                         << "," << s.polylines[pi][vi][2] << "]";
                }
                jout << "]";
            }
            jout << "]}";
        }
        jout << "]}";
        std::cout << jout.str() << std::endl;
        return 0;
    }

    // ---- Diagnostic warnings ----
    // Collect (a) orphan contours and (b) contours whose vertices stray outside
    // their assigned boundary.  Both cause fins/spikes in the output mesh.
    struct ContourWarn {
        int    boundary_idx;   // -1 = orphan
        int    contour_idx;
        int    total_verts;
        int    outside_verts;  // 0 for orphans (all outside by definition)
        std::array<double, 3> first_vert;
        std::array<double, 3> last_vert;
    };
    std::vector<ContourWarn> warnings;

    for (int ci : orphan_indices) {
        const auto& c = contours[ci];
        warnings.push_back({ -1, ci, static_cast<int>(c.size()),
                             static_cast<int>(c.size()), c.front(), c.back() });
    }
    for (std::size_t b = 0; b < boundaries.size(); ++b) {
        for (int ci : per_boundary_idx[b]) {
            const auto& c = contours[ci];
            int outside = 0;
            for (const auto& v : c)
                if (!point_in_polygon_xy(v[0], v[1], boundaries[b])) ++outside;
            if (outside > 0)
                warnings.push_back({ static_cast<int>(b), ci, static_cast<int>(c.size()),
                                     outside, c.front(), c.back() });
        }
    }

    // Emit JSON.
    std::ostringstream out;
    out.precision(10);
    out << "{\"ok\":true"
        << ",\"action_mode\":\"" << mode << "\""
        << ",\"num_contours\":"        << contours.size()
        << ",\"num_boundaries\":"      << boundaries.size()
        << ",\"num_orphan_contours\":" << orphans
        << ",\"num_input_vertices\":"  << total_verts
        << ",\"num_meshes\":"           << meshes.size()
        << ",\"num_warnings\":"         << warnings.size()
        << ",\"warnings\":["; 
    for (std::size_t i = 0; i < warnings.size(); ++i) {
        if (i) out << ",";
        const auto& w = warnings[i];
        std::string msg = (w.boundary_idx < 0)
            ? ("Orphan: not inside any boundary (" + std::to_string(w.total_verts) + " verts)")
            : ("Leaks outside boundary " + std::to_string(w.boundary_idx) + ": " +
               std::to_string(w.outside_verts) + "/" + std::to_string(w.total_verts) + " verts outside");
        out << "{\"boundary_idx\":"  << w.boundary_idx
            << ",\"contour_idx\":"   << w.contour_idx
            << ",\"total_verts\":"   << w.total_verts
            << ",\"outside_verts\":" << w.outside_verts
            << ",\"first_vertex\":[" << w.first_vert[0] << "," << w.first_vert[1] << "," << w.first_vert[2] << "]"
            << ",\"last_vertex\":["
            << w.last_vert[0] << "," << w.last_vert[1] << "," << w.last_vert[2] << "]"
            << ",\"message\":\"" << msg << "\"}";
    }
    out << "],\"meshes\":[";

    for (std::size_t i = 0; i < meshes.size(); ++i) {
        if (i) out << ",";
        const auto& m = meshes[i];
        out << "{"
            << "\"num_contours\":"    << m.num_contours
            << ",\"num_holes\":"      << m.num_holes
            << ",\"dropped_slope\":"  << m.dropped_slope
            << ",\"dropped_hole\":"   << m.dropped_hole
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
