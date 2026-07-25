// duong_lo_mesher.js
// Builds a 3-D surface mesh for mine tunnel (đường lò) segments.
//
// At every Y-station along the tunnel the cross-section is reconstructed as:
//   • Arch  — a circular arc through all three raw survey points
//             Biên-L (left shoulder) → Nóc (crown) → Biên-R (right shoulder)
//   • Floor — a flat strip from Biên-L → Nền (floor centre) → Biên-R
//
// The circumscribed circle through the three survey points is used so the arc
// passes through every measured point exactly (option B).

import * as THREE from 'three';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Linearly interpolate a 3-D polyline at a given Y position.
 * Returns null when Y falls outside the polyline's Y extent.
 */
function interpAtY(pts, y) {
    for (let i = 0; i < pts.length - 1; i++) {
        const ya = pts[i].y, yb = pts[i + 1].y;
        const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
        if (y >= lo - 1e-6 && y <= hi + 1e-6) {
            const t = Math.abs(yb - ya) < 1e-10 ? 0 : (y - ya) / (yb - ya);
            return new THREE.Vector3(
                pts[i].x + t * (pts[i + 1].x - pts[i].x),
                y,
                pts[i].z + t * (pts[i + 1].z - pts[i].z)
            );
        }
    }
    return null;
}

/**
 * Compute the arc of the circumscribed circle through P1, P2, P3.
 * Returns nSegs+1 THREE.Vector3 points sweeping from P1 to P3 through P2.
 *
 * The circumscribed circle is the unique circle passing through all three
 * measured points, so the arc honours the real survey geometry exactly.
 */
function circumArc(P1, P2, P3, nSegs = 16) {
    const a  = P2.clone().sub(P1);
    const b  = P3.clone().sub(P1);
    const n  = new THREE.Vector3().crossVectors(a, b); // normal to the plane
    const n2 = n.dot(n);

    if (n2 < 1e-12) {
        // Degenerate / collinear — fall back to straight interpolation
        return Array.from({ length: nSegs + 1 },
            (_, i) => P1.clone().lerp(P3, i / nSegs));
    }

    const a2 = a.dot(a), b2 = b.dot(b);

    // Circumcenter formula: C = P1 + (a²(b×n) + b²(n×a)) / (2|n|²)
    const center = P1.clone().add(
        new THREE.Vector3().crossVectors(b, n).multiplyScalar(a2)
            .add(new THREE.Vector3().crossVectors(n, a).multiplyScalar(b2))
            .divideScalar(2 * n2)
    );

    const R   = center.distanceTo(P1);
    const u   = P1.clone().sub(center).divideScalar(R);          // local X (→ P1)
    const nHat = n.clone().normalize();
    const v   = new THREE.Vector3().crossVectors(nHat, u).normalize(); // local Y

    // Angles of P3 and P2 measured from the P1 direction
    const r3 = P3.clone().sub(center);
    let   a3 = Math.atan2(r3.dot(v), r3.dot(u));
    const r2 = P2.clone().sub(center);
    let   a2p = Math.atan2(r2.dot(v), r2.dot(u));

    // Normalise a3 to (0, 2π] so we sweep in the positive direction by default
    if (a3 <= 0) a3 += 2 * Math.PI;
    // Normalise a2p to (0, 2π]
    if (a2p <= 0) a2p += 2 * Math.PI;
    // If P2 is not inside the [0 → a3] arc, reverse the sweep direction
    if (a2p > a3) a3 -= 2 * Math.PI;

    return Array.from({ length: nSegs + 1 }, (_, i) => {
        const θ = (i / nSegs) * a3;
        return center.clone()
            .add(u.clone().multiplyScalar(R * Math.cos(θ)))
            .add(v.clone().multiplyScalar(R * Math.sin(θ)));
    });
}

// ── Quad-strip mesh builder ───────────────────────────────────────────────────

