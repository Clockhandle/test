import * as THREE from 'three';
import { uniformStitch } from './stitcher.js';

// ─── Volume calculation ──────────────────────────────────────────────────────

/**
 * Computes the volume of each closed Via solid using the divergence theorem:
 *   V = (1/6) | Σ v0 · (v1 × v2) |  over all triangles of the closed surface.
 *
 * Orientation rules:
 *   • Vách (roof)   — CGAL CDT gives +Z normals → outward for a roof → no flip.
 *   • Trụ  (floor)  — CGAL CDT gives +Z normals → inward for a floor → flip winding.
 *   • Side walls    — auto-detect: try both orientations, keep the larger |V|.
 */
export function computeViaSolidVolumes(meshGroup) {
    const cgalGroup  = meshGroup.getObjectByName('CGAL_Meshes');
    const solidGroup = meshGroup.getObjectByName('Via_Solid');

    if (!cgalGroup || !solidGroup) {
        alert('Build the Via Solid first (click "Via Solid").');
        return;
    }

    const vachMeshes = [], truMeshes = [];
    cgalGroup.traverse(obj => {
        if (!(obj instanceof THREE.Mesh)) return;
        if (obj.userData.featureType === 'vach') vachMeshes.push(obj);
        if (obj.userData.featureType === 'tru')  truMeshes.push(obj);
    });

    const sidewalls = [];
    solidGroup.traverse(obj => {
        if (obj instanceof THREE.Mesh && obj.name.startsWith('Via_SideWall_')) sidewalls.push(obj);
    });

    if (vachMeshes.length === 0 || truMeshes.length === 0) {
        alert('No Vách / Trụ meshes found inside CGAL_Meshes group.');
        return;
    }

    const pairs = matchByXYCentroid(vachMeshes, truMeshes);
    const lines = [];
    let totalVol = 0;

    pairs.forEach(({ vach, tru }, idx) => {
        const wall = sidewalls[idx];
        if (!wall) {
            lines.push(`Solid ${idx + 1}: ⚠ no side wall — run "Via Solid" first`);
            return;
        }

        const V_vach = _signedVol(vach.geometry, false);
        const V_tru  = _signedVol(tru.geometry,  true);
        const V_wall_fwd = _signedVol(wall.geometry, false);
        const V_wall_rev = _signedVol(wall.geometry, true);

        const V_fwd = V_vach + V_tru + V_wall_fwd;
        const V_rev = V_vach + V_tru + V_wall_rev;
        const V     = Math.abs(V_fwd) >= Math.abs(V_rev) ? V_fwd : V_rev;
        const vol   = Math.abs(V);

        totalVol += vol;

        const wallNote = Math.abs(V_fwd) >= Math.abs(V_rev) ? '' : ' (wall winding flipped)';
        lines.push(`Solid ${idx + 1}:  ${vol.toLocaleString(undefined, { maximumFractionDigits: 2 })} cu  [roof ${_fmt(Math.abs(V_vach))} + floor ${_fmt(Math.abs(V_tru))} + walls ${_fmt(Math.abs(Math.abs(V_fwd) >= Math.abs(V_rev) ? V_wall_fwd : V_wall_rev))}]${wallNote}`);
        console.log(`[Via Volume] Solid ${idx + 1}: V_vach=${V_vach.toFixed(2)}, V_tru=${V_tru.toFixed(2)}, V_wall_best=${(Math.abs(V_fwd) >= Math.abs(V_rev) ? V_wall_fwd : V_wall_rev).toFixed(2)}  → ${vol.toFixed(2)}`);
    });

    lines.push('─────────────────────────────');
    lines.push(`Total:  ${totalVol.toLocaleString(undefined, { maximumFractionDigits: 2 })} cu`);

    alert(lines.join('\n'));
    console.log('[Via Volume]\n' + lines.join('\n'));
}

/**
 * Signed volume of a BufferGeometry using the divergence theorem.
 * flipWinding swaps v1↔v2 on every triangle, effectively flipping all normals.
 */
function _signedVol(geom, flipWinding) {
    const pos = geom.attributes.position;
    const idx = geom.index;
    const a   = new THREE.Vector3();
    const b   = new THREE.Vector3();
    const c   = new THREE.Vector3();
    let V = 0;

    const count = idx ? idx.count : pos.count;
    for (let i = 0; i < count; i += 3) {
        const i0 = idx ? idx.getX(i)     : i;
        const i1 = idx ? idx.getX(i + 1) : i + 1;
        const i2 = idx ? idx.getX(i + 2) : i + 2;

        a.fromBufferAttribute(pos, i0);
        b.fromBufferAttribute(pos, flipWinding ? i2 : i1);
        c.fromBufferAttribute(pos, flipWinding ? i1 : i2);

        V += a.dot(b.clone().cross(c));
    }
    return V / 6;
}

function _fmt(n) { return n.toLocaleString(undefined, { maximumFractionDigits: 1 }); }

// ─── Entry point ────────────────────────────────────────────────────────────

