// CGAL-based contour mesh generator with EXPLICIT boundary-driven clustering.
//
// Each input MUST come with one or more closed boundary polylines (BPOLY).
// Each boundary defines one cluster. Contour polylines (POLY) are assigned
// to the boundary whose XY polygon contains their first vertex; orphans
// (contours not inside any boundary) are dropped with a warning.
//
// Pipeline per cluster:
//   1. Compute median segment length over (boundary + contours) in cluster.
//   2. Bridge densification: for each contour, find the bridge_neighbors
//      nearest sibling lines (contours + boundary) and insert linearly
//      interpolated points (XY + Z) along the gap, spaced ~bridge_step apart.
//   3. Build a CDT:
//        * boundary inserted as a CLOSED constraint loop
//        * contour vertices inserted as FREE points (no constraint edges)
//        * bridge points inserted as FREE points
//   4. mark_domains: flood from the infinite face, alternating in/out across
//      constrained edges. Only faces with in_domain() == true are kept, so
//      every output triangle is strictly inside the boundary polygon.
//   5. Optional alpha filter (drop triangles whose longest XY edge exceeds
//      alpha; default 6 * cluster median segment length) and slope filter
//      (drop if zrange/longest_xy > slope; default 5.0).
//
// Output JSON: one mesh per boundary.
//
// Input stream grammar (whitespace separated):
//   POLYLINES <N>                     // total of contour POLY blocks
//   BOUNDARIES <M>                    // total of boundary BPOLY blocks
//   POLY <K>                          // open contour, K vertices follow
//   x y z                             //   (K lines)
//   BPOLY <K>                         // closed boundary, K vertices follow
//   x y z                             //   (K lines; do NOT repeat first vertex)
//   ALPHA <value>                     // optional; <=0 means auto
//   SLOPE <value>                     // optional; <=0 means auto
//   BRIDGE_STEP <value>               // optional; <=0 means auto
//   BRIDGE_NEIGHBORS <int>            // optional; <0 means auto; 0 disables

#include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
#include <CGAL/Constrained_Delaunay_triangulation_2.h>
#include <CGAL/Triangulation_vertex_base_with_info_2.h>
#include <CGAL/Triangulation_face_base_with_info_2.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <iostream>
#include <limits>
#include <list>
#include <numeric>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

struct FaceInfo {
    int nesting_level = -1;
    bool in_domain() const { return nesting_level != -1 && (nesting_level % 2) == 1; }
};

using K     = CGAL::Exact_predicates_inexact_constructions_kernel;
using VInfo = std::pair<double, int>; // (z, vertex_index)
using Vb    = CGAL::Triangulation_vertex_base_with_info_2<VInfo, K>;
using Fbb   = CGAL::Triangulation_face_base_with_info_2<FaceInfo, K>;
using Fb    = CGAL::Constrained_triangulation_face_base_2<K, Fbb>;
using TDS   = CGAL::Triangulation_data_structure_2<Vb, Fb>;
using Itag  = CGAL::Exact_predicates_tag;
using CDT   = CGAL::Constrained_Delaunay_triangulation_2<K, TDS, Itag>;
using Point = K::Point_2;
using Vh    = CDT::Vertex_handle;
using Fh    = CDT::Face_handle;

using Polyline = std::vector<std::array<double, 3>>;

// ---------- helpers ----------

static bool point_in_polygon_xy(double px, double py, const Polyline& poly) {
    int n = static_cast<int>(poly.size());
    if (n < 3) return false;
    bool inside = false;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        double xi = poly[i][0], yi = poly[i][1];
        double xj = poly[j][0], yj = poly[j][1];
        bool crosses = ((yi > py) != (yj > py)) &&
            (px < (xj - xi) * (py - yi) / ((yj - yi) == 0.0 ? 1e-30 : (yj - yi)) + xi);
        if (crosses) inside = !inside;
    }
    return inside;
}

static double polyline_median_segment(const std::vector<const Polyline*>& polys) {
    std::vector<double> lens;
    for (const Polyline* pp : polys) {
        const auto& p = *pp;
        for (size_t v = 1; v < p.size(); ++v) {
            double dx = p[v][0] - p[v-1][0];
            double dy = p[v][1] - p[v-1][1];
            lens.push_back(std::sqrt(dx*dx + dy*dy));
        }
    }
    if (lens.empty()) return 0.0;
    std::sort(lens.begin(), lens.end());
    return lens[lens.size() / 2];
}

