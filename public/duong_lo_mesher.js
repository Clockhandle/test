// duong_lo_mesher.js
// Builds unified 3-D volumetric surface meshes for mine tunnel (đường lò) networks
// using three-bvh-csg to eliminate interior blocking walls at T-junctions.

import * as THREE from 'three';
import { Evaluator, Brush, ADDITION } from 'three-bvh-csg';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function circumArc(P1, P2, P3, nSegs = 16) {
    const a  = P2.clone().sub(P1);
    const b  = P3.clone().sub(P1);
    const n  = new THREE.Vector3().crossVectors(a, b);
    const n2 = n.dot(n);

    if (n2 < 1e-12) {
        return Array.from({ length: nSegs + 1 }, (_, i) => P1.clone().lerp(P3, i / nSegs));
    }

    const a2 = a.dot(a), b2 = b.dot(b);
    const center = P1.clone().add(
        new THREE.Vector3().crossVectors(b, n).multiplyScalar(a2)
            .add(new THREE.Vector3().crossVectors(n, a).multiplyScalar(b2))
            .divideScalar(2 * n2)
    );

    const R   = center.distanceTo(P1);
    const u   = P1.clone().sub(center).divideScalar(R);
    const nHat = n.clone().normalize();
    const v   = new THREE.Vector3().crossVectors(nHat, u).normalize();

    const r3 = P3.clone().sub(center);
    let   a3 = Math.atan2(r3.dot(v), r3.dot(u));
    const r2 = P2.clone().sub(center);
    let   a2p = Math.atan2(r2.dot(v), r2.dot(u));

    if (a3 <= 0) a3 += 2 * Math.PI;
    if (a2p <= 0) a2p += 2 * Math.PI;
    if (a2p > a3) a3 -= 2 * Math.PI;

    return Array.from({ length: nSegs + 1 }, (_, i) => {
        const θ = (i / nSegs) * a3;
        return center.clone()
            .add(u.clone().multiplyScalar(R * Math.cos(θ)))
            .add(v.clone().multiplyScalar(R * Math.sin(θ)));
    });
}

function offsetLine(segArr, globalOffset) {
    return segArr.map(p => p.clone().sub(globalOffset));
}

// ── Spatial Junction Detection ────────────────────────────────────────────────

function distToSegmentSq(p, v, w) {
    let l2 = v.distanceToSquared(w);
    if (l2 === 0) return p.distanceToSquared(v);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y) + (p.z - v.z) * (w.z - v.z)) / l2;
    t = Math.max(0, Math.min(1, t));
    let projX = v.x + t * (w.x - v.x);
    let projY = v.y + t * (w.y - v.y);
    let projZ = v.z + t * (w.z - v.z);
    let dx = p.x - projX, dy = p.y - projY, dz = p.z - projZ;
    return dx*dx + dy*dy + dz*dz;
}

/**
 * Checks if a given endpoint touches any other segment in the entire mine network.
 * If it touches > 1 path, it's a junction. If it only touches 1 (itself), it's floating.
 */
function isFloating(pt, allSkeletonPaths) {
    const TOL_SQ = 0.05 * 0.05; // 5cm connection tolerance
    let matchCount = 0;
    
    for (const path of allSkeletonPaths) {
        for (let i = 0; i < path.length - 1; i++) {
            if (distToSegmentSq(pt, path[i], path[i+1]) < TOL_SQ) {
                matchCount++;
                break; // Only count each path once
            }
        }
    }
    return matchCount <= 1; 
}

// ── Multi-Material Splitter (Dynamic Caps & Floors) ───────────────────────────

