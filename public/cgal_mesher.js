// Browser-side CGAL mesher.
// Sends contour and boundary polylines to /api/mesh; receives one mesh per
// boundary (every triangle lies strictly inside its boundary polygon).

import * as THREE from 'three';

let cgalGroup = null;

/**
 * @param {THREE.Group} meshGroup
 * @param {Object} [opts]
 * @param {number} [opts.slope]  Max (delta_z / XY_edge) kept. Default 5.0; 0 = no filter.
 */
export async function buildCgalMesh(rawDataSegments, meshGroup, opts = {}) {
    if (!rawDataSegments || rawDataSegments.length === 0) {
        alert('No contour data loaded. Upload a JSON first.');
        return;
    }

    // Group segments by viaName + blockName + featureType — the full 3-level tree.
    // Vỉa 1 and Vỉa 2 must never share a mesh, same for different Khối within a Vỉa.
    const groups = new Map();  // key -> { viaName, featureType, blockName, polylines[], boundaries[], holes[] }
    for (const seg of rawDataSegments) {
        if (!seg || seg.length === 0) continue;
        if (seg.isDuongLo) continue;  // mine-path lines — render only, never mesh
        const via  = seg.viaName     || '__default__';
        const ft   = seg.featureType || '__other__';
        const blk  = seg.blockName   || '__default__';
        const key  = `${via}||${blk}||${ft}`;
        if (!groups.has(key)) {
            groups.set(key, { viaName: seg.viaName || null, featureType: seg.featureType || null, blockName: seg.blockName || null, polylines: [], boundaries: [], holes: [], breaklines: [], scatter: [] });
        }
        const g = groups.get(key);
        const poly = seg.map(v => [v.x, v.y, v.z]);
        if (seg.isBoundary)       g.boundaries.push(poly);
        else if (seg.isHole)      g.holes.push(poly);
        else if (seg.isBreakLine) g.breaklines.push(poly);
        else if (seg.isBemat) {
            if (poly.length === 1) {
                // True single-point elevation measurement → scatter (free vertex, no constraints).
                g.scatter.push(poly[0]);
            } else {
                // Multi-vertex Bề mặt polyline → treat as a contour line with edge constraints.
                g.polylines.push(poly);
            }
        } else g.polylines.push(poly);
    }

    // For groups with no boundary, synthesise a convex hull boundary from all
    // their XY vertices, padded slightly outward, so the C++ mesher can still run.
    // Exception: groups with ONLY breaklines (e.g. Đứt gãy fault lines) are never
    // triangulated — they exist solely as cutting tools for polyline_split.
    for (const g of groups.values()) {
        if (g.boundaries.length > 0) continue;
        if (g.polylines.length === 0 && g.scatter.length === 0) continue; // fault-only, skip
        // Collect all XY points + Z for this group.
        const pts = [];
        let minZ = Infinity, maxZ = -Infinity;
        const addPt = (x, y, z) => {
            pts.push([x, y, z]);
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        };
        for (const poly of g.polylines)  for (const v of poly) addPt(v[0], v[1], v[2]);
        for (const bl  of g.breaklines)  for (const v of bl)   addPt(v[0], v[1], v[2]);
        for (const pt  of g.scatter)                           addPt(pt[0], pt[1], pt[2]);
        if (pts.length < 3) continue; // not enough points — skip

        // --- 2-D convex hull (gift-wrapping / Jarvis march) ---
        // Returns indices into pts[] in counter-clockwise order.
        const cross2 = (o, a, b) => (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
        // Start from leftmost point.
        let start = 0;
        for (let i = 1; i < pts.length; i++)
            if (pts[i][0] < pts[start][0] || (pts[i][0] === pts[start][0] && pts[i][1] < pts[start][1]))
                start = i;
        const hull = [];
        let cur = start;
        do {
            hull.push(cur);
            let next = (cur + 1) % pts.length;
            for (let i = 0; i < pts.length; i++) {
                const c = cross2(pts[cur], pts[next], pts[i]);
                if (c < 0 || (c === 0 &&
                    (pts[i][0]-pts[cur][0])**2 + (pts[i][1]-pts[cur][1])**2 >
                    (pts[next][0]-pts[cur][0])**2 + (pts[next][1]-pts[cur][1])**2))
                    next = i;
            }
            cur = next;
        } while (cur !== start && hull.length <= pts.length);

        if (hull.length < 3) continue;

        // Pad each hull vertex outward from the centroid.
        const cx = hull.reduce((s, i) => s + pts[i][0], 0) / hull.length;
        const cy = hull.reduce((s, i) => s + pts[i][1], 0) / hull.length;
        // Compute a sensible pad: 1% of bounding-box diagonal, minimum 5 m.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const i of hull) {
            if (pts[i][0] < minX) minX = pts[i][0]; if (pts[i][0] > maxX) maxX = pts[i][0];
            if (pts[i][1] < minY) minY = pts[i][1]; if (pts[i][1] > maxY) maxY = pts[i][1];
        }
        const diag = Math.sqrt((maxX-minX)**2 + (maxY-minY)**2);
        const pad  = Math.max(diag * 0.01, 5);
        // Use the highest Z from breaklines as the hull boundary Z so the outer
        // skirt slopes down naturally from the highest surveyed edge.
        // Fall back to overall maxZ if no breaklines exist in this group.
        let hullZ = -Infinity;
        for (const bl of g.breaklines) for (const v of bl) if (v[2] > hullZ) hullZ = v[2];
        if (hullZ === -Infinity) hullZ = maxZ;

        const boundary = hull.map(i => {
            const dx = pts[i][0] - cx, dy = pts[i][1] - cy;
            const len = Math.sqrt(dx*dx + dy*dy) || 1;
            return [pts[i][0] + dx/len*pad, pts[i][1] + dy/len*pad, hullZ];
        });
        g.boundaries.push(boundary);
        console.log(`[CGAL] No boundary for "${g.viaName}/${g.blockName}/${g.featureType}" — convex hull auto-boundary (${hull.length} pts, pad=${pad.toFixed(1)}m)`);
    }

    const meshableGroups = [...groups.values()]
        .filter(g => g.boundaries.length > 0);
    if (meshableGroups.length === 0) {
        alert('No meshable data found — no polylines, breaklines, or scatter points in any group.');
        return;
    }

    // For polyline_split: build a per-(viaName, blockName) map of fault breaklines.
    // A fault only cuts the surface groups it belongs to — other blocks are meshed
    // normally so unrelated parts of the map are never touched.
    const faultByViaBlock = new Map(); // "via||block" → [fault polylines]
    if (opts.action === 'polyline_split') {
        for (const g of groups.values()) {
            if (g.polylines.length === 0 && g.scatter.length === 0 && g.boundaries.length === 0
                    && g.breaklines.length > 0) {
                const key = `${g.viaName || '__default__'}||${g.blockName || '__default__'}`;
                if (!faultByViaBlock.has(key)) faultByViaBlock.set(key, []);
                faultByViaBlock.get(key).push(...g.breaklines);
            }
        }
        if (faultByViaBlock.size === 0) {
            alert('No fault breaklines (Đứt gãy) found — add IsBreakline segments to the dataset.');
            return;
        }
    }

    const t0 = performance.now();
    let results;
    try {
        results = await Promise.all(meshableGroups.map(async g => {
            const payload = { polylines: g.polylines, boundaries: g.boundaries };
            if (g.holes.length > 0) payload.holes = g.holes;
            // Regular breaklines stay as CDT constraints (BRLINE tokens).
            if (g.breaklines.length > 0) payload.breaklines = g.breaklines;

            // For polyline_split: only inject fault breaklines that share this
            // group's viaName + blockName.  Groups with no matching fault fall back
            // to normal CDT meshing so they are left uncut.
            const groupKey = `${g.viaName || '__default__'}||${g.blockName || '__default__'}`;
            const matchingFaults = opts.action === 'polyline_split'
                ? (faultByViaBlock.get(groupKey) || []) : [];
            if (matchingFaults.length > 0) payload.fault_lines = matchingFaults;

            const groupAction = (opts.action === 'polyline_split' && matchingFaults.length > 0)
                ? 'polyline_split' : (opts.action || 'mesh');

            if (g.scatter.length > 0) payload.scatter = g.scatter;
            if (typeof opts.slope === 'number' && opts.slope >= 0) payload.slope = opts.slope;
            payload.action = groupAction;
            if (Array.isArray(opts.clip_plane))                     payload.clip_plane = opts.clip_plane;
            const resp = await fetch('/api/mesh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || resp.statusText);
            return { data, viaName: g.viaName, featureType: g.featureType, blockName: g.blockName };
        }));
    } catch (e) {
        console.error('CGAL mesh request failed:', e);
        alert('CGAL mesh failed: ' + e.message);
        return;
    }
    const dt = performance.now() - t0;

    results.forEach(({ data, viaName, featureType, blockName }) => {
        console.log(`[CGAL-CDT] via="${viaName}" featureType=${featureType} block="${blockName}"`,
 {
            contours: data.num_contours,
            boundaries: data.num_boundaries,
            orphan_contours: data.num_orphan_contours,
            meshes: data.num_meshes,
            elapsed_ms: data.elapsed_ms,
        });
        (data.meshes || []).forEach((m, i) => {
            console.log(`  boundary ${i}: ${m.num_contours} contours, ${m.num_vertices} verts, ${m.num_triangles} tris (dropped_slope=${m.dropped_slope})`);
        });
    });
    console.log(`[CGAL-CDT] total roundtrip ${Math.round(dt)} ms`);

    renderMeshes(results, meshGroup);

    // Draw hole polygon outlines in white so they're visible in the scene.
    for (const g of meshableGroups) {
        for (const holePoly of g.holes) {
            const pts = new Float32Array(holePoly.length * 3);
            for (let i = 0; i < holePoly.length; i++) {
                pts[i * 3 + 0] = holePoly[i][0];
                pts[i * 3 + 1] = holePoly[i][1];
                pts[i * 3 + 2] = holePoly[i][2];
            }
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
            const mat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false });
            const loop = new THREE.LineLoop(geom, mat);
            loop.name = `Hole_${g.featureType}`;
            loop.userData.featureType = g.featureType;
            cgalGroup.add(loop);
        }
    }

    //clampTruToVach(cgalGroup);
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

    for (const { data, viaName, featureType, blockName } of results) {
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
            if (viaName)     mesh.userData.viaName     = viaName;
            if (featureType) mesh.userData.featureType = featureType;
            if (blockName)   mesh.userData.blockName   = blockName;
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

        // Nearest Vách by XY centroid — only consider Vách meshes in the same
        // viaName + blockName group so multi-block datasets don't cross-pair.
        const truVia   = truMesh.userData.viaName;
        const truBlock = truMesh.userData.blockName;

        const truBox    = new THREE.Box3().setFromObject(truMesh);
        const truCenter = truBox.getCenter(new THREE.Vector3());

        let bestVach = null, bestDist = Infinity;
        vachMeshes.forEach(v => {
            if (v.userData.viaName !== truVia || v.userData.blockName !== truBlock) return;
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

            // Pre-check: ALL 3 vertices must have a valid Vách hit before clamping
            // anything. If even one vertex is under the hole (no hit), skip this
            // triangle entirely — partial clamping would create new tent triangles.
            const tris = [[i0, waP], [i1, wbP], [i2, wcP]];
            const vertHits = tris.map(([, wv]) => {
                origin.set(wv.x, wv.y, wv.z - 5000);
                raycaster.set(origin, UP);
                const h = raycaster.intersectObject(bestVach, false);
                return h.length > 0 ? h[0].point.z : null;
            });
            if (vertHits.some(z => z === null)) continue; // hole underneath — skip

            for (let vi = 0; vi < tris.length; vi++) {
                const [vertIdx, wv] = tris[vi];
                const worldVachZ = vertHits[vi];
                if (wv.z <= worldVachZ - 0.01) continue; // this vertex already fine
                clampPt.set(wv.x, wv.y, worldVachZ - 0.01).applyMatrix4(mwi);
                pos.setZ(vertIdx, clampPt.z);
                if (rawVerts && rawVerts[vertIdx]) rawVerts[vertIdx][2] = clampPt.z;
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
