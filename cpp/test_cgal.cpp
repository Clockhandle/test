// Minimal CGAL sanity check: builds a 2D Delaunay triangulation over a
// small hardcoded point set and prints the result as JSON to stdout.
// Used by ../test_cgal.cjs to confirm the toolchain + CGAL link works
// and that Node can invoke the binary and parse its output.

#include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
#include <CGAL/Delaunay_triangulation_2.h>

#include <iostream>
#include <vector>
#include <sstream>

using K = CGAL::Exact_predicates_inexact_constructions_kernel;
using DT = CGAL::Delaunay_triangulation_2<K>;
using Point = K::Point_2;

int main() {
    // Small fixed input so output is deterministic.
    const std::vector<Point> pts = {
        Point(0.0, 0.0),
        Point(1.0, 0.0),
        Point(0.0, 1.0),
        Point(1.0, 1.0),
        Point(0.5, 0.5),
        Point(2.0, 0.3),
        Point(-0.5, 1.2),
    };

    DT dt;
    dt.insert(pts.begin(), pts.end());

    // Build a vertex-handle -> index map (default DT2 vertices don't carry user data).
    std::ostringstream verts_json;
    verts_json << "[";
    bool first = true;
    int idx = 0;
    // Map handle -> idx using a simple linear pass; fine for tiny test size.
    std::vector<DT::Vertex_handle> handles;
    for (auto vit = dt.finite_vertices_begin(); vit != dt.finite_vertices_end(); ++vit) {
        handles.push_back(vit);
        if (!first) verts_json << ",";
        verts_json << "[" << vit->point().x() << "," << vit->point().y() << "]";
        first = false;
        ++idx;
    }
    verts_json << "]";

    auto handle_index = [&](DT::Vertex_handle h) -> int {
        for (size_t i = 0; i < handles.size(); ++i) if (handles[i] == h) return static_cast<int>(i);
        return -1;
    };

    std::ostringstream tris_json;
    tris_json << "[";
    first = true;
    int tri_count = 0;
    for (auto fit = dt.finite_faces_begin(); fit != dt.finite_faces_end(); ++fit) {
        int a = handle_index(fit->vertex(0));
        int b = handle_index(fit->vertex(1));
        int c = handle_index(fit->vertex(2));
        if (!first) tris_json << ",";
        tris_json << "[" << a << "," << b << "," << c << "]";
        first = false;
        ++tri_count;
    }
    tris_json << "]";

    std::cout
        << "{"
        << "\"ok\":true,"
        << "\"cgal\":\"Delaunay_triangulation_2\","
        << "\"num_input_points\":" << pts.size() << ","
        << "\"num_vertices\":" << dt.number_of_vertices() << ","
        << "\"num_triangles\":" << tri_count << ","
        << "\"vertices\":" << verts_json.str() << ","
        << "\"triangles\":" << tris_json.str()
        << "}" << std::endl;

    return 0;
}