function splitMaterials(geom, isStartFloating, isEndFloating, startPt, endPt) {
    if (!geom.index) {
        const pos = geom.attributes.position;
        const count = pos.count;
        const indices = new Array(count);
        for (let i = 0; i < count; i++) indices[i] = i;
        geom.setIndex(indices);
    }

    const pos = geom.attributes.position;
    const oldIdx = geom.index.array;
    const oldGroups = geom.groups;
    
    const newIndices = [];
    const newGroups = [];
    
    const cap0Indices = [];  // Floating caps (Invisible)
    const cap1Indices = [];  // Junction caps (Solid wall)
    const wallIndices = [];  // Sides
    const floorIndices = []; // Floor
    
    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), faceNormal = new THREE.Vector3();
    
    for (const g of oldGroups) {
        if (g.materialIndex === 0) { // Caps
            for (let i = g.start; i < g.start + g.count; i += 3) {
                const a = oldIdx[i], b = oldIdx[i+1], c = oldIdx[i+2];
                vA.fromBufferAttribute(pos, a);
                vB.fromBufferAttribute(pos, b);
                vC.fromBufferAttribute(pos, c);
                
                // Determine if this cap triangle is at the start or end of the tunnel
                const centroid = new THREE.Vector3().addVectors(vA, vB).add(vC).divideScalar(3);
                const distStart = centroid.distanceToSquared(startPt);
                const distEnd = centroid.distanceToSquared(endPt);
                
                const floating = distStart < distEnd ? isStartFloating : isEndFloating;
                
                if (floating) cap0Indices.push(a, b, c);
                else cap1Indices.push(a, b, c);
            }
        } else { // Sides
            for (let i = g.start; i < g.start + g.count; i += 3) {
                const a = oldIdx[i], b = oldIdx[i+1], c = oldIdx[i+2];
                vA.fromBufferAttribute(pos, a);
                vB.fromBufferAttribute(pos, b);
                vC.fromBufferAttribute(pos, c);
                
                ab.subVectors(vB, vA);
                ac.subVectors(vC, vA);
                faceNormal.crossVectors(ab, ac).normalize();
                
                if (faceNormal.z < -0.5) floorIndices.push(a, b, c);
                else wallIndices.push(a, b, c);
            }
        }
    }
    
    // Group 0: Invisible Caps
    if (cap0Indices.length > 0) {
        const start = newIndices.length;
        newIndices.push(...cap0Indices);
        newGroups.push({ start, count: cap0Indices.length, materialIndex: 0 });
    }
    // Group 1: Solid Walls + Junction Caps
    if (wallIndices.length > 0 || cap1Indices.length > 0) {
        const start = newIndices.length;
        newIndices.push(...wallIndices, ...cap1Indices);
        newGroups.push({ start, count: wallIndices.length + cap1Indices.length, materialIndex: 1 });
    }
    // Group 2: Floor
    if (floorIndices.length > 0) {
        const start = newIndices.length;
        newIndices.push(...floorIndices);
        newGroups.push({ start, count: floorIndices.length, materialIndex: 2 });
    }
    
    geom.setIndex(newIndices);
    geom.groups = newGroups;
}

// ── Loai 1: Watertight Solid Builder ────────────────────────────────────────

function createClosedSolidGeometry(rings) {
    if (rings.length < 2 || rings[0].length < 3) return null;

    const numRows = rings.length;
    const cols = rings[0].length;
    const vertices = [];
    const indices = [];
    const uvs = [];

    for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < cols; c++) {
            const p = rings[r][c];
            vertices.push(p.x, p.y, p.z);
            uvs.push(0, 0); 
        }
    }

    for (let r = 0; r < numRows - 1; r++) {
        for (let c = 0; c < cols; c++) {
            const nextC = (c + 1) % cols;
            const a = r * cols + c;
            const b = r * cols + nextC;
            const cIdx = (r + 1) * cols + nextC;
            const d = (r + 1) * cols + c;

            indices.push(a, b, cIdx);
            indices.push(a, cIdx, d);
        }
    }

    for (let c = 1; c < cols - 1; c++) {
        indices.push(0, c, c + 1); 
    }
    const lastRowBase = (numRows - 1) * cols;
    for (let c = 1; c < cols - 1; c++) {
        indices.push(lastRowBase, lastRowBase + c + 1, lastRowBase + c); 
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    geom.computeVertexNormals();
    
    if (geom.attributes.position.count === 0 || geom.index.count === 0) return null;

    const quadIndices = (numRows - 1) * cols * 6;
    const capIndices = (cols - 2) * 3 * 2; 
    geom.addGroup(0, quadIndices, 1); 
    geom.addGroup(quadIndices, capIndices, 0); 

    return geom;
}

