// mesh_clip — Clips a triangle mesh with a half-space defined by a plane.
//
// Uses CGAL::Polygon_mesh_processing::clip() which:
//   - Splits triangles that cross the plane (no jagged edges — exact split points)
//   - Keeps the side where plane(p) >= 0  (positive half-space)
//   - Works on open surfaces (clip_volume=false), no watertight requirement
//
// Input grammar (whitespace-separated tokens on stdin):
//   VERTICES <N>         N vertex lines follow: "x y z"
//   TRIANGLES <T>        T triangle lines follow: "i0 i1 i2"  (0-based)
//   PLANE <a> <b> <c> <d>  half-space: keep where ax+by+cz+d >= 0
//
// Output: JSON { "ok":true, "vertices":[[x,y,z],...], "triangles":[[i,j,k],...] }

#include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
#include <CGAL/Surface_mesh.h>
#include <CGAL/Polygon_mesh_processing/clip.h>
#include <CGAL/Polygon_mesh_processing/triangulate_faces.h>

#include <iostream>
#include <string>
#include <vector>
#include <array>
#include <unordered_map>

using K      = CGAL::Exact_predicates_inexact_constructions_kernel;
using Point3 = K::Point_3;
using Plane3 = K::Plane_3;
using SMesh  = CGAL::Surface_mesh<Point3>;
namespace PMP = CGAL::Polygon_mesh_processing;

int main() {
    std::vector<std::array<double, 3>> verts;
    std::vector<std::array<int,    3>> tris;
    double pa = 0, pb = 0, pc = 1, pd = 0;

    std::string token;
    while (std::cin >> token) {
        if (token == "VERTICES") {
            int n; std::cin >> n;
            verts.resize(n);
            for (int i = 0; i < n; i++)
                std::cin >> verts[i][0] >> verts[i][1] >> verts[i][2];

        } else if (token == "TRIANGLES") {
            int t; std::cin >> t;
            tris.resize(t);
            for (int i = 0; i < t; i++)
                std::cin >> tris[i][0] >> tris[i][1] >> tris[i][2];

        } else if (token == "PLANE") {
            std::cin >> pa >> pb >> pc >> pd;
        }
    }

    if (verts.empty() || tris.empty()) {
        std::cout << "{\"ok\":false,\"error\":\"Empty mesh\"}" << std::endl;
        return 1;
    }

    // Build Surface_mesh from the indexed triangle soup.
    SMesh mesh;
    std::vector<SMesh::Vertex_index> vi(verts.size());
    for (size_t i = 0; i < verts.size(); i++)
        vi[i] = mesh.add_vertex(Point3(verts[i][0], verts[i][1], verts[i][2]));

    for (auto& t : tris) {
        if (t[0] < 0 || t[1] < 0 || t[2] < 0 ||
            t[0] >= (int)verts.size() ||
            t[1] >= (int)verts.size() ||
            t[2] >= (int)verts.size()) continue;
        if (t[0] == t[1] || t[1] == t[2] || t[0] == t[2]) continue; // degenerate
        mesh.add_face(vi[t[0]], vi[t[1]], vi[t[2]]);
        // Non-manifold faces are silently skipped by Surface_mesh::add_face.
    }

    if (mesh.number_of_faces() == 0) {
        std::cout << "{\"ok\":false,\"error\":\"Could not build Surface_mesh\"}" << std::endl;
        return 1;
    }

    // PMP::clip keeps the half-space where plane(p) >= 0.
    // Our convention: PLANE a b c d  → keep side where ax+by+cz+d >= 0
    // CGAL Plane_3(a,b,c,d) has positive_side where ax+by+cz+d > 0,
    // so this matches directly.
    Plane3 plane(pa, pb, pc, pd);
    try {
        PMP::clip(mesh, plane, PMP::parameters::clip_volume(false));
    } catch (const std::exception& e) {
        std::cout << "{\"ok\":false,\"error\":\"clip failed: " << e.what() << "\"}" << std::endl;
        return 1;
    }

    // Clip may produce n-gon faces on the cut boundary; triangulate them.
    PMP::triangulate_faces(mesh);

    // Compact removed vertices/faces and re-index.
    mesh.collect_garbage();

    // Collect output with remapped indices.
    std::unordered_map<int, int> vMap;
    std::vector<std::array<double, 3>> outV;
    for (auto v : mesh.vertices()) {
        vMap[(int)v] = (int)outV.size();
        auto& p = mesh.point(v);
        outV.push_back({ CGAL::to_double(p.x()),
                         CGAL::to_double(p.y()),
                         CGAL::to_double(p.z()) });
    }

    std::vector<std::array<int, 3>> outT;
    for (auto f : mesh.faces()) {
        auto h = mesh.halfedge(f);
        int a = vMap[(int)mesh.source(h)]; h = mesh.next(h);
        int b = vMap[(int)mesh.source(h)]; h = mesh.next(h);
        int c = vMap[(int)mesh.source(h)];
        outT.push_back({ a, b, c });
    }

    // Emit JSON.
    std::cout << "{\"ok\":true,\"vertices\":[";
    for (size_t i = 0; i < outV.size(); i++) {
        if (i) std::cout << ",";
        std::cout << "[" << outV[i][0] << ","
                         << outV[i][1] << ","
                         << outV[i][2] << "]";
    }
    std::cout << "],\"triangles\":[";
    for (size_t i = 0; i < outT.size(); i++) {
        if (i) std::cout << ",";
        std::cout << "[" << outT[i][0] << ","
                         << outT[i][1] << ","
                         << outT[i][2] << "]";
    }
    std::cout << "]}" << std::endl;
    return 0;
}
