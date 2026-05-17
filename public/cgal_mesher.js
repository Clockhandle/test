// Browser-side CGAL mesher.
// Sends contour and boundary polylines to /api/mesh; receives one mesh per
// boundary (every triangle lies strictly inside its boundary polygon).

import * as THREE from 'three';

let cgalGroup = null;

/**
 * @param {Array<Array<THREE.Vector3>>} rawDataSegments
 * @param {THREE.Group} meshGroup
 * @param {Object} [opts]
 * @param {number} [opts.alpha]              Max XY edge length kept (per boundary).
 * @param {number} [opts.slope]              Max (zmax-zmin) / longest_xy_edge per triangle (anti-spike).
 * @param {number} [opts.bridge_step]        Bridge densification spacing (per boundary; <=0 = auto).
 * @param {number} [opts.bridge_neighbors]   Number of nearest sibling lines bridged per contour (0 disables).
 */
export async function buildCgalMesh(rawDataSegments, meshGroup, opts = {}) {
    if (!rawDataSegments || rawDataSegments.length === 0) {
        alert('No contour data loaded. Upload a JSON first.');
        return;
    }

    const polylines  = [];
    const boundaries = [];
    for (const seg of rawDataSegments) {
        if (!seg || seg.length === 0) continue;
        const poly = new Array(seg.length);
        for (let i = 0; i < seg.length; ++i) {
            const v = seg[i];
            poly[i] = [v.x, v.y, v.z];
        }
        if (seg.isBoundary) boundaries.push(poly);
        else                polylines.push(poly);
    }
    if (boundaries.length === 0) {
        alert('No IsBoundary loops found in the data. Boundary lines are required — mesh generation is confined to the inside of each boundary.');
        return;
    }

    const payload = { polylines, boundaries };
    if (typeof opts.alpha === 'number' && opts.alpha > 0) payload.alpha = opts.alpha;
    if (typeof opts.slope === 'number' && opts.slope > 0) payload.slope = opts.slope;
    if (typeof opts.bridge_step      === 'number' && opts.bridge_step      > 0) payload.bridge_step      = opts.bridge_step;
    if (typeof opts.bridge_neighbors === 'number' && opts.bridge_neighbors >= 0) payload.bridge_neighbors = opts.bridge_neighbors;

    const t0 = performance.now();
    let resp;
    try {
        resp = await fetch('/api/mesh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } catch (e) {
        console.error('CGAL mesh request failed:', e);
        alert('Network error reaching /api/mesh: ' + e.message);
        return;
    }
    const data = await resp.json();
    const dt = performance.now() - t0;

    if (!resp.ok || !data.ok) {
        console.error('CGAL mesh error:', data);
        alert('CGAL mesh failed: ' + (data.error || resp.statusText));
        return;
    }

    console.log('[CGAL]', {
        contours: data.num_contours,
        boundaries: data.num_boundaries,
        orphan_contours: data.num_orphan_contours,
        input_vertices: data.num_input_vertices,
        meshes: data.num_meshes,
        slope_used: data.slope_used,
        bridge_neighbors: data.bridge_neighbors,
        server_ms: data.elapsed_ms,
        roundtrip_ms: Math.round(dt),
    });
    data.meshes.forEach((m, i) => {
        console.log(`  boundary ${i}: ${m.num_contours} contours, ${m.boundary_vertices} boundary verts, ${m.num_vertices} mesh verts (${m.bridge_points} bridge + ${m.steiner_inserted} Steiner), ${m.num_triangles} tris (alpha=${m.alpha_used.toFixed(2)}, bridge_step=${m.bridge_step_used.toFixed(2)}, dropped_outside=${m.dropped_outside}, dropped_slope=${m.dropped_slope})`);
    });

    renderMeshes(data, meshGroup);
}

function renderMeshes(data, meshGroup) {
    if (cgalGroup) {
        cgalGroup.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        if (cgalGroup.parent) cgalGroup.parent.remove(cgalGroup);
    }
    cgalGroup = new THREE.Group();
    cgalGroup.name = 'CGAL_Meshes';
    meshGroup.add(cgalGroup);

    const n = data.meshes.length || 1;
    data.meshes.forEach((m, i) => {
        if (!m.triangles || m.triangles.length === 0) return;

        const positions = new Float32Array(m.vertices.length * 3);
        for (let v = 0; v < m.vertices.length; ++v) {
            positions[v * 3 + 0] = m.vertices[v][0];
            positions[v * 3 + 1] = m.vertices[v][1];
            positions[v * 3 + 2] = m.vertices[v][2];
        }
        const indices = new Uint32Array(m.triangles.length * 3);
        for (let t = 0; t < m.triangles.length; ++t) {
            indices[t * 3 + 0] = m.triangles[t][0];
            indices[t * 3 + 1] = m.triangles[t][1];
            indices[t * 3 + 2] = m.triangles[t][2];
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setIndex(new THREE.BufferAttribute(indices, 1));
        geom.computeVertexNormals();
        geom.computeBoundingBox();
        geom.computeBoundingSphere();

        const hue = (i / n) * 360;
        const color = new THREE.Color(`hsl(${Math.floor(hue)}, 70%, 55%)`);
        const mat = new THREE.MeshStandardMaterial({
            color,
            side: THREE.DoubleSide,
            flatShading: true,
            roughness: 0.9,
            metalness: 0.0,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = `CGAL_Mesh_${i}`;
        mesh.userData.clusterIndex = i;
        mesh.userData.alphaUsed    = m.alpha_used;
        cgalGroup.add(mesh);

        const wireGeom = new THREE.WireframeGeometry(geom);
        const wireMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 });
        const wire = new THREE.LineSegments(wireGeom, wireMat);
        wire.name = `CGAL_Mesh_${i}_Wire`;
        mesh.add(wire);
    });

    ensureLights(meshGroup);
}

let lightsAdded = false;
function ensureLights(meshGroup) {
    if (lightsAdded) return;
    const scene = meshGroup.parent || meshGroup;
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.8); d1.position.set( 1,  1,  2); scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.4); d2.position.set(-1, -1, -1); scene.add(d2);
    lightsAdded = true;
}

export function clearCgalMesh() {
    if (!cgalGroup) return;
    cgalGroup.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
    });
    if (cgalGroup.parent) cgalGroup.parent.remove(cgalGroup);
    cgalGroup = null;
}
