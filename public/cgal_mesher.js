// Browser-side CGAL mesher.
// Sends contour and boundary polylines to /api/mesh; receives one mesh per
// boundary (every triangle lies strictly inside its boundary polygon).

import * as THREE from 'three';

let cgalGroup = null;
let pendingWarnings        = [];  // bad contour lines from last mesh run
let pendingZOutliers       = [];  // Z-spike segments detected at data-load time
let pendingScatterSuspects = [];  // elevation points whose Z is outside the contour Z range
let pendingScatterTooSteep = [];  // elevation points that would cause slope-filter holes near a breakline

function setupIssueExport() {
    const btn = document.getElementById('export-issues-btn');
    if (!btn || btn._wired) return;
    btn._wired = true;
    btn.addEventListener('click', () => {
        if (pendingWarnings.length === 0 && pendingZOutliers.length === 0 && pendingScatterSuspects.length === 0) return;
        const lines = [];
        if (pendingZOutliers.length > 0) {
            lines.push('=== Z-OUTLIER VERTICES (unset Z / Z=0 — fix in CAD source) ===\n');
            pendingZOutliers.forEach(({ viaName, blockName, featureType, handle, layer, segZ, outliers }) => {
                const meta  = [
                    handle      ? `Handle: ${handle}` : null,
                    layer       ? `Layer: ${layer}`   : null,
                    viaName     ? `via: ${viaName}`   : null,
                    blockName   ? `block: ${blockName}` : null,
                    featureType ? `type: ${featureType}` : null,
                ].filter(Boolean).join('  |  ');
                const allBad = outliers.every(v => v[2] === segZ);
                if (allBad && segZ === 0) {
                    const xy = `x=${outliers[0][0].toFixed(3)}, y=${outliers[0][1].toFixed(3)}`;
                    lines.push(`ENTITY_AT_Z0: entire polyline at Z=0  first_vertex=(${xy})  |  ${meta}`);
                } else {
                    const badZ = outliers.map(v => v[2].toFixed(3)).join(', ');
                    const xy   = `x=${outliers[0][0].toFixed(3)}, y=${outliers[0][1].toFixed(3)}`;
                    lines.push(`SPIKE: seg_z=${segZ?.toFixed(3) ?? '?'}  bad_z=[${badZ}]  at=(${xy})  |  ${meta}`);
                }
            });
            lines.push('');
        }
        if (pendingScatterTooSteep.length > 0) {
            lines.push('=== SCATTER POINTS TOO STEEP vs BREAKLINE (likely causing slope holes — use Mesh Strict to remove) ===\n');
            pendingScatterTooSteep.forEach(({ x, y, z, bx, by, bz, slope, slopeThreshold, handle, layer, viaName, blockName, featureType }) => {
                const meta = [
                    handle      ? `Handle: ${handle}`    : null,
                    layer       ? `Layer: ${layer}`      : null,
                    viaName     ? `via: ${viaName}`      : null,
                    blockName   ? `block: ${blockName}`  : null,
                    featureType ? `type: ${featureType}` : null,
                ].filter(Boolean).join('  |  ');
                lines.push(`SCATTER_TOO_STEEP: z=${z.toFixed(3)}  slope_to_nearest_breakline=${slope.toFixed(2)} (threshold=${slopeThreshold})  at=(x=${x.toFixed(3)}, y=${y.toFixed(3)})  nearest_breakline=(x=${bx.toFixed(3)}, y=${by.toFixed(3)}, z=${bz.toFixed(3)})  |  ${meta}`);
            });
            lines.push('');
        }
        if (pendingScatterSuspects.length > 0) {
            lines.push('=== SCATTER POINT Z SUSPECTS (Bề mặt elevation points outside contour Z range — may cause slope holes) ===\n');
            pendingScatterSuspects.forEach(({ x, y, z, median, zLow, zHigh, deviation, handle, layer, viaName, blockName, featureType }) => {
                const meta = [
                    handle      ? `Handle: ${handle}`    : null,
                    layer       ? `Layer: ${layer}`      : null,
                    viaName     ? `via: ${viaName}`      : null,
                    blockName   ? `block: ${blockName}`  : null,
                    featureType ? `type: ${featureType}` : null,
                ].filter(Boolean).join('  |  ');
                lines.push(`SCATTER_SUSPECT: z=${z.toFixed(3)}  dev=${deviation.toFixed(3)}m_outside_fence  (median=${median.toFixed(3)}, valid=[${zLow.toFixed(3)}, ${zHigh.toFixed(3)}])  at=(x=${x.toFixed(3)}, y=${y.toFixed(3)})  |  ${meta}`);
            });
            lines.push('');
        }
        if (pendingWarnings.length > 0) {
            lines.push('=== BAD CONTOUR LINES (orphan / leaking outside boundary) ===\n');
            pendingWarnings.forEach(({ viaName, featureType, blockName, w }) => {
                const type = w.boundary_idx === -1 ? 'ORPHAN' : `LEAKS (${w.outside_verts}/${w.total_verts} verts outside boundary)`;
                lines.push(`${type}: line with z = ${w.first_vertex[2].toFixed(3)}  [via: ${viaName ?? '?'}, block: ${blockName ?? '?'}, type: ${featureType ?? 'unknown'}]`);
            });
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'cgal_line_issues.txt';
        a.click();
        URL.revokeObjectURL(a.href);
    });
}

/**
 * Call this immediately after data is loaded (before meshing) so the
 * Export Issues button appears as soon as the JSON is uploaded.
 */
export function checkZOutliers(segments) {
    pendingZOutliers = [];
    for (const seg of segments) {
        if (seg.zOutliers && seg.zOutliers.length > 0) {
            pendingZOutliers.push({
                viaName:     seg.viaName     ?? null,
                blockName:   seg.blockName   ?? null,
                featureType: seg.featureType ?? null,
                handle:      seg.handle      ?? null,
                layer:       seg.layer       ?? null,
                segZ:        seg[0]?.z       ?? null,
                outliers:    seg.zOutliers,
            });
        }
    }
    if (pendingZOutliers.length > 0)
        console.warn(`[Z-outlier] ${pendingZOutliers.length} segment(s) with anomalous Z vertices. Click "Export Issues" to get the list.`);
    setupIssueExport();
    const issueBtn = document.getElementById('export-issues-btn');
    if (issueBtn) issueBtn.style.display = pendingZOutliers.length > 0 ? '' : 'none';
    return pendingZOutliers.length;
}

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
        const via  = seg.viaName     || '__default__';
        const ft   = seg.featureType || '__other__';
        const blk  = seg.blockName   || '__default__';
        const key  = `${via}||${blk}||${ft}`;
        if (!groups.has(key)) {
            groups.set(key, { viaName: seg.viaName || null, featureType: seg.featureType || null, blockName: seg.blockName || null, polylines: [], boundaries: [], holes: [], breaklines: [], scatter: [], scatterMeta: [] });
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
                g.scatterMeta.push({ handle: seg.handle ?? null, layer: seg.layer ?? null, viaName: seg.viaName ?? null, blockName: seg.blockName ?? null, featureType: seg.featureType ?? null });
            } else {
                // Multi-vertex Bề mặt polyline → treat as a contour line with edge constraints.
                g.polylines.push(poly);
            }
        } else                    g.polylines.push(poly);
    }

    const meshableGroups = [...groups.values()].filter(g => g.boundaries.length > 0);
    if (meshableGroups.length === 0) {
        alert('No IsBoundary loops found in the data. Boundary lines are required — mesh generation is confined to the inside of each boundary.');
        return;
    }

    setupIssueExport();
    pendingWarnings        = [];
    pendingZOutliers       = [];
    pendingScatterSuspects = [];
    pendingScatterTooSteep = [];

    const slopeThreshold = (typeof opts.slope === 'number' && opts.slope >= 0) ? opts.slope : 100.0;

    // Scatter-vs-breakline steep check:
    // A scatter point whose Z-rise relative to its nearest breakline vertex exceeds
    // the slope threshold will inevitably create slope-rejected triangles → holes.
    // Flag those points; in strict mode, remove them from the payload entirely.
    for (const g of meshableGroups) {
        if (g.scatter.length === 0 || g.breaklines.length === 0) continue;
        // Flatten all breakline vertices for this group.
        const blVerts = [];
        for (const bl of g.breaklines) for (const v of bl) blVerts.push(v);
        if (blVerts.length === 0) continue;
        for (let i = 0; i < g.scatter.length; i++) {
            const [sx, sy, sz] = g.scatter[i];
            // Find nearest breakline vertex by XY distance.
            let bestD2 = Infinity, bestV = null;
            for (const v of blVerts) {
                const dx = v[0] - sx, dy = v[1] - sy;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD2) { bestD2 = d2; bestV = v; }
            }
            if (!bestV || bestD2 === 0) continue;
            const dXY   = Math.sqrt(bestD2);
            const slope = Math.abs(sz - bestV[2]) / dXY;
            if (slope > slopeThreshold) {
                const m = g.scatterMeta[i] ?? {};
                g.scatterMeta[i] = { ...m, tooSteep: true };
                pendingScatterTooSteep.push({
                    x: sx, y: sy, z: sz,
                    bx: bestV[0], by: bestV[1], bz: bestV[2],
                    slope, slopeThreshold,
                    handle: m.handle ?? null, layer: m.layer ?? null,
                    viaName: m.viaName ?? null, blockName: m.blockName ?? null, featureType: m.featureType ?? null,
                });
            }
        }
    }
    if (pendingScatterTooSteep.length > 0)
        console.warn(`[scatter] ${pendingScatterTooSteep.length} elevation point(s) too steep vs nearest breakline — likely causing holes. Click "Export Issues" to see handles.${opts.strict ? ' (strict mode: removed from payload)' : ' Run "Mesh Strict" to remove them.'}`);

    // the 3×IQR fence of the contour Z values in the same group.  Those points
    // create triangles that exceed the slope threshold → visible holes.
    for (const g of meshableGroups) {
        if (g.scatter.length === 0) continue;
        const contourZs = [];
        for (const poly of g.polylines) for (const v of poly) contourZs.push(v[2]);
        if (contourZs.length < 4) continue;
        contourZs.sort((a, b) => a - b);
        const _q1  = contourZs[Math.floor(contourZs.length * 0.25)];
        const _q3  = contourZs[Math.floor(contourZs.length * 0.75)];
        const _iqr = _q3 - _q1;
        const zLow  = _q1 - 3 * _iqr;
        const zHigh = _q3 + 3 * _iqr;
        const median = contourZs[Math.floor(contourZs.length * 0.5)];
        for (let i = 0; i < g.scatter.length; i++) {
            const [sx, sy, sz] = g.scatter[i];
            const outsideLow  = sz < zLow;
            const outsideHigh = sz > zHigh;
            // Only flag if the deviation is more than 5 units beyond the fence
            // to avoid false positives on points that merely graze the boundary.
            const minAbsDev = 5.0;
            const deviation = outsideLow ? (zLow - sz) : outsideHigh ? (sz - zHigh) : 0;
            if ((outsideLow || outsideHigh) && deviation >= minAbsDev) {
                const m = g.scatterMeta[i] ?? {};
                pendingScatterSuspects.push({ x: sx, y: sy, z: sz, median, zLow, zHigh, deviation,
                    handle: m.handle ?? null, layer: m.layer ?? null,
                    viaName: m.viaName ?? null, blockName: m.blockName ?? null, featureType: m.featureType ?? null });
            }
        }
    }
    if (pendingScatterSuspects.length > 0)
        console.warn(`[scatter] ${pendingScatterSuspects.length} elevation point(s) with Z outside contour range — likely causing slope holes. Click "Export Issues".`);

    // Collect Z-outlier segments flagged during data load.
    for (const seg of rawDataSegments) {
        if (seg.zOutliers && seg.zOutliers.length > 0) {
            pendingZOutliers.push({
                viaName:     seg.viaName     ?? null,
                blockName:   seg.blockName   ?? null,
                featureType: seg.featureType ?? null,
                handle:      seg.handle      ?? null,
                layer:       seg.layer       ?? null,
                segZ:        seg[0]?.z       ?? null,
                outliers:    seg.zOutliers,
            });
        }
    }
    if (pendingZOutliers.length > 0)
        console.warn(`[Z-outlier] ${pendingZOutliers.length} segment(s) with anomalous Z vertices (vertical spikes). Click "Export Issues" to get the list.`);

    const t0 = performance.now();
    let results;
    try {
        results = await Promise.all(meshableGroups.map(async g => {
            const payload = { polylines: g.polylines, boundaries: g.boundaries };
            if (g.holes.length > 0)       payload.holes      = g.holes;
            if (g.breaklines.length > 0)  payload.breaklines = g.breaklines;
            // In strict mode, drop scatter points flagged as too steep vs a breakline.
            const filteredScatter = opts.strict
                ? g.scatter.filter((_, i) => !g.scatterMeta[i]?.tooSteep)
                : g.scatter;
            if (filteredScatter.length > 0) payload.scatter = filteredScatter;
            if (typeof opts.slope === 'number' && opts.slope >= 0) payload.slope = opts.slope;
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
            warnings: data.num_warnings,
            elapsed_ms: data.elapsed_ms,
        });
        (data.meshes || []).forEach((m, i) => {
            console.log(`  boundary ${i}: ${m.num_contours} contours, ${m.num_vertices} verts, ${m.num_triangles} tris (dropped_slope=${m.dropped_slope}, slope_threshold=${m.slope_used})`);
        });

        // Report bad contour lines so the data team can locate and fix them.
        if (data.warnings && data.warnings.length > 0) {
            console.warn(`[CGAL] ⚠ ${data.warnings.length} bad contour(s) in via="${viaName}" block="${blockName}" type="${featureType}":`);
            data.warnings.forEach(w => {
                const type = w.boundary_idx === -1 ? 'ORPHAN' : `LEAKS(${w.outside_verts}/${w.total_verts})`;
                console.warn(`  ${type}  z=${w.first_vertex[2].toFixed(3)}`);
                pendingWarnings.push({ viaName, featureType, blockName, w });
            });
        }
    });
    console.log(`[CGAL-CDT] total roundtrip ${Math.round(dt)} ms`);
    const issueBtn = document.getElementById('export-issues-btn');
    if (issueBtn) issueBtn.style.display = (pendingWarnings.length > 0 || pendingZOutliers.length > 0 || pendingScatterSuspects.length > 0 || pendingScatterTooSteep.length > 0) ? '' : 'none';

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