// Standard CGAL recipe for marking faces inside a polygonal CDT domain.
static void mark_domains_bfs(CDT& ct, Fh start, int index, std::list<CDT::Edge>& border) {
    if (start->info().nesting_level != -1) return;
    std::list<Fh> queue;
    queue.push_back(start);
    while (!queue.empty()) {
        Fh fh = queue.front(); queue.pop_front();
        if (fh->info().nesting_level != -1) continue;
        fh->info().nesting_level = index;
        for (int i = 0; i < 3; ++i) {
            CDT::Edge e(fh, i);
            Fh n = fh->neighbor(i);
            if (n->info().nesting_level == -1) {
                if (ct.is_constrained(e)) border.push_back(e);
                else queue.push_back(n);
            }
        }
    }
}

static void mark_domains(CDT& cdt) {
    for (Fh f : cdt.all_face_handles()) f->info().nesting_level = -1;
    std::list<CDT::Edge> border;
    mark_domains_bfs(cdt, cdt.infinite_face(), 0, border);
    while (!border.empty()) {
        CDT::Edge e = border.front(); border.pop_front();
        Fh n = e.first->neighbor(e.second);
        if (n->info().nesting_level == -1) {
            mark_domains_bfs(cdt, n, e.first->info().nesting_level + 1, border);
        }
    }
}

// ---------- per-cluster meshing ----------

struct MeshOut {
    std::vector<std::array<double, 3>> vertices;
    std::vector<std::array<int, 3>>    triangles;
    int    dropped_slope    = 0;
    int    dropped_outside  = 0; // triangles outside the boundary domain
    int    bridge_points    = 0;
    int    steiner_inserted = 0; // Steiner midpoint refinement points added
    double alpha_used       = 0.0;
    double slope_used       = 0.0;
    double bridge_step_used = 0.0;
    size_t num_contours     = 0;
    size_t boundary_vertices = 0;
};