function generateLoai1Geometry(nocLine, bienL, bienR, nenLine, wallHeight, allPaths, materials, ARC_SEGS = 14) {
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
    if (yLo >= yHi) return null;

    const stationYs = nocLine.map(p => p.y).filter(y => y >= yLo && y <= yHi);
    if (stationYs.length < 2) return null;

    const rings = [];
    for (const y of stationYs) {
        const pNoc = interpAtY(nocLine, y);
        const pBL  = interpAtY(bienL, y);
        const pBR  = interpAtY(bienR, y);
        if (!pNoc || !pBL || !pBR) continue;

        const pNoc_top = new THREE.Vector3(pNoc.x, y, pNoc.z + wallHeight);
        const pBL_top  = new THREE.Vector3(pBL.x, y, pBL.z + wallHeight);
        const pBR_top  = new THREE.Vector3(pBR.x, y, pBR.z + wallHeight);

        const archPts = circumArc(pBL_top, pNoc_top, pBR_top, ARC_SEGS);
        const wallRPts = wallHeight > 0 ? [pBR.clone()] : [];
        const floorPts = [];
        if (nenLine) {
            const pN = interpAtY(nenLine, y);
            floorPts.push(pN ? pN : pBL.clone().lerp(pBR, 0.5));
        }
        floorPts.push(pBL.clone());

        const ring = [...archPts, ...wallRPts, ...floorPts];
        rings.push(ring);
    }

    let geom = createClosedSolidGeometry(rings);
    if (!geom) return null;
    geom = mergeVertices(geom);
    geom.computeVertexNormals();

    const startPt = interpAtY(nocLine, stationYs[0]);
    const endPt = interpAtY(nocLine, stationYs[stationYs.length - 1]);
    
    const isStartF = isFloating(startPt, allPaths);
    const isEndF = isFloating(endPt, allPaths);
    
    splitMaterials(geom, isStartF, isEndF, startPt, endPt);
    
    const brush = new Brush(geom, materials);
    brush.updateMatrixWorld();
    return brush;
}

// ── Loai 2: Extrusion Generators ────────────────────────────────────────────

const PROFILE_TOL  = 0.01;   // m — tiết diện outline points closer than this to the simplified outline are dropped
const MAX_TURN_DEG = 30;     // a bend sharper than this is rounded into several rings so they cannot fold
const Z_SPIKE      = 10;     // m — a route vertex this far above/below both neighbours is reported as suspect

