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
    clampTruToVach(cgalGroup);
}

// results: Array<{ data, featureType }}
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
            mesh.userData.rawVertices  = m.vertices;   // needed for border extraction
            mesh.userData.rawTriangles = m.triangles;  // needed for border extraction
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

/**
 * Post-process: clamp Trụ vertices/triangles that sit above the paired Vách
 * surface, preserving mesh topology (no holes).
 *
 * BUG FIX: meshGroup.position is set to (-centerX,-centerY,-centerZ) when a
 * file is loaded, so geometry positions (survey/local space) differ from world
 * space.  All raycasting must use world-space coordinates obtained via
 * matrixWorld / matrixWorldInverse.
 */
function clampTruToVach(group) {
    const vachMeshes = [], truMeshes = [];
    group.traverse(obj => {
        if (!(obj instanceof THREE.Mesh)) return;
        if (obj.userData.featureType === 'vach') vachMeshes.push(obj);
        if (obj.userData.featureType === 'tru')  truMeshes.push(obj);
    });
    if (vachMeshes.length === 0 || truMeshes.length === 0) return;

    const raycaster = new THREE.Raycaster();
    const UP = new THREE.Vector3(0, 0, 1);

    // Reusable vectors — allocated once outside all loops.
    const origin  = new THREE.Vector3();
    const localPt = new THREE.Vector3();
    const worldPt = new THREE.Vector3();
    const clampPt = new THREE.Vector3();
    const waP = new THREE.Vector3(), wbP = new THREE.Vector3(), wcP = new THREE.Vector3();
    const va  = new THREE.Vector3(), vb  = new THREE.Vector3(), vc  = new THREE.Vector3();

    truMeshes.forEach(truMesh => {
        truMesh.updateWorldMatrix(true, false);

        // Nearest Vách by XY centroid (world space via Box3).
        const truBox    = new THREE.Box3().setFromObject(truMesh);
        const truCenter = truBox.getCenter(new THREE.Vector3());

        let bestVach = null, bestDist = Infinity;
        vachMeshes.forEach(v => {
            v.updateWorldMatrix(true, false);
            const vBox    = new THREE.Box3().setFromObject(v);
            const vCenter = vBox.getCenter(new THREE.Vector3());
            const d = Math.hypot(truCenter.x - vCenter.x, truCenter.y - vCenter.y);
            if (d < bestDist) { bestDist = d; bestVach = v; }
        });
        if (!bestVach) return;

        // World-space transforms for this mesh.
        const mw  = truMesh.matrixWorld;
        const mwi = mw.clone().invert();   // world → local

        const pos      = truMesh.geometry.attributes.position;
        const idx      = truMesh.geometry.index;
        const rawVerts = truMesh.userData.rawVertices;
        let totalClamped = 0;

        // ── Pass 1: per-vertex ──────────────────────────────────────────────
        let noHitVerts = 0, checkedVerts = 0;
        for (let v = 0; v < pos.count; v++) {
            localPt.set(pos.getX(v), pos.getY(v), pos.getZ(v));
            worldPt.copy(localPt).applyMatrix4(mw);   // local → world

            origin.set(worldPt.x, worldPt.y, worldPt.z - 5000);
            raycaster.set(origin, UP);
            const hits = raycaster.intersectObject(bestVach, false);
            checkedVerts++;
            if (hits.length === 0) { noHitVerts++; continue; }

            const worldVachZ = hits[0].point.z;
            if (worldPt.z <= worldVachZ - 0.01) continue; // already below ceiling

            // Convert (worldX, worldY, clampedWorldZ) back to local space.
            clampPt.set(worldPt.x, worldPt.y, worldVachZ - 0.01).applyMatrix4(mwi);
            pos.setZ(v, clampPt.z);
            if (rawVerts && rawVerts[v]) rawVerts[v][2] = clampPt.z;
            totalClamped++;
        }
        console.log(`[ClampTru] ${truMesh.name}: pass1 checked=${checkedVerts} noHit=${noHitVerts} clamped=${totalClamped}`);

        // ── Pass 2: per-triangle centroid (single sweep, all 3 verts) ────────
        // Clamping only the highest vertex of each tent triangle causes
        // oscillation — the other two high vertices make neighbouring triangles
        // bad on the next pass.  Clamp ALL 3 vertices of every bad triangle in
        // one sweep so the tent collapses completely with no cycling.
        let totalBadCentroids = 0, totalNoHitCentroids = 0;
        const triCount = idx.count / 3;
        for (let i = 0; i < triCount; i++) {
            const i0 = idx.getX(i * 3),
                  i1 = idx.getX(i * 3 + 1),
                  i2 = idx.getX(i * 3 + 2);

            va.fromBufferAttribute(pos, i0);
            vb.fromBufferAttribute(pos, i1);
            vc.fromBufferAttribute(pos, i2);

            // Convert triangle vertices to world space.
            waP.copy(va).applyMatrix4(mw);
            wbP.copy(vb).applyMatrix4(mw);
            wcP.copy(vc).applyMatrix4(mw);

            const wcx = (waP.x + wbP.x + wcP.x) / 3;
            const wcy = (waP.y + wbP.y + wcP.y) / 3;
            const wcz = (waP.z + wbP.z + wcP.z) / 3;

            origin.set(wcx, wcy, wcz - 5000);
            raycaster.set(origin, UP);
            const hits = raycaster.intersectObject(bestVach, false);
            if (hits.length === 0) { totalNoHitCentroids++; continue; }
            if (wcz <= hits[0].point.z - 0.01) continue; // centroid already below

            totalBadCentroids++;

            // Clamp all 3 vertices of this tent triangle.
            const tris = [[i0, waP], [i1, wbP], [i2, wcP]];
            for (const [vi, wv] of tris) {
                origin.set(wv.x, wv.y, wv.z - 5000);
                raycaster.set(origin, UP);
                const vHits = raycaster.intersectObject(bestVach, false);
                if (vHits.length === 0) continue;
                const worldVachZ = vHits[0].point.z;
                if (wv.z <= worldVachZ - 0.01) continue; // this vertex already fine
                clampPt.set(wv.x, wv.y, worldVachZ - 0.01).applyMatrix4(mwi);
                pos.setZ(vi, clampPt.z);
                if (rawVerts && rawVerts[vi]) rawVerts[vi][2] = clampPt.z;
                totalClamped++;
            }
        }
        console.log(`[ClampTru] ${truMesh.name}: pass2 noHitCentroids=${totalNoHitCentroids} badCentroids=${totalBadCentroids} totalClamped=${totalClamped}`);

        if (totalClamped === 0) return;

        console.log(`[ClampTru] ${truMesh.name}: total ${totalClamped} vertex adjustment(s)`);

        pos.needsUpdate = true;
        truMesh.geometry.computeVertexNormals();
        truMesh.geometry.computeBoundingBox();
        truMesh.geometry.computeBoundingSphere();

        const wireChild = truMesh.children.find(ch => ch instanceof THREE.LineSegments);
        if (wireChild) {
            wireChild.geometry.dispose();
            wireChild.geometry = new THREE.WireframeGeometry(truMesh.geometry);
        }
    });
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