export function buildViaSolid(meshGroup) {
    const cgalGroup = meshGroup.getObjectByName('CGAL_Meshes');
    if (!cgalGroup) {
        alert('No CGAL meshes found. Generate Vách and Trụ meshes first.');
        return;
    }

    // Collect meshes by type (skip wireframe children which are LineSegments)
    const vachMeshes = [];
    const truMeshes  = [];
    cgalGroup.traverse(obj => {
        if (!(obj instanceof THREE.Mesh)) return;
        if (obj.userData.featureType === 'vach') vachMeshes.push(obj);
        if (obj.userData.featureType === 'tru')  truMeshes.push(obj);
    });

    if (vachMeshes.length === 0 || truMeshes.length === 0) {
        alert(`Need both Vách and Trụ meshes.\nFound: ${vachMeshes.length} Vách, ${truMeshes.length} Trụ.`);
        return;
    }

    // Remove previous solid group
    const oldGroup = meshGroup.getObjectByName('Via_Solid');
    if (oldGroup) {
        oldGroup.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material)  o.material.dispose();
        });
        meshGroup.remove(oldGroup);
    }

    const solidGroup = new THREE.Group();
    solidGroup.name = 'Via_Solid';
    meshGroup.add(solidGroup);

    // Match each Vách mesh to the nearest Trụ mesh by XY centroid
    const pairs = matchByXYCentroid(vachMeshes, truMeshes);
    console.log(`[Via Solid] Matched ${pairs.length} Vách↔Trụ pairs`);

    let stitchedCount = 0;
    for (const { vach, tru, dist } of pairs) {
        console.log(`  Pairing (XY centroid dist = ${dist.toFixed(1)})`);

        const vachLoops = extractBoundaryLoops(vach.userData.rawVertices, vach.userData.rawTriangles);
        const truLoops  = extractBoundaryLoops(tru.userData.rawVertices,  tru.userData.rawTriangles);

        console.log(`    Vách loops: ${vachLoops.map(l => l.length).join(', ')}`);
        console.log(`    Trụ  loops: ${truLoops.map(l => l.length).join(', ')}`);

        if (vachLoops.length === 0 || truLoops.length === 0) {
            console.warn('    Skipping — no border loop extracted.');
            continue;
        }

        const vachLoop = longestLoop(vachLoops);
        const truLoop  = longestLoop(truLoops);

        drawDebugLoop(vachLoop, 0xff6600, solidGroup, 'Vach_Border');
        drawDebugLoop(truLoop,  0x00ccff, solidGroup, 'Tru_Border');

        // Log whether each loop closed back to start
        const vachClosed = isLoopClosed(vachLoop, vach.userData.rawVertices, vach.userData.rawTriangles);
        const truClosed  = isLoopClosed(truLoop,  tru.userData.rawVertices,  tru.userData.rawTriangles);
        console.log(`    Vách loop closed: ${vachClosed} (${vachLoop.length} verts)`);
        console.log(`    Trụ  loop closed: ${truClosed}  (${truLoop.length} verts)`);

        // ── Side-wall stitching ──────────────────────────────────────────
        const sideGeom = stitchClosedLoops(vachLoop, truLoop);
        if (sideGeom) {
            const mat = new THREE.MeshStandardMaterial({
                color: 0x888888,
                side: THREE.DoubleSide,
                flatShading: true,
                roughness: 0.85,
                metalness: 0.0,
            });
            const sideMesh = new THREE.Mesh(sideGeom, mat);
            sideMesh.name  = `Via_SideWall_${stitchedCount}`;
            solidGroup.add(sideMesh);
            stitchedCount++;
        }
    }

    console.log(`[Via Solid] Done — ${stitchedCount} side wall(s) built.`);
    if (stitchedCount === 0) alert('Side-wall stitching produced no geometry. Check console for details.');
}

// ─── Border extraction ───────────────────────────────────────────────────────

/**
 * Returns an array of vertex loops (each loop = ordered THREE.Vector3[]).
 * A loop is formed by edges that belong to exactly one triangle (boundary edges).
 * There may be multiple loops if the mesh has interior holes.
 */
function extractBoundaryLoops(rawVertices, rawTriangles) {
    if (!rawVertices || !rawTriangles) return [];

    // Count how many triangles share each edge
    const edgeCount = new Map();
    for (const tri of rawTriangles) {
        const [a, b, c] = tri;
        for (const [i, j] of [[a, b], [b, c], [c, a]]) {
            const key = i < j ? `${i}_${j}` : `${j}_${i}`;
            edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
        }
    }

    // Build adjacency from boundary (count===1) edges
    const adj = new Map();
    for (const [key, count] of edgeCount) {
        if (count !== 1) continue;
        const [a, b] = key.split('_').map(Number);
        if (!adj.has(a)) adj.set(a, []);
        if (!adj.has(b)) adj.set(b, []);
        adj.get(a).push(b);
        adj.get(b).push(a);
    }

    // Walk connected components — each component is one loop
    const loops = [];
    const globalVisited = new Set();

    for (const startVert of adj.keys()) {
        if (globalVisited.has(startVert)) continue;

        const loop = [];
        let current = startVert;
        let prev = -1;

        // Walk until we can't advance or close back to start
        while (true) {
            loop.push(current);
            globalVisited.add(current);
            const neighbors = adj.get(current) || [];
            // Prefer an unvisited neighbor; accept start only if we've gone around
            let next = -1;
            for (const n of neighbors) {
                if (n === prev) continue;
                if (!globalVisited.has(n)) { next = n; break; }
            }
            if (next === -1) break; // dead-end or fully closed
            prev = current;
            current = next;
        }

        if (loop.length >= 3) {
            loops.push(loop.map(idx => {
                const v = rawVertices[idx];
                return new THREE.Vector3(v[0], v[1], v[2]);
            }));
        }
    }

    return loops;
}