// Douglas–Peucker on an open 2-D polyline ([x, y] pairs); keeps both ends.
function simplifyOpen(P, tol) {
    if (P.length < 3) return P;
    const [a, b] = [P[0], P[P.length - 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let worst = 0, k = 0;
    for (let i = 1; i < P.length - 1; i++) {
        const d = L === 0 ? Math.hypot(P[i][0] - a[0], P[i][1] - a[1])
            : Math.abs((b[0] - a[0]) * (a[1] - P[i][1]) - (a[0] - P[i][0]) * (b[1] - a[1])) / L;
        if (d > worst) { worst = d; k = i; }
    }
    if (worst <= tol) return [a, b];
    return [...simplifyOpen(P.slice(0, k + 1), tol).slice(0, -1), ...simplifyOpen(P.slice(k), tol)];
}

// Closed outline: split at the point farthest from the first, simplify both halves.
function simplifyClosed(P, tol) {
    let f = 0, fd = 0;
    P.forEach((p, i) => { const d = Math.hypot(p[0] - P[0][0], p[1] - P[0][1]); if (d > fd) { fd = d; f = i; } });
    const A = simplifyOpen(P.slice(0, f + 1), tol);
    const B = simplifyOpen([...P.slice(f), P[0]], tol);
    return [...A.slice(0, -1), ...B.slice(0, -1)];
}

// Tiết diện polyline → CCW outline centred on x, floor at y = 0 (the route is the floor line).
function buildProfile(td) {
    let pts = td.map(p => [p.x, p.y]);
    const first = pts[0], last = pts[pts.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-4 && Math.abs(first[1] - last[1]) < 1e-4) pts.pop();
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = Math.min(...ys);
    pts = simplifyClosed(pts.map(([x, y]) => [x - cx, y - cy]), PROFILE_TOL);
    let contour = pts.map(([x, y]) => new THREE.Vector2(x, y));
    if (THREE.ShapeUtils.isClockWise(contour)) contour = contour.reverse();
    // how far the outline reaches from the route: sets how much a sharp bend must be rounded
    const extent = Math.max(...contour.map(p => Math.max(Math.abs(p.x), p.y)));
    return { contour, extent, faces: THREE.ShapeUtils.triangulateShape(contour, []) };
}

// Replace each bend sharper than MAX_TURN_DEG by a circular arc sampled every ≤ MAX_TURN_DEG.
// The arc's radius is just over how far the outline reaches from the route, so rings on the
// inside of the bend cannot cross (unless the legs are too short to fit it).
function roundSharpBends(P, extent) {
    const maxTurn = MAX_TURN_DEG * Math.PI / 180;
    const out = [P[0]];
    for (let i = 1; i < P.length - 1; i++) {
        const tIn = P[i].clone().sub(P[i - 1]), tOut = P[i + 1].clone().sub(P[i]);
        const legIn = tIn.length(), legOut = tOut.length();
        tIn.normalize(); tOut.normalize();
        const turn = Math.acos(THREE.MathUtils.clamp(tIn.dot(tOut), -1, 1));
        if (turn <= maxTurn || turn > Math.PI - 1e-3) { out.push(P[i]); continue; }
        const d = Math.min(extent * 1.05 * Math.tan(turn / 2), 0.45 * legIn, 0.45 * legOut);
        const r = d / Math.tan(turn / 2);
        const A = P[i].clone().addScaledVector(tIn, -d);
        const w = tOut.clone().addScaledVector(tIn, -tIn.dot(tOut)).normalize(); // towards the arc centre
        const C = A.clone().addScaledVector(w, r);
        const k = Math.ceil(turn / maxTurn);
        for (let s = 0; s <= k; s++) {
            const phi = turn * s / k;
            out.push(C.clone().addScaledVector(w, -r * Math.cos(phi)).addScaledVector(tIn, r * Math.sin(phi)));
        }
    }
    out.push(P[P.length - 1]);
    return out;
}

// Sweep the outline along the route: one ring per route point, in the plane bisecting the bend
// and stretched across the bend (a mitre), so straight runs between route points stay exact
// prisms of the tiết diện. Rings are oriented with x level (Z-up), y towards the roof.
function sweepProfile(route, profile) {
    const { contour, faces } = profile;
    const N = contour.length, R = route.length;
    const Z = new THREE.Vector3(0, 0, 1);
    const pos = new Float32Array(R * N * 3);
    let lastN = new THREE.Vector3(1, 0, 0);
    for (let r = 0; r < R; r++) {
        const tIn  = r > 0     ? route[r].clone().sub(route[r - 1]).normalize() : null;
        const tOut = r < R - 1 ? route[r + 1].clone().sub(route[r]).normalize() : null;
        const m = (tIn && tOut ? tIn.clone().add(tOut) : (tIn || tOut).clone()).normalize();
        let n = new THREE.Vector3().crossVectors(Z, m);
        n = n.lengthSq() < 1e-10 ? lastN.clone() : n.normalize();
        lastN = n;
        const b = new THREE.Vector3().crossVectors(m, n).normalize();
        // mitre: stretch by 1/cos(θ/2) along the bend direction inside the ring plane
        let k = null, stretch = 0;
        if (tIn && tOut) {
            const bend = tOut.clone().sub(tIn);
            bend.addScaledVector(m, -bend.dot(m));
            if (bend.lengthSq() > 1e-12) {
                k = bend.normalize();
                stretch = 1 / Math.max(Math.cos(Math.acos(THREE.MathUtils.clamp(tIn.dot(tOut), -1, 1)) / 2), 0.2) - 1;
            }
        }
        for (let j = 0; j < N; j++) {
            const o = n.clone().multiplyScalar(contour[j].x).addScaledVector(b, contour[j].y);
            if (k) o.addScaledVector(k, o.dot(k) * stretch);
            const p = route[r].clone().add(o);
            pos.set([p.x, p.y, p.z], (r * N + j) * 3);
        }
    }
    // walls (outward for a CCW outline), then the two end caps
    const index = [];
    for (let r = 0; r < R - 1; r++)
        for (let j = 0; j < N; j++) {
            const a = r * N + j, b = r * N + (j + 1) % N, c = (r + 1) * N + (j + 1) % N, d = (r + 1) * N + j;
            index.push(a, b, c, a, c, d);
        }
    const wallCount = index.length;
    const area2 = ([i, j, l]) => (contour[j].x - contour[i].x) * (contour[l].y - contour[i].y)
                              - (contour[l].x - contour[i].x) * (contour[j].y - contour[i].y);
    for (const f of faces) {
        const ccw = area2(f) > 0 ? f : [f[0], f[2], f[1]];          // faces +route direction
        index.push(ccw[0], ccw[2], ccw[1]);                          // start cap faces back
        const e = (R - 1) * N;
        index.push(e + ccw[0], e + ccw[1], e + ccw[2]);              // end cap faces forward
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(R * N * 2), 2));
    geom.setIndex(index);
    geom.addGroup(0, wallCount, 1);
    geom.addGroup(wallCount, index.length - wallCount, 0);
    geom.computeVertexNormals();
    return geom;
}

// Route vertices far above or below both neighbours, reached by steep legs: almost always a typo.
function reportZSpikes(seg, route, offset) {
    for (let i = 1; i < route.length - 1; i++) {
        const dzIn = route[i].z - route[i - 1].z, dzOut = route[i + 1].z - route[i].z;
        if (Math.sign(dzIn) === Math.sign(dzOut) || Math.min(Math.abs(dzIn), Math.abs(dzOut)) < Z_SPIKE) continue;
        const p = route[i].clone().add(offset);
        console.warn(`[DuongLo] ${seg.doanName || seg.handle}: vertex ${i} (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, z ${p.z.toFixed(2)}) ` +
            `is ${Math.abs(dzIn).toFixed(1)} m / ${Math.abs(dzOut).toFixed(1)} m off its neighbours — check the Z value`);
    }
}

function generateLoai2Geometries(nenSegs, tietDienSegs, materials, globalOffset, allPaths) {
    const brushes = [];
    if (!nenSegs.length || !tietDienSegs.length) return brushes;

    const profiles = new Map();
    let fallbackName = null;
    for (const td of tietDienSegs) {
        profiles.set(td.tietDienName, buildProfile(td));
        if (fallbackName === null) fallbackName = td.tietDienName;
    }

    for (const nenSeg of nenSegs) {
        if (nenSeg.length < 2) continue;
        let profile = profiles.get(nenSeg.tietDienName);
        if (!profile) {
            console.warn(`[DuongLo] ${nenSeg.doanName || nenSeg.handle}: tiết diện "${nenSeg.tietDienName}" is not in the file — drawn with "${fallbackName}" instead`);
            profile = profiles.get(fallbackName);
        }

        const pts = nenSeg.map(p => new THREE.Vector3(p.x, p.y, p.z).sub(globalOffset))
            .filter((p, i, a) => i === 0 || p.distanceToSquared(a[i - 1]) > 1e-12);
        if (pts.length < 2) continue;
        reportZSpikes(nenSeg, pts, globalOffset);

        const geom = sweepProfile(roundSharpBends(pts, profile.extent), profile);

        const startPt = pts[0];
        const endPt = pts[pts.length - 1];
        
        // Dynamically assign open/close state based on intersection
        const isStartF = isFloating(startPt, allPaths);
        const isEndF = isFloating(endPt, allPaths);
        
        splitMaterials(geom, isStartF, isEndF, startPt, endPt);

        const brush = new Brush(geom, materials);
        brush.updateMatrixWorld();
        brushes.push(brush);
    }

    return brushes;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function buildDuongLoMesh(rawDataSegments, meshGroup, wallHeight = 0) {
    let globalOffset = null;
    for (const seg of rawDataSegments) {
        if (!seg.isDuongLo) continue;
        if (!globalOffset && seg.length) globalOffset = seg[0].clone();
    }
    if (!globalOffset) globalOffset = new THREE.Vector3(0, 0, 0);

    const tunnels = new Map(); 
    for (const seg of rawDataSegments) {
        if (!seg.isDuongLo) continue;
        const name = seg.blockName || '__default__';
        if (!tunnels.has(name)) tunnels.set(name, { nen: [], noc: [], bien: [], tietDien: [] });
        const t     = tunnels.get(name);
        const layer = seg.duongLoLayer || '';
        
        if      (layer === 'nen')       t.nen.push(seg);
        else if (layer === 'noc')       t.noc.push(seg);
        else if (layer === 'bien')      t.bien.push(seg);
        else if (layer === 'tiet dien') t.tietDien.push(seg);
    }
    
    // ── Pre-calculate Network Skeletons ──
    const allSkeletonPaths = [];
    for (const [tunnelName, { nen, noc, bien, tietDien }] of tunnels) {
        if (tietDien.length > 0) {
            for (const nenSeg of nen) {
                if (nenSeg.length < 2) continue;
                allSkeletonPaths.push(nenSeg.map(p => new THREE.Vector3(p.x, p.y, p.z).sub(globalOffset)));
            }
        } else if (noc.length > 0 && bien.length >= 2) {
            allSkeletonPaths.push(offsetLine(noc[0], globalOffset));
        }
    }

    const old = meshGroup.getObjectByName('DuongLo_Meshes');
    if (old) {
        old.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        meshGroup.remove(old);
    }
    const grp = new THREE.Group();
    grp.name = 'DuongLo_Meshes';
    meshGroup.add(grp);

    const evaluator = new Evaluator();
    evaluator.useGroups = true;
    // The legacy splitter uses a fixed 1e-10 epsilon and gives up ("Coplanar clip not handled")
    // on near-coplanar faces from Float32 rounding at junctions. CDT uses scale-relative tolerances.
    evaluator.useCDTClipping = true;

    // ── The 3 Material Slots ──
    const capMaterial = new THREE.MeshBasicMaterial({ visible: false });
    const wallMaterial = new THREE.MeshBasicMaterial({ color: 0x4488cc, side: THREE.DoubleSide });
    const floorMaterial = new THREE.MeshBasicMaterial({ color: 0xc89060, side: THREE.DoubleSide });
    const materials = [capMaterial, wallMaterial, floorMaterial];

    const allBrushes = [];

    for (const [tunnelName, { nen, noc, bien, tietDien }] of tunnels) {
        if (tietDien.length > 0) {
            if (!nen.length) continue;
            const brushes = generateLoai2Geometries(nen, tietDien, materials, globalOffset, allSkeletonPaths);
            allBrushes.push(...brushes);
            
        } else if (noc.length > 0 && bien.length >= 2) {
            const sorted = [...bien].sort((A, B) => {
                const ax = A.reduce((s, p) => s + p.x, 0) / A.length;
                const bx = B.reduce((s, p) => s + p.x, 0) / B.length;
                return ax - bx;
            });
            const nocLine = offsetLine(noc[0], globalOffset);
            const bienL   = offsetLine(sorted[0], globalOffset);
            const bienR   = offsetLine(sorted[sorted.length - 1], globalOffset);
            const nenLine = nen.length > 0 ? offsetLine(nen[0], globalOffset) : null;

            const brush = generateLoai1Geometry(nocLine, bienL, bienR, nenLine, wallHeight, allSkeletonPaths, materials);
            if (brush) allBrushes.push(brush);
        }
    }

    if (allBrushes.length === 0) return;

    // Union only branches that touch: group them by overlapping bounding boxes, and merge each
    // group in an order where every branch overlaps what is already merged. Branches that touch
    // nothing skip CSG entirely. A branch whose union fails is kept as its own piece.
    const boxes = allBrushes.map(b => { b.geometry.computeBoundingBox(); return b.geometry.boundingBox.clone().expandByScalar(0.1); });
    const touching = allBrushes.map((_, i) => allBrushes.map((_, j) => j).filter(j => j !== i && boxes[i].intersectsBox(boxes[j])));
    const seen = new Set(), pieces = [];
    for (let s = 0; s < allBrushes.length; s++) {
        if (seen.has(s)) continue;
        const order = [s]; seen.add(s);
        for (let q = 0; q < order.length; q++)
            for (const j of touching[order[q]]) if (!seen.has(j)) { seen.add(j); order.push(j); }
        let merged = allBrushes[order[0]];
        for (const i of order.slice(1)) {
            try {
                merged = evaluator.evaluate(merged, allBrushes[i], ADDITION);
            } catch (err) {
                console.warn(`[CSG Union] Failed merging branch ${i}; keeping it as a separate piece:`, err);
                pieces.push(allBrushes[i]);
            }
        }
        pieces.push(merged);
    }
    console.log(`[DuongLo CSG] ${allBrushes.length} branches → ${pieces.length} piece(s)`);

    pieces.forEach((piece, k) => {
        // CSG output repeats each corner for every triangle; share them. The materials are unlit,
        // so normals and UVs are dropped first, and only positions decide what is shared.
        let geom = piece.geometry;
        geom.deleteAttribute('normal');
        geom.deleteAttribute('uv');
        geom = mergeVertices(geom);
        const mesh = new THREE.Mesh(geom, materials);
        mesh.name = k === 0 ? 'DuongLo_Unified_CSG_Mesh' : `DuongLo_Unified_CSG_Mesh_${k}`;
        mesh.position.copy(globalOffset);
        mesh.updateMatrixWorld(true);
        grp.add(mesh);
    });
}