static MeshOut triangulate_cluster(const Polyline& boundary,
                                   const std::vector<const Polyline*>& contours,
                                   const std::vector<std::array<double,3>>& extras,
                                   double alpha, double slope)
{
    MeshOut out;
    out.alpha_used       = alpha;
    out.slope_used       = slope;
    out.bridge_points    = static_cast<int>(extras.size());
    out.num_contours     = contours.size();
    out.boundary_vertices = boundary.size();

    CDT cdt;

    // Insert boundary as a CLOSED constraint loop.
    std::vector<Vh> bh;
    bh.reserve(boundary.size());
    for (const auto& p : boundary) {
        Vh h = cdt.insert(Point(p[0], p[1]));
        h->info().first = p[2];
        bh.push_back(h);
    }
    for (size_t i = 1; i < bh.size(); ++i) {
        if (bh[i] != bh[i-1]) cdt.insert_constraint(bh[i-1], bh[i]);
    }
    if (bh.size() >= 3 && bh.front() != bh.back()) {
        cdt.insert_constraint(bh.back(), bh.front());
    }

    // Insert contour vertices as FREE points (no constraints).
    for (const Polyline* pp : contours) {
        for (const auto& p : *pp) {
            Vh h = cdt.insert(Point(p[0], p[1]));
            h->info().first = p[2];
        }
    }

    // Track free (bridge + Steiner) vertices whose Z may be Laplacian-smoothed.
    // Boundary and contour vertices are fixed — they carry exact survey Z values.
    std::vector<Vh> free_verts;

    // Insert bridge densification points (also free).
    for (const auto& p : extras) {
        Vh h = cdt.insert(Point(p[0], p[1]));
        h->info().first = p[2];
        free_verts.push_back(h);
    }

    // Mark which faces are inside the boundary polygon.
    mark_domains(cdt);

    // Edge-length helper (XY only).
    auto edge_sq = [](const Point& a, const Point& b) {
        double dx = a.x() - b.x(), dy = a.y() - b.y();
        return dx * dx + dy * dy;
    };

    // Steiner midpoint refinement: iteratively split in-domain triangles whose
    // longest XY edge exceeds alpha by inserting the edge midpoint. Each pass
    // halves the offending edges and fills the gaps between sparse contour lines.
    // This replaces the old alpha-drop approach (which punched holes in the mesh).
    if (alpha > 0.0) {
        const double alpha_sq_ref = alpha * alpha;
        const int    MAX_PASSES   = 20;
        const int    MAX_STEINER  = 200000; // safety cap
        for (int pass = 0; pass < MAX_PASSES && out.steiner_inserted < MAX_STEINER; ++pass) {
            std::vector<std::array<double,3>> pts;
            for (auto fit = cdt.finite_faces_begin(); fit != cdt.finite_faces_end(); ++fit) {
                if (!fit->info().in_domain()) continue;
                Vh v0 = fit->vertex(0), v1 = fit->vertex(1), v2 = fit->vertex(2);
                double e01 = edge_sq(v0->point(), v1->point());
                double e12 = edge_sq(v1->point(), v2->point());
                double e20 = edge_sq(v2->point(), v0->point());
                double m   = std::max({e01, e12, e20});
                if (m > alpha_sq_ref) {
                    Vh va, vb;
                    if      (e01 >= e12 && e01 >= e20) { va = v0; vb = v1; }
                    else if (e12 >= e01 && e12 >= e20) { va = v1; vb = v2; }
                    else                               { va = v2; vb = v0; }
                    pts.push_back({
                        (va->point().x() + vb->point().x()) * 0.5,
                        (va->point().y() + vb->point().y()) * 0.5,
                        (va->info().first + vb->info().first) * 0.5
                    });
                }
            }
            if (pts.empty()) break;
            for (const auto& p : pts) {
                Vh h = cdt.insert(Point(p[0], p[1]));
                h->info().first = p[2];
                free_verts.push_back(h);
            }
            out.steiner_inserted += static_cast<int>(pts.size());
            mark_domains(cdt);
        }
    }

    // Laplacian Z smoothing on free vertices only (bridge + Steiner).
    // Boundary and contour vertices stay at their exact survey Z.
    // Each iteration pulls each free vertex's Z to the average of its CDT
    // neighbours, eliminating spike artifacts where the Delaunay triangulation
    // connected vertices from very different Z levels.
    {
        const int SMOOTH_ITERS = 10;
        for (int iter = 0; iter < SMOOTH_ITERS; ++iter) {
            for (Vh v : free_verts) {
                if (cdt.is_infinite(v)) continue;
                auto circ = cdt.incident_vertices(v);
                auto done = circ;
                double sum_z = 0.0;
                int    cnt   = 0;
                do {
                    if (!cdt.is_infinite(circ)) {
                        sum_z += circ->info().first;
                        ++cnt;
                    }
                } while (++circ != done);
                if (cnt > 0) v->info().first = sum_z / static_cast<double>(cnt);
            }
        }
    }

    // Assign output indices to vertices, collect.
    int next_idx = 0;
    out.vertices.reserve(cdt.number_of_vertices());
    for (auto vit = cdt.finite_vertices_begin(); vit != cdt.finite_vertices_end(); ++vit) {
        vit->info().second = next_idx++;
        out.vertices.push_back({vit->point().x(), vit->point().y(), vit->info().first});
    }

    for (auto fit = cdt.finite_faces_begin(); fit != cdt.finite_faces_end(); ++fit) {
        if (!fit->info().in_domain()) { ++out.dropped_outside; continue; }

        Vh v0 = fit->vertex(0), v1 = fit->vertex(1), v2 = fit->vertex(2);
        double e01 = edge_sq(v0->point(), v1->point());
        double e12 = edge_sq(v1->point(), v2->point());
        double e20 = edge_sq(v2->point(), v0->point());
        double m   = std::max({e01, e12, e20});

        if (slope > 0.0) {
            double z0 = v0->info().first, z1 = v1->info().first, z2 = v2->info().first;
            double zmin = std::min({z0, z1, z2});
            double zmax = std::max({z0, z1, z2});
            double xy_longest = std::sqrt(m);
            if ((zmax - zmin) > slope * xy_longest) { ++out.dropped_slope; continue; }
        }
        out.triangles.push_back({v0->info().second, v1->info().second, v2->info().second});
    }
    return out;
}

// ---------- main ----------

