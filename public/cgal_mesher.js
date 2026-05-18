// Browser-side CGAL mesher.
// Sends contour and boundary polylines to /api/mesh; receives one mesh per
// boundary (every triangle lies strictly inside its boundary polygon).

import * as THREE from 'three';

let cgalGroup = null;

/**
 * @param {Array<Array<THREE.Vector3>>} rawDataSegments
 * @param {THREE.Group} meshGroup
 * @param {Object} [opts]
 * @param {number} [opts.slope]  Max (delta_z / XY_edge) kept. Default 5.0; 0 = no filter.
 */
export async function buildCgalMesh(rawDataSegments, meshGroup, opts = {}) {
    if (!rawDataSegments || rawDataSegments.length === 0) {
        alert('No contour data loaded. Upload a JSON first.');
        return;
    }

    // Group segments by featureType so each type is meshed in complete isolation.
    // A Vách contour will never influence the Trụ CDT and vice versa.
    const groups = new Map();  // featureType-key -> { featureType, polylines[], boundaries[] }
    for (const seg of rawDataSegments) {
        if (!seg || seg.length === 0) continue;
        const key = seg.featureType || '__other__';
        if (!groups.has(key)) {
            groups.set(key, { featureType: seg.featureType || null, polylines: [], boundaries: [] });
        }
        const g = groups.get(key);
        const poly = seg.map(v => [v.x, v.y, v.z]);
        if (seg.isBoundary) g.boundaries.push(poly);
        else                g.polylines.push(poly);
    }

    const meshableGroups = [...groups.values()].filter(g => g.boundaries.length > 0);
    if (meshableGroups.length === 0) {
        alert('No IsBoundary loops found in the data. Boundary lines are required — mesh generation is confined to the inside of each boundary.');
        return;
    }

    const t0 = performance.now();
    let results;
    try {
        results = await Promise.all(meshableGroups.map(async g => {
            const payload = { polylines: g.polylines, boundaries: g.boundaries };
            if (typeof opts.slope === 'number' && opts.slope >= 0) payload.slope = opts.slope;
            const resp = await fetch('/api/mesh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || resp.statusText);
            return { data, featureType: g.featureType };
        }));
    } catch (e) {
        console.error('CGAL mesh request failed:', e);
        alert('CGAL mesh failed: ' + e.message);
        return;
    }
    const dt = performance.now() - t0;

    results.forEach(({ data, featureType }) => {
        console.log(`[CGAL-CDT] featureType=${featureType}`, {
            contours: data.num_contours,
            boundaries: data.num_boundaries,
            orphan_contours: data.num_orphan_contours,
            meshes: data.num_meshes,
            elapsed_ms: data.elapsed_ms,
        });
        (data.meshes || []).forEach((m, i) => {
            console.log(`  boundary ${i}: ${m.num_contours} contours, ${m.num_vertices} verts, ${m.num_triangles} tris (dropped_slope=${m.dropped_slope}, slope_threshold=${m.slope_used})`);
        });
    });
    console.log(`[CGAL-CDT] total roundtrip ${Math.round(dt)} ms`);

    renderMeshes(results, meshGroup);
}

// results: Array<{ data, featureType }>
function renderMeshes(results, meshGroup) {
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

    const totalMeshes = results.reduce((s, r) => s + (r.data.meshes?.length || 0), 0) || 1;
    let globalIndex = 0;

    for (const { data, featureType } of results) {
        (data.meshes || []).forEach(m => {
            if (!m.triangles || m.triangles.length === 0) { globalIndex++; return; }

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

            const hue = (globalIndex / totalMeshes) * 360;
            const color = new THREE.Color(`hsl(${Math.floor(hue)}, 70%, 55%)`);
            const mat = new THREE.MeshStandardMaterial({
                color,
                side: THREE.DoubleSide,
                flatShading: true,
                roughness: 0.9,
                metalness: 0.0,
            });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.name = `CGAL_Mesh_${globalIndex}`;
            mesh.userData.clusterIndex = globalIndex;
            mesh.userData.alphaUsed    = m.alpha_used;
            if (featureType) mesh.userData.featureType = featureType;
            cgalGroup.add(mesh);

            const wireGeom = new THREE.WireframeGeometry(geom);
            const wireMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 });
            const wire = new THREE.LineSegments(wireGeom, wireMat);
            wire.name = `CGAL_Mesh_${globalIndex}_Wire`;
            if (featureType) wire.userData.featureType = featureType;
            mesh.add(wire);

            globalIndex++;
        });
    }

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