function stripMesh(rows, color) {
    if (rows.length < 2) return null;
    const cols   = rows[0].length;
    const verts  = [];
    const idx    = [];
    for (const row of rows) for (const p of row) verts.push(p.x, p.y, p.z);
    for (let r = 0; r < rows.length - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
            const a = r * cols + c;
            idx.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
        }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    geom.setIndex(idx);
    geom.computeVertexNormals();
    // MeshBasicMaterial — visible without scene lights
    return new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
        color, side: THREE.DoubleSide, wireframe: false,
    }));
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function buildDuongLoMesh(rawDataSegments, meshGroup, wallHeight = 0) {
    // ── 1. Group segments by tunnel name ─────────────────────────────────────
    const tunnels = new Map(); // tunnelName → { nen, noc, bien }
    for (const seg of rawDataSegments) {
        if (!seg.isDuongLo) continue;
        const name = seg.blockName || '__default__';
        if (!tunnels.has(name)) tunnels.set(name, { nen: [], noc: [], bien: [] });
        const t     = tunnels.get(name);
        const layer = seg.duongLoLayer || '';
        if      (layer === 'nen')  t.nen.push(seg);
        else if (layer === 'noc')  t.noc.push(seg);
        else if (layer === 'bien') t.bien.push(seg);
    }

    // ── 2. Replace old mesh group ─────────────────────────────────────────────
    const old = meshGroup.getObjectByName('DuongLo_Meshes');
    if (old) {
        old.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material)  o.material.dispose();
        });
        meshGroup.remove(old);
    }
    const grp = new THREE.Group();
    grp.name = 'DuongLo_Meshes';
    meshGroup.add(grp);

    const ARC_SEGS = 14; // arc subdivisions per cross-section

    // ── 3. Build each tunnel ──────────────────────────────────────────────────
    for (const [tunnelName, { nen, noc, bien }] of tunnels) {
        if (!noc.length || bien.length < 2) {
            console.warn(`[DuongLo] "${tunnelName}" — missing Nóc or Biên, skipping.`);
            continue;
        }

        const nocLine = noc[0];

        // Identify left / right Biên by mean X relative to Nóc
        const sorted = [...bien].sort((A, B) => {
            const ax = A.reduce((s, p) => s + p.x, 0) / A.length;
            const bx = B.reduce((s, p) => s + p.x, 0) / B.length;
            return ax - bx;
        });
        const bienL   = sorted[0];
        const bienR   = sorted[sorted.length - 1];
        const nenLine = nen.length > 0 ? nen[0] : null;

        // Valid Y range = intersection of all lines
        const yLo = Math.max(
            Math.min(...nocLine.map(p => p.y)),
            Math.min(...bienL.map(p => p.y)),
            Math.min(...bienR.map(p => p.y)),
            ...(nenLine ? [Math.min(...nenLine.map(p => p.y))] : [])
        );
        const yHi = Math.min(
            Math.max(...nocLine.map(p => p.y)),
            Math.max(...bienL.map(p => p.y)),
            Math.max(...bienR.map(p => p.y)),
            ...(nenLine ? [Math.max(...nenLine.map(p => p.y))] : [])
        );
        if (yLo >= yHi) { console.warn(`[DuongLo] "${tunnelName}" — no overlapping Y range.`); continue; }

        // Station Y values from the Nóc line (filtered to the shared range)
        const stationYs = nocLine.map(p => p.y).filter(y => y >= yLo && y <= yHi);
        if (stationYs.length < 2) continue;

        const archRows  = [];
        const wallLRows = []; // left side wall
        const wallRRows = []; // right side wall
        const floorRows = [];

        for (const y of stationYs) {
            const pNoc = interpAtY(nocLine, y);
            const pBL  = interpAtY(bienL,   y);
            const pBR  = interpAtY(bienR,   y);
            if (!pNoc || !pBL || !pBR) continue;

            // 1. Create raised points for the roof arc by adding wallHeight to Z
            const pNoc_top = new THREE.Vector3(pNoc.x, y, pNoc.z + wallHeight);
            const pBL_top  = new THREE.Vector3(pBL.x, y, pBL.z + wallHeight);
            const pBR_top  = new THREE.Vector3(pBR.x, y, pBR.z + wallHeight);

            // Arc through the newly raised points
            archRows.push(circumArc(pBL_top, pNoc_top, pBR_top, ARC_SEGS));

            // 2. Build side walls connecting the raised points back down to the original survey points
            if (wallHeight > 0) {
                // Maintained winding order to ensure normals face inward toward the tunnel
                wallLRows.push([pBL_top, pBL.clone()]); 
                wallRRows.push([pBR.clone(), pBR_top]);
            }

            // 3. Keep the floor at the exact original surveyed elevation
            const floor = [pBL.clone()];
            let foundCenter = false;

            if (nenLine) {
                const pN = interpAtY(nenLine, y);
                if (pN) {
                    floor.push(pN);
                    foundCenter = true;
                }
            }

            // Prevent stripMesh index corruption: If a tunnel has a nenLine but 
            // interpolation fails at this specific Y, inject a midpoint to maintain column count.
            if (nenLine && !foundCenter) {
                floor.push(pBL.clone().lerp(pBR, 0.5));
            }
            
            floor.push(pBR.clone());
            floorRows.push(floor);
        }

        if (archRows.length < 2) continue;

        // Arch surface (steel blue)
        const archMesh = stripMesh(archRows, 0x4488cc);
        if (archMesh) {
            archMesh.name = `DuongLo_Arch_${tunnelName}`;
            grp.add(archMesh);
        }

        // Side walls (slightly lighter blue)
        const wallLMesh = stripMesh(wallLRows, 0x5599dd);
        if (wallLMesh) { wallLMesh.name = `DuongLo_WallL_${tunnelName}`; grp.add(wallLMesh); }
        const wallRMesh = stripMesh(wallRRows, 0x5599dd);
        if (wallRMesh) { wallRMesh.name = `DuongLo_WallR_${tunnelName}`; grp.add(wallRMesh); }

        // Floor strip (sandy brown)
        const floorMesh = stripMesh(floorRows, 0xc89060);
        if (floorMesh) {
            floorMesh.name = `DuongLo_Floor_${tunnelName}`;
            grp.add(floorMesh);
        }

        console.log(`[DuongLo] "${tunnelName}": ${archRows.length} stations, ARC_SEGS=${ARC_SEGS}`);
    }
}