/** Returns true if the loop end-vertex has a boundary-edge back to the start vertex. */
function isLoopClosed(loop, rawVertices, rawTriangles) {
    if (loop.length < 3) return false;
    // The loop is considered closed if start and end are within a tiny XY distance
    const start = loop[0];
    const end   = loop[loop.length - 1];
    return Math.hypot(start.x - end.x, start.y - end.y, start.z - end.z) < 1e-6
        || _borderEdgeExists(rawVertices, rawTriangles, start, end);
}

function _borderEdgeExists(rawVertices, rawTriangles, ptA, ptB) {
    // Find vertex indices matching ptA and ptB (by position)
    const findIdx = pt => {
        for (let i = 0; i < rawVertices.length; i++) {
            const v = rawVertices[i];
            if (Math.abs(v[0] - pt.x) < 1e-9 && Math.abs(v[1] - pt.y) < 1e-9) return i;
        }
        return -1;
    };
    const ia = findIdx(ptA);
    const ib = findIdx(ptB);
    if (ia === -1 || ib === -1) return false;
    const key = ia < ib ? `${ia}_${ib}` : `${ib}_${ia}`;
    let count = 0;
    for (const tri of rawTriangles) {
        const [a, b, c] = tri;
        for (const [i, j] of [[a, b], [b, c], [c, a]]) {
            const k = i < j ? `${i}_${j}` : `${j}_${i}`;
            if (k === key) count++;
        }
    }
    return count === 1;
}

// ─── Matching & helpers ──────────────────────────────────────────────────────

function longestLoop(loops) {
    return loops.reduce((best, l) => l.length > best.length ? l : best, loops[0]);
}

function matchByXYCentroid(vachList, truList) {
    const centroid = meshObj => {
        const pos = meshObj.geometry.attributes.position;
        let sx = 0, sy = 0;
        for (let i = 0; i < pos.count; i++) { sx += pos.getX(i); sy += pos.getY(i); }
        return { x: sx / pos.count, y: sy / pos.count };
    };

    const pairs = [];
    const usedTru = new Set();

    for (const vach of vachList) {
        const vc = centroid(vach);
        let bestIdx = -1, bestDist = Infinity;
        truList.forEach((tru, ti) => {
            if (usedTru.has(ti)) return;
            const tc = centroid(tru);
            const d  = Math.hypot(vc.x - tc.x, vc.y - tc.y);
            if (d < bestDist) { bestDist = d; bestIdx = ti; }
        });
        if (bestIdx !== -1) {
            pairs.push({ vach, tru: truList[bestIdx], dist: bestDist });
            usedTru.add(bestIdx);
        }
    }
    return pairs;
}

// ─── Closed-loop stitching ───────────────────────────────────────────────────

/**
 * Stitches two closed border loops into a side-wall mesh.
 * Aligns loopB to start at the vertex closest to loopA[0], then closes
 * both loops and calls uniformStitch.
 */
function stitchClosedLoops(loopA, loopB) {
    if (loopA.length < 3 || loopB.length < 3) return null;

    // Find the vertex in loopB closest to loopA[0] in XY and rotate loopB there
    let bestJ = 0, bestDist = Infinity;
    for (let j = 0; j < loopB.length; j++) {
        const d = Math.hypot(loopA[0].x - loopB[j].x, loopA[0].y - loopB[j].y);
        if (d < bestDist) { bestDist = d; bestJ = j; }
    }
    const alignedB = [...loopB.slice(bestJ), ...loopB.slice(0, bestJ)];

    // Close by appending the start vertex — uniformStitch handles it as an open polyline
    const closedA = [...loopA, loopA[0].clone()];
    const closedB = [...alignedB, alignedB[0].clone()];

    return uniformStitch(closedA, closedB, 20.0);
}

// ─── Debug visualisation ─────────────────────────────────────────────────────

function drawDebugLoop(loop, color, group, name) {
    if (loop.length === 0) return;
    // Close the visual loop
    const points = [...loop, loop[0].clone()];
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const mat  = new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, linewidth: 2 });
    const line = new THREE.Line(geom, mat);
    line.name = name || 'DebugLoop';
    line.renderOrder = 9999;
    group.add(line);
}