int main() {
    std::ios::sync_with_stdio(false);

    std::vector<Polyline> contours;
    std::vector<Polyline> boundaries;

    double alpha_override        = -1.0;
    double slope_override        = -1.0;
    double bridge_step_override  = -1.0;
    int    bridge_neighbors_override = -1;

    std::string tok;
    while (std::cin >> tok) {
        if (tok == "POLYLINES" || tok == "BOUNDARIES") {
            int n; std::cin >> n;
            if (tok == "POLYLINES")  contours.reserve(static_cast<size_t>(std::max(0, n)));
            else                     boundaries.reserve(static_cast<size_t>(std::max(0, n)));
        } else if (tok == "POLY" || tok == "BPOLY") {
            int k; std::cin >> k;
            Polyline poly;
            poly.reserve(static_cast<size_t>(std::max(0, k)));
            for (int i = 0; i < k; ++i) {
                double x, y, z;
                std::cin >> x >> y >> z;
                poly.push_back({x, y, z});
            }
            if (tok == "POLY") contours.push_back(std::move(poly));
            else               boundaries.push_back(std::move(poly));
        }
        else if (tok == "ALPHA")            { std::cin >> alpha_override; }
        else if (tok == "SLOPE")            { std::cin >> slope_override; }
        else if (tok == "BRIDGE_STEP")      { std::cin >> bridge_step_override; }
        else if (tok == "BRIDGE_NEIGHBORS") { std::cin >> bridge_neighbors_override; }
        else {
            std::cerr << "Unknown token in input stream: '" << tok << "'\n";
            return 2;
        }
    }

    size_t total_input_vertices = 0;
    for (const auto& p : contours)   total_input_vertices += p.size();
    for (const auto& p : boundaries) total_input_vertices += p.size();

    int default_bridge_neighbors = (bridge_neighbors_override >= 0) ? bridge_neighbors_override : 2;
    double slope = (slope_override > 0.0) ? slope_override : 5.0;

    // Assign each contour to the boundary whose XY polygon contains its first vertex.
    std::vector<std::vector<const Polyline*>> per_boundary_contours(boundaries.size());
    int orphan_count = 0;
    for (const auto& c : contours) {
        if (c.empty()) continue;
        double px = c[0][0], py = c[0][1];
        int hit = -1;
        for (size_t b = 0; b < boundaries.size(); ++b) {
            if (point_in_polygon_xy(px, py, boundaries[b])) { hit = static_cast<int>(b); break; }
        }
        if (hit >= 0) per_boundary_contours[hit].push_back(&c);
        else          ++orphan_count;
    }
    if (orphan_count > 0) {
        std::cerr << "[mesh_gen] " << orphan_count << " contour(s) did not lie inside any boundary; dropped.\n";
    }

    std::vector<MeshOut> meshes;
    meshes.reserve(boundaries.size());

    for (size_t b = 0; b < boundaries.size(); ++b) {
        const Polyline& boundary = boundaries[b];
        const auto& contour_ptrs = per_boundary_contours[b];

        // Build a combined list for median + bridge-neighbor calculations.
        std::vector<const Polyline*> all_lines;
        all_lines.reserve(contour_ptrs.size() + 1);
        all_lines.push_back(&boundary);
        for (auto p : contour_ptrs) all_lines.push_back(p);

        double median_seg = polyline_median_segment(all_lines);
        double alpha       = (alpha_override       > 0.0) ? alpha_override       : (median_seg * 6.0);
        double bridge_step = (bridge_step_override > 0.0) ? bridge_step_override : median_seg;

        // Bridge densification: pair every contour with its k nearest siblings
        // (including the boundary). Sample interpolated points between them.
        std::vector<std::array<double,3>> extras;
        if (default_bridge_neighbors > 0 && bridge_step > 0.0 && all_lines.size() > 1) {
            int N = static_cast<int>(all_lines.size());
            // minD2[i][j] = min XY squared distance between lines i and j.
            std::vector<std::vector<double>> minD2(N, std::vector<double>(N, std::numeric_limits<double>::max()));
            for (int i = 0; i < N; ++i) {
                for (int j = i + 1; j < N; ++j) {
                    double best = std::numeric_limits<double>::max();
                    for (const auto& a : *all_lines[i]) {
                        for (const auto& bb : *all_lines[j]) {
                            double dx = a[0] - bb[0], dy = a[1] - bb[1];
                            double d = dx*dx + dy*dy;
                            if (d < best) best = d;
                        }
                    }
                    minD2[i][j] = best;
                    minD2[j][i] = best;
                }
            }
            // Bridge from every contour (skip the boundary as source, index 0)
            // to its nearest siblings. This includes bridging contour->boundary,
            // which fills the rim gap nicely.
            for (int i = 1; i < N; ++i) {
                std::vector<std::pair<double,int>> dists;
                dists.reserve(N - 1);
                for (int j = 0; j < N; ++j) if (j != i) dists.emplace_back(minD2[i][j], j);
                int k = std::min(default_bridge_neighbors, (int)dists.size());
                std::partial_sort(dists.begin(), dists.begin() + k, dists.end());
                for (int n = 0; n < k; ++n) {
                    int j = dists[n].second;
                    const Polyline& A = *all_lines[i];
                    const Polyline& B = *all_lines[j];
                    for (const auto& va : A) {
                        double best = std::numeric_limits<double>::max();
                        const std::array<double,3>* nearest = nullptr;
                        for (const auto& vb : B) {
                            double dx = va[0] - vb[0], dy = va[1] - vb[1];
                            double d = dx*dx + dy*dy;
                            if (d < best) { best = d; nearest = &vb; }
                        }
                        if (!nearest) continue;
                        double dist = std::sqrt(best);
                        if (dist <= bridge_step) continue;
                        int nPts = static_cast<int>(std::floor(dist / bridge_step));
                        for (int m = 1; m <= nPts; ++m) {
                            double t = static_cast<double>(m) / static_cast<double>(nPts + 1);
                            extras.push_back({
                                va[0] + t * ((*nearest)[0] - va[0]),
                                va[1] + t * ((*nearest)[1] - va[1]),
                                va[2] + t * ((*nearest)[2] - va[2]),
                            });
                        }
                    }
                }
            }
        }

        MeshOut m = triangulate_cluster(boundary, contour_ptrs, extras, alpha, slope);
        m.bridge_step_used = bridge_step;
        meshes.push_back(std::move(m));
    }

    // Emit JSON.
    std::ostringstream out;
    out.precision(10);
    out << "{\"ok\":true"
        << ",\"num_contours\":" << contours.size()
        << ",\"num_boundaries\":" << boundaries.size()
        << ",\"num_orphan_contours\":" << orphan_count
        << ",\"num_input_vertices\":" << total_input_vertices
        << ",\"num_meshes\":" << meshes.size()
        << ",\"slope_used\":" << slope
        << ",\"bridge_neighbors\":" << default_bridge_neighbors
        << ",\"meshes\":[";
    for (size_t i = 0; i < meshes.size(); ++i) {
        if (i) out << ",";
        const auto& mesh = meshes[i];
        out << "{"
            << "\"num_contours\":"       << mesh.num_contours
            << ",\"boundary_vertices\":" << mesh.boundary_vertices
            << ",\"num_vertices\":"      << mesh.vertices.size()
            << ",\"num_triangles\":"     << mesh.triangles.size()
            << ",\"steiner_inserted\":" << mesh.steiner_inserted
            << ",\"dropped_slope\":"     << mesh.dropped_slope
            << ",\"dropped_outside\":"   << mesh.dropped_outside
            << ",\"bridge_points\":"     << mesh.bridge_points
            << ",\"alpha_used\":"        << mesh.alpha_used
            << ",\"slope_used\":"        << mesh.slope_used
            << ",\"bridge_step_used\":"  << mesh.bridge_step_used
            << ",\"vertices\":[";
        for (size_t k = 0; k < mesh.vertices.size(); ++k) {
            if (k) out << ",";
            out << "[" << mesh.vertices[k][0] << "," << mesh.vertices[k][1] << "," << mesh.vertices[k][2] << "]";
        }
        out << "],\"triangles\":[";
        for (size_t k = 0; k < mesh.triangles.size(); ++k) {
            if (k) out << ",";
            out << "[" << mesh.triangles[k][0] << "," << mesh.triangles[k][1] << "," << mesh.triangles[k][2] << "]";
        }
        out << "]}";
    }
    out << "]}";

    std::cout << out.str() << std::endl;
    return 0;
}
