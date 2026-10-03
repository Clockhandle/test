// Hybrid mesher: z-stitch where CGAL's 2.5D CDT cannot represent the surface, CGAL CDT
// everywhere else, welded into one mesh along a shared seam.
//
// Stitch regions come from the data or are detected:
//   • Z band      — an IsStitchRegion entity with StitchZMin/StitchZMax. Contours inside the
//                   band are stitched; the band's lowest/highest contour is the seam, so the
//                   CGAL parts are bounded by boundary arcs + that seam contour (no clipping).
//   • Polygon     — an IsStitchRegion closed polyline (convex hull is used). The full stitch is
//                   clipped to it; the cut edge becomes a HOLE for CGAL, and contours are cut
//                   at the polygon so CGAL never sees the stitched part.
//   • Strips      — the default when no region is drawn. The contours cut the surface into
//                   strips (paired by where their ends sit along the boundary, not by plan
//                   distance); a strip whose outline crosses itself in plan is a fold and is
//                   z-stitched, every other strip goes to CGAL on its own. Seams are contours.
//   • Crossings   — fallback when strip mode can't read the data (no contour runs boundary to
//                   boundary): a capsule around each zone where contours cross in plan is
//                   treated like a polygon region.
//
// hybridMeshGroup() returns data in the same shape as mesh_gen's JSON, so cgal_mesher.js can
// render it like any other CGAL result, or null when the group needs no stitching.

import * as THREE from 'three';
import { uniformStitch } from './stitcher.js';

const MAX_EDGE = 20.0;        // uniformStitch maxEdgeLength, as used by the Fast Stitch button
const WELD_TOL = 1e-4;        // merge stitch and CGAL vertices closer than this (drawing units)
const CAPSULE_RADIUS = 12.0;  // half-width of the stitch capsule around a crossing zone
const CAPSULE_ARC_SEGS = 24;  // segments per capsule end cap
const MIN_CLEARANCE = 0.5;    // a stitch region must stay this far inside the boundary

// ── small geometry helpers ────────────────────────────────────────────────────
const cross2 = (ax, ay, bx, by) => ax * by - ay * bx;
const sideOf = (a, b, p) => cross2(b[0] - a[0], b[1] - a[1], p[0] - a[0], p[1] - a[1]);
const signedArea = (a, b, c) => 0.5 * cross2(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]);
const polyArea = P => P.reduce((s, p, i) => { const q = P[(i + 1) % P.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
const insideConvex = (p, poly) => poly.every((a, k) => sideOf(a, poly[(k + 1) % poly.length], p) > 0);
const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);

function pointInPolygon(p, P) {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const a = P[i], b = P[j];
        if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
}
function distToSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
const distToRing = (p, R) => Math.min(...R.map((a, i) => distToSegment(p, a, R[(i + 1) % R.length])));
function pointInTri(p, a, b, c) {
    const d1 = sideOf(a, b, p), d2 = sideOf(b, c, p), d3 = sideOf(c, a, p);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
const coveredBy = (p, m) => m.tris.some(t => {
    const [a, b, c] = t.map(i => m.verts[i]);
    return Math.abs(signedArea(a, b, c)) > 1e-12 && pointInTri(p, a, b, c);
});

function convexHull(points) { // Andrew's monotone chain, CCW, no collinear points
    const P = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (P.length < 3) return P;
    const half = pts => {
        const h = [];
        for (const p of pts) {
            while (h.length >= 2 && sideOf(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
            h.push(p);
        }
        h.pop();
        return h;
    };
    return [...half(P), ...half([...P].reverse())];
}

function dedupe(pts) {
    const out = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-9);
    return out;
}
function closeless(ring) {
    const r = dedupe(ring);
    const f = r[0], l = r[r.length - 1];
    return r.length > 1 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9 ? r.slice(0, -1) : r;
}

// Proper crossings (interior to both segments) between different polylines, in XY.
export function findCrossings(lines) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
        const A = lines[i], C = lines[j];
        for (let a = 0; a + 1 < A.length; a++) for (let c = 0; c + 1 < C.length; c++) {
            const P = A[a], Q = A[a + 1], R = C[c], S = C[c + 1];
            const dx = Q[0] - P[0], dy = Q[1] - P[1], ex = S[0] - R[0], ey = S[1] - R[1];
            const den = cross2(dx, dy, ex, ey);
            if (Math.abs(den) < 1e-12) continue;
            const t = cross2(R[0] - P[0], R[1] - P[1], ex, ey) / den;
            const u = cross2(R[0] - P[0], R[1] - P[1], dx, dy) / den;
            if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9)
                hits.push({ x: P[0] + t * dx, y: P[1] + t * dy, lineA: i, lineB: j, za: A[0][2], zb: C[0][2] });
        }
    }
    return hits;
}

// ── mesh helpers ─────────────────────────────────────────────────────────────
function weld(verts, tris, tol) {
    const grid = new Map(), out = [], remap = new Array(verts.length);
    verts.forEach((v, i) => {
        const cx = Math.floor(v[0] / tol), cy = Math.floor(v[1] / tol);
        let hit = -1;
        for (let dx = -1; dx <= 1 && hit < 0; dx++)
            for (let dy = -1; dy <= 1 && hit < 0; dy++)
                for (const j of grid.get(`${cx + dx},${cy + dy}`) || []) {
                    const w = out[j];
                    if ((w[0] - v[0]) ** 2 + (w[1] - v[1]) ** 2 + (w[2] - v[2]) ** 2 <= tol * tol) { hit = j; break; }
                }
        if (hit < 0) {
            hit = out.length; out.push(v);
            const k = `${cx},${cy}`;
            (grid.get(k) || grid.set(k, []).get(k)).push(hit);
        }
        remap[i] = hit;
    });
    const t2 = [];
    for (const t of tris) {
        const r = t.map(i => remap[i]);
        if (r[0] !== r[1] && r[1] !== r[2] && r[2] !== r[0]) t2.push(r);
    }
    return { verts: out, tris: t2 };
}

// Orient triangles consistently across shared edges, each connected piece seeded with its
// largest triangle facing +Z. Folds (overhangs) stay facing down instead of being flipped up.
// Returns the number of downward-facing (overhang) triangles.
function orientConsistent(m) {
    const adj = new Map();
    m.tris.forEach((t, ti) => { for (let e = 0; e < 3; e++) { const k = edgeKey(t[e], t[(e + 1) % 3]); (adj.get(k) || adj.set(k, []).get(k)).push(ti); } });
    const done = new Uint8Array(m.tris.length);
    const area = ti => signedArea(...m.tris[ti].map(i => m.verts[i]));
    const order = [...m.tris.keys()].sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
    for (const seed of order) {
        if (done[seed]) continue;
        if (area(seed) < 0) { const t = m.tris[seed]; [t[1], t[2]] = [t[2], t[1]]; }
        done[seed] = 1;
        const stack = [seed];
        while (stack.length) {
            const ti = stack.pop(), t = m.tris[ti];
            for (let e = 0; e < 3; e++) {
                const a = t[e], b = t[(e + 1) % 3], nb = adj.get(edgeKey(a, b));
                if (nb.length !== 2) continue;
                const oj = nb[0] === ti ? nb[1] : nb[0];
                if (done[oj]) continue;
                const u = m.tris[oj];
                for (let f = 0; f < 3; f++) if (u[f] === a && u[(f + 1) % 3] === b) { [u[1], u[2]] = [u[2], u[1]]; break; }
                done[oj] = 1; stack.push(oj);
            }
        }
    }
    return m.tris.filter(t => signedArea(...t.map(i => m.verts[i])) < -1e-9).length;
}

// Open-edge loops (as ordered vertex rings) and non-manifold edge count.
function topology(m) {
    const edges = new Map();
    for (const t of m.tris) for (let e = 0; e < 3; e++) {
        const a = t[e], b = t[(e + 1) % 3], k = edgeKey(a, b);
        const rec = edges.get(k) || edges.set(k, { n: 0, a, b }).get(k);
        rec.n++;
    }
    let nonManifold = 0;
    const next = new Map();
    for (const rec of edges.values()) {
        if (rec.n === 1) next.set(rec.a, rec.b);
        else if (rec.n > 2) nonManifold++;
    }
    const loops = [], seen = new Set();
    for (const s of next.keys()) {
        if (seen.has(s)) continue;
        const loop = [];
        for (let v = s; v !== undefined && !seen.has(v); v = next.get(v)) { seen.add(v); loop.push(v); }
        loops.push(loop);
    }
    return { loops, nonManifold, openEdges: next.size };
}

// Stitch consecutive Z levels (top → bottom) with the project's uniformStitch.
function zStitch(levels) {
    const sorted = [...levels].sort((a, b) => b[0][2] - a[0][2]);
    const sv = [], st = [];
    for (let i = 0; i + 1 < sorted.length; i++) {
        const g = uniformStitch(sorted[i].map(v => new THREE.Vector3(...v)),
                                sorted[i + 1].map(v => new THREE.Vector3(...v)), MAX_EDGE);
        if (!g) continue;
        const pos = g.attributes.position.array, idx = g.index.array, base = sv.length;
        for (let k = 0; k < pos.length; k += 3) sv.push([pos[k], pos[k + 1], pos[k + 2]]);
        for (let k = 0; k < idx.length; k += 3) st.push([base + idx[k], base + idx[k + 1], base + idx[k + 2]]);
        g.dispose();
    }
    return weld(sv, st, WELD_TOL);
}

// Same resampling uniformStitch applies to its input lines (stitcher.js subdivideLine).
function subdivide(line) {
    const out = [line[0]];
    for (let i = 1; i < line.length; i++) {
        const p = line[i - 1], q = line[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) / MAX_EDGE));
        for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])]);
        }
    }
    return out;
}

// Clip a triangle (3-D points) to a convex CCW polygon in XY; Z is interpolated along edges.
function clipToConvex(tri, poly) {
    let pts = tri;
    for (let k = 0; k < poly.length && pts.length >= 3; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length], out = [];
        for (let i = 0; i < pts.length; i++) {
            const P = pts[i], Q = pts[(i + 1) % pts.length], sp = sideOf(a, b, P), sq = sideOf(a, b, Q);
            if (sp >= 0) out.push(P);
            if ((sp >= 0) !== (sq >= 0)) {
                const t = sp / (sp - sq);
                out.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1]), P[2] + t * (Q[2] - P[2])]);
            }
        }
        pts = out;
    }
    return pts.length >= 3 ? pts : [];
}

// Pieces of a polyline that lie outside a convex polygon, split exactly on its edges.
function trimOutsideConvex(line, poly) {
    const pts = [line[0]];
    for (let i = 0; i + 1 < line.length; i++) {
        const P = line[i], Q = line[i + 1], d = [Q[0] - P[0], Q[1] - P[1]], ts = [];
        poly.forEach((a, k) => {
            const b = poly[(k + 1) % poly.length], e = [b[0] - a[0], b[1] - a[1]];
            const den = cross2(d[0], d[1], e[0], e[1]);
            if (Math.abs(den) < 1e-15) return;
            const ap = [a[0] - P[0], a[1] - P[1]];
            const t = cross2(ap[0], ap[1], e[0], e[1]) / den, u = cross2(ap[0], ap[1], d[0], d[1]) / den;
            if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
        });
        ts.sort((x, y) => x - y).forEach(t => pts.push([P[0] + t * d[0], P[1] + t * d[1], P[2] + t * (Q[2] - P[2])]));
        pts.push(Q);
    }
    const pieces = [];
    let cur = null;
    for (let i = 0; i + 1 < pts.length; i++) {
        const mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
        if (!insideConvex(mid, poly)) {
            if (!cur) { cur = [pts[i]]; pieces.push(cur); }
            cur.push(pts[i + 1]);
        } else cur = null;
    }
    // mesh_gen assigns a contour to a boundary by probing its interior vertices; give 2-point
    // pieces a midpoint so the probe does not land on an endpoint sitting on the boundary.
    return pieces.map(p => p.length === 2
        ? [p[0], [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2, (p[0][2] + p[1][2]) / 2], p[1]]
        : p);
}

// Capsule (a circle stretched along a segment), CCW.
function capsule(A, B, r) {
    const ang = Math.atan2(B[1] - A[1], B[0] - A[0]), out = [];
    for (let k = 0; k <= CAPSULE_ARC_SEGS; k++) { const t = ang - Math.PI / 2 + Math.PI * k / CAPSULE_ARC_SEGS; out.push([B[0] + r * Math.cos(t), B[1] + r * Math.sin(t)]); }
    for (let k = 0; k <= CAPSULE_ARC_SEGS; k++) { const t = ang + Math.PI / 2 + Math.PI * k / CAPSULE_ARC_SEGS; out.push([A[0] + r * Math.cos(t), A[1] + r * Math.sin(t)]); }
    return out;
}

// One capsule per crossing zone: crossings of the same contour pair form a zone; zones whose
// capsules overlap are merged into the convex hull of both.
function crossingRegions(hits) {
    const byPair = new Map();
    for (const h of hits) { const k = `${h.lineA},${h.lineB}`; (byPair.get(k) || byPair.set(k, []).get(k)).push(h); }
    let regions = [...byPair.values()].map(zone => {
        let pa = zone[0], pb = zone[0], best = -1;
        for (const a of zone) for (const b of zone) { const d = Math.hypot(a.x - b.x, a.y - b.y); if (d > best) { best = d; pa = a; pb = b; } }
        return { kind: 'crossing', poly: capsule([pa.x, pa.y], [pb.x, pb.y], CAPSULE_RADIUS), hits: zone };
    });
    for (let merged = true; merged;) {
        merged = false;
        outer: for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
            const A = regions[i].poly, B = regions[j].poly;
            if (A.some(p => insideConvex(p, B)) || B.some(p => insideConvex(p, A))) {
                regions[i] = { kind: 'crossing', poly: convexHull([...A, ...B]), hits: [...regions[i].hits, ...regions[j].hits] };
                regions.splice(j, 1); merged = true; break outer;
            }
        }
    }
    return regions;
}

// ── entry point ───────────────────────────────────────────────────────────────
/**
 * @param {object} g         cgal_mesher group: { polylines, boundaries, holes, breaklines, scatter, stitchRegions }
 *                           — polylines/boundaries as [[x,y,z],...]; stitchRegions as { poly, zMin, zMax }.
 * @param {function} runMesh async (payload) => mesh_gen JSON (the /api/mesh request).
 * @param {object} [opts]    { slope }
 * @returns {Promise<object|null>} mesh_gen-shaped result with a `hybrid` report, or null when
 *                           the group needs no stitching (caller falls back to plain CGAL).
 */
export async function hybridMeshGroup(g, runMesh, opts = {}) {
    const warnings = [];
    const explicit = g.stitchRegions || [];
    const boundaryW = g.boundaries.length === 1 ? closeless(g.boundaries[0]) : null;
    const contoursW = g.polylines.map(dedupe).filter(c => c.length >= 2);

    // Crossings are checked even without explicit regions: they are what breaks plain CGAL.
    // (Strip mode below also catches folds where only the boundary crosses the contours.)
    const crossingHits = findCrossings(contoursW);

    if (!boundaryW) {
        console.warn(`[Hybrid] ${g.boundaries.length} boundaries in this group — hybrid needs exactly one; using plain CGAL.`);
        return null;
    }
    if (g.holes.length || g.breaklines.length || g.scatter.length) {
        console.warn('[Hybrid] Holes, breaklines and scatter points are not supported in hybrid mode yet; using plain CGAL.');
        return null;
    }

    // Work in local coordinates: uniformStitch returns float32 positions, which lose ~0.25 m
    // at survey-scale coordinates.
    const xs = boundaryW.map(v => v[0]), ys = boundaryW.map(v => v[1]);
    const O = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const toL = v => [v[0] - O[0], v[1] - O[1], v[2]];
    const toW = v => [v[0] + O[0], v[1] + O[1], v[2]];
    let B = boundaryW.map(toL);
    if (polyArea(B) < 0) B = B.reverse();
    const C = contoursW.map(c => c.map(toL));
    for (const h of crossingHits) { h.x -= O[0]; h.y -= O[1]; }
    const payloadBase = { slope: opts.slope, action: 'mesh' };

    const band = explicit.find(r => Number.isFinite(r.zMin) && Number.isFinite(r.zMax));
    const ctx = { B, C, O, toW, runMesh, payloadBase, warnings, crossingHits };
    // No regions drawn → strip mode (works out the folds by itself). If strip mode can't read
    // the data (e.g. contours that don't end on the boundary), fall back to crossing capsules.
    let result, mode;
    if (band) { mode = 'band'; result = await bandMode(band, ctx); }
    else if (explicit.length) { mode = 'polygon'; result = await polygonMode(explicit, ctx); }
    else {
        mode = 'strip';
        result = await stripMode(ctx);
        if (result && result.unsupported) {
            warnings.push(`Strip mode not used: ${result.unsupported}`);
            console.warn('[Hybrid]', warnings.at(-1));
            result = null;
            if (crossingHits.length) { mode = 'polygon'; result = await polygonMode([], ctx); }
        }
    }
    if (!result) return null;

    // Merge: stitch triangles first (so the renderer can colour them), then CGAL.
    const { patch, cgal, seams, regions } = result;
    const verts = [...patch.verts, ...cgal.verts];
    const tris = [...patch.tris.map(t => [...t]), ...cgal.tris.map(t => t.map(i => i + patch.verts.length))];
    const merged = weld(verts, tris, result.weldTol || WELD_TOL);
    let stitchCount = patch.tris.length; // weld keeps triangle order
    // Two strips can both mesh the same tiny triangle where a contour stops just short of the
    // boundary; keep only the first copy of any triangle.
    const seenTri = new Set();
    merged.tris = merged.tris.filter((t, i) => {
        const k = [...t].sort((a, b) => a - b).join(',');
        if (seenTri.has(k)) { if (i < patch.tris.length) stitchCount--; return false; }
        seenTri.add(k);
        return true;
    });
    const overhang = orientConsistent(merged);
    const topo = topology(merged);

    // Every seam segment must be shared by a stitch and a CGAL triangle.
    const edgeUse = new Map();
    for (const t of merged.tris) for (let e = 0; e < 3; e++) { const k = edgeKey(t[e], t[(e + 1) % 3]); edgeUse.set(k, (edgeUse.get(k) || 0) + 1); }
    const grid = new Map();
    merged.verts.forEach((v, i) => { const k = `${Math.round(v[0] / 1e-3)},${Math.round(v[1] / 1e-3)}`; (grid.get(k) || grid.set(k, []).get(k)).push(i); });
    const findV = p => {
        const cx = Math.round(p[0] / 1e-3), cy = Math.round(p[1] / 1e-3);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
            for (const i of grid.get(`${cx + dx},${cy + dy}`) || []) { const v = merged.verts[i]; if (Math.hypot(v[0] - p[0], v[1] - p[1], v[2] - p[2]) <= 1e-3) return i; }
        return -1;
    };
    let seamSegments = 0, seamOpen = 0;
    for (const s of seams) {
        const n = s.closed ? s.pts.length : s.pts.length - 1;
        for (let i = 0; i < n; i++) {
            const a = findV(s.pts[i]), b = findV(s.pts[(i + 1) % s.pts.length]);
            seamSegments++;
            if (a < 0 || b < 0 || edgeUse.get(edgeKey(a, b)) !== 2) seamOpen++;
        }
    }
    if (seamOpen) warnings.push(`${seamOpen} of ${seamSegments} seam segments are not shared by both sides — the seam has gaps.`);
    if (topo.nonManifold) warnings.push(`${topo.nonManifold} non-manifold edges after welding.`);

    const stats = {
        mode,
        stitchTriangles: stitchCount, cgalTriangles: cgal.tris.length,
        openLoops: topo.loops.length, nonManifold: topo.nonManifold, overhang,
        seamSegments, seamOpen, crossings: crossingHits.length,
        stitchCoverage: result.stitchCoverage,
        ...(result.stats || {}),
    };
    console.log('[Hybrid]', stats);
    warnings.forEach(w => console.warn('[Hybrid]', w));

    return {
        ok: true,
        action_mode: 'hybrid',
        num_contours: contoursW.length,
        num_boundaries: 1,
        num_orphan_contours: cgal.orphans || 0,
        num_meshes: 1,
        num_warnings: warnings.length,
        warnings: [],
        meshes: [{
            num_contours: contoursW.length, num_holes: 0,
            dropped_slope: cgal.droppedSlope || 0, dropped_hole: 0, slope_used: cgal.slopeUsed ?? 0,
            num_vertices: merged.verts.length, num_triangles: merged.tris.length,
            vertices: merged.verts.map(toW), triangles: merged.tris,
            stitch_triangle_count: stitchCount,
        }],
        hybrid: {
            stats, warnings,
            seams: seams.map(s => ({ closed: s.closed, points: s.pts.map(toW) })),
            regions: regions.map(r => ({ kind: r.kind, polygon: r.poly.map(p => toW([p[0], p[1], 0])) })),
            crossings: crossingHits.map(h => toW([h.x, h.y, (h.za + h.zb) / 2])),
        },
    };
}

// ── Z band: seams are contours, so nothing is clipped ─────────────────────────────
async function bandMode(band, ctx) {
    const { B, C, runMesh, payloadBase, warnings, crossingHits, toW } = ctx;
    const eps = 1e-6;
    const zOf = c => c[0][2];
    const inBand = C.filter(c => zOf(c) >= band.zMin - eps && zOf(c) <= band.zMax + eps);
    const below = C.filter(c => zOf(c) < band.zMin - eps), above = C.filter(c => zOf(c) > band.zMax + eps);
    if (inBand.length < 2) { warnings.push(`Stitch band ${band.zMin}..${band.zMax} holds fewer than 2 contours.`); console.warn('[Hybrid]', warnings.at(-1)); return null; }
    if (crossingHits.some(h => !(inBand.includes(C[h.lineA]) && inBand.includes(C[h.lineB]))))
        warnings.push('Some contours cross outside the stitch band; CGAL interpolates Z at those crossings.');

    const patch = zStitch(inBand);
    orientConsistent(patch);

    const zs = inBand.map(zOf);
    const seamDefs = [];
    if (below.length) seamDefs.push({ z: Math.min(...zs), side: 'low', contours: below });
    if (above.length) seamDefs.push({ z: Math.max(...zs), side: 'high', contours: above });

    const nearestIdx = p => B.reduce((best, q, i) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); return d < best.d ? { i, d } : best; }, { i: -1, d: Infinity });
    const arc = (from, to) => { const r = []; for (let i = from; ; i = (i + 1) % B.length) { r.push(B[i]); if (i === to) break; } return r; };

    const cgalPolys = [], cgalContours = [], seams = [];
    for (const s of seamDefs) {
        const seam = inBand.filter(c => Math.abs(zOf(c) - s.z) < eps);
        if (seam.length !== 1) { warnings.push(`Expected one seam contour at Z ${s.z}, found ${seam.length}.`); console.warn('[Hybrid]', warnings.at(-1)); return null; }
        const S = seam[0], ia = nearestIdx(S[0]), ib = nearestIdx(S[S.length - 1]);
        if (ia.d > 1e-3 || ib.d > 1e-3) {
            warnings.push(`Seam contour at Z ${s.z} does not end on boundary vertices (off by ${Math.max(ia.d, ib.d).toFixed(4)}).`);
            console.warn('[Hybrid]', warnings.at(-1)); return null;
        }
        // The CGAL side of this seam is the boundary arc reaching furthest beyond the band.
        const a1 = arc(ia.i, ib.i), a2 = arc(ib.i, ia.i);
        const reach = a => s.side === 'low' ? Math.min(...a.map(v => v[2])) : -Math.max(...a.map(v => v[2]));
        const outer = reach(a1) < reach(a2) ? a1 : a2;
        const sub = subdivide(S); // identical to the stitch rail, so both sides share every vertex
        const end = outer[outer.length - 1];
        const back = Math.hypot(sub[0][0] - end[0], sub[0][1] - end[1]) < 1e-6 ? sub : [...sub].reverse();
        cgalPolys.push([...outer, ...back.slice(1, -1)]);
        cgalContours.push(...s.contours);
        seams.push({ closed: false, pts: sub });
    }

    const cgal = { verts: [], tris: [], orphans: 0, droppedSlope: 0 };
    if (cgalPolys.length) {
        const data = await runMesh({ ...payloadBase, polylines: cgalContours.map(c => c.map(toW)), boundaries: cgalPolys.map(p => p.map(toW)) });
        appendCgal(cgal, data, ctx);
    }
    const bandArea = Math.abs(polyArea(B)) - cgalPolys.reduce((s, p) => s + Math.abs(polyArea(p)), 0);
    const patchArea = patch.tris.reduce((s, t) => s + Math.abs(signedArea(...t.map(i => patch.verts[i]))), 0);
    const stitchCoverage = bandArea > 0 ? Math.min(1, patchArea / bandArea) : 1;
    if (stitchCoverage < 0.999)
        warnings.push(`The stitch covers ${(100 * stitchCoverage).toFixed(1)}% of the band — the boundary runs past its outermost contours there.`);
    return { patch, cgal, seams, regions: [{ kind: 'band', poly: [] }], stitchCoverage };
}

// ── polygon regions (explicit + crossing capsules): clip the stitch, CGAL gets holes ─────
async function polygonMode(explicit, ctx) {
    const { B, C, O, runMesh, payloadBase, warnings, crossingHits, toW } = ctx;
    let regions = explicit.filter(r => r.poly && r.poly.length >= 3).map(r => {
        const pts = closeless(r.poly).map(p => [p[0] - O[0], p[1] - O[1]]);
        const hull = convexHull(pts);
        if (hull.length < pts.length) console.warn('[Hybrid] Stitch region is not convex; using its convex hull.');
        return { kind: 'region', poly: hull };
    });
    // Crossing zones not already inside an explicit region get their own capsule.
    const loose = crossingHits.filter(h => !regions.some(r => insideConvex([h.x, h.y], r.poly)));
    regions.push(...crossingRegions(loose));

    const full = zStitch(C);
    const usable = [];
    for (const r of regions) {
        const clearance = Math.min(...r.poly.map(p => distToRing(p, B) * (pointInPolygon(p, B) ? 1 : -1)));
        const uncovered = r.poly.filter(p => !coveredBy(p, full)).length;
        if (clearance < MIN_CLEARANCE) { warnings.push(`A ${r.kind} stitch region comes within ${clearance.toFixed(1)} of the boundary (or crosses it); skipped.`); continue; }
        if (uncovered) { warnings.push(`${uncovered} outline points of a ${r.kind} stitch region are not on the stitched surface; skipped.`); continue; }
        if (usable.some(u => r.poly.some(p => insideConvex(p, u.poly)) || u.poly.some(p => insideConvex(p, r.poly)))) { warnings.push(`Overlapping stitch regions; skipped one.`); continue; }
        usable.push(r);
    }
    if (!usable.length) { warnings.forEach(w => console.warn('[Hybrid]', w)); return null; }

    // Clip the full stitch to each region; each patch's open edge is its seam ring.
    const cv = [], ct = [];
    for (const r of usable) for (const t of full.tris) {
        const poly = clipToConvex(t.map(i => full.verts[i]), r.poly);
        for (let i = 1; i + 1 < poly.length; i++) {
            if (Math.abs(signedArea(poly[0], poly[i], poly[i + 1])) < 1e-9) continue;
            const b = cv.length; cv.push(poly[0], poly[i], poly[i + 1]); ct.push([b, b + 1, b + 2]);
        }
    }
    const patch = weld(cv, ct, WELD_TOL);
    orientConsistent(patch);
    const pt = topology(patch);
    if (pt.loops.length !== usable.length) {
        warnings.push(`Stitch patches have ${pt.loops.length} open loops for ${usable.length} regions — a region edge does not sit on a single stitched layer.`);
        warnings.forEach(w => console.warn('[Hybrid]', w));
        return null;
    }
    const seams = pt.loops.map(l => ({ closed: true, pts: l.map(i => patch.verts[i]) }));

    let trimmed = C;
    for (const r of usable) trimmed = trimmed.flatMap(c => trimOutsideConvex(c, r.poly));
    const left = findCrossings(trimmed).length;
    if (left) warnings.push(`${left} contour crossings remain outside the stitch regions; CGAL interpolates Z there.`);

    const cgal = { verts: [], tris: [], orphans: 0, droppedSlope: 0 };
    const data = await runMesh({ ...payloadBase, polylines: trimmed.map(c => c.map(toW)), boundaries: [B.map(toW)], holes: seams.map(s => s.pts.map(toW)) });
    appendCgal(cgal, data, ctx);
    return { patch, cgal, seams, regions: usable, stitchCoverage: 1 };
}

// ── strips: no regions to draw; the contours themselves decide ──────────────────────
// The contours cut the boundary disk into strips ("faces"). Neighbours are found from the
// order in which contour ends sit along the boundary, so a fold that overlaps itself in plan
// is still split correctly. A strip whose outline crosses itself in plan is folded → z-stitch;
// every other strip → CGAL, each strip as its own boundary. Neighbouring strips share whole
// contours (same subdivided points), so every seam is a contour and nothing is clipped.
const STRIP_END_SNAP = 3.0;     // contour ends this close to the boundary count as on it
const STRIP_LOOP_GAP = 5.0;     // a contour whose ends are this close is a closed loop
const STRIP_WELD_TOL = 1e-3;    // float32 stitch output at ~1 km from the local origin is ~1e-4 off

async function stripMode(ctx) {
    const { B, C, runMesh, payloadBase, warnings, toW } = ctx;
    const N = B.length;
    const ringSegs = B.map((a, i) => [a, B[(i + 1) % N]]);
    const project = q => {
        let best = { d: Infinity };
        for (let i = 0; i < N; i++) {
            const a = B[i], b = B[(i + 1) % N], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
            const t = L ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L)) : 0;
            const d = Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
            if (d < best.d) best = { d, i, t };
        }
        if (best.t > 1 - 1e-9) { best.i = (best.i + 1) % N; best.t = 0; }
        return best;
    };
    const ptAt = (i, t) => { const [a, b] = ringSegs[i]; return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]; };

    // 1. Sort the contours: boundary-to-boundary (chords), closed loops, and left out.
    const levels = [...new Set(C.map(c => c[0][2]))].sort((a, b) => a - b);
    const steps = levels.slice(1).map((z, i) => z - levels[i]).sort((a, b) => a - b);
    const zTol = Math.max(10, 3 * (steps[Math.floor(steps.length / 2)] || 0));
    const chords = [], loops = [], leftOut = [];
    for (const c0 of C) {
        const c = c0.map(v => v), z = c[0][2];
        const a = project(c[0]), b = project(c[c.length - 1]);
        const gap = Math.hypot(c[0][0] - c[c.length - 1][0], c[0][1] - c[c.length - 1][1]);
        if (a.d <= STRIP_END_SNAP && b.d <= STRIP_END_SNAP) {
            // A contour whose Z is far from the boundary Z at both of its ends is mis-elevated.
            const za = ptAt(a.i, a.t)[2], zb = ptAt(b.i, b.t)[2];
            if (Math.abs(za - z) > zTol && Math.abs(zb - z) > zTol) { leftOut.push(`Z ${z} contour: boundary is at ${za.toFixed(0)} / ${zb.toFixed(0)} where it ends`); continue; }
            chords.push({ p: subdivide(c), z, a, b });
        } else if (gap < STRIP_LOOP_GAP && c.length > 3) loops.push([...c, c[0]]);
        else leftOut.push(`Z ${z} contour (${c.length} pts): ends ${a.d.toFixed(1)} / ${b.d.toFixed(1)} from the boundary`);
    }
    if (leftOut.length) warnings.push(`Strip mode left out ${leftOut.length} contour(s): ${leftOut.join('; ')}.`);
    if (chords.length < 1) return { unsupported: 'no contour runs from boundary to boundary' };

    // 2. Faces: walk boundary arc → contour → boundary arc … around each strip.
    const nodes = [];
    chords.forEach((c, ci) => { nodes.push({ ci, end: 0, ...c.a, par: c.a.i + c.a.t }); nodes.push({ ci, end: 1, ...c.b, par: c.b.i + c.b.t }); });
    const order = [...nodes.keys()].sort((p, q) => nodes[p].par - nodes[q].par);
    const rank = new Map(order.map((n, k) => [n, k]));
    const partner = n => n ^ 1; // nodes are pushed in (end 0, end 1) pairs
    const arcPts = k => {
        const a = nodes[order[k]], b = nodes[order[(k + 1) % order.length]];
        const fd = x => ((x - a.par) % N + N) % N, target = fd(b.par) || N;
        const pts = [ptAt(a.i, a.t)];
        for (let s = 1; s <= N; s++) { const j = (a.i + s) % N, f = fd(j); if (f <= 0 || f >= target) break; pts.push(B[j]); }
        pts.push(ptAt(b.i, b.t));
        return dedupe(pts);
    };
    const used = new Set(), faces = [];
    for (let k0 = 0; k0 < order.length; k0++) {
        if (used.has(k0)) continue;
        const items = [];
        let k = k0;
        for (let guard = 0; guard <= order.length; guard++) {
            used.add(k);
            items.push({ type: 'arc', pts: arcPts(k) });
            const n = order[(k + 1) % order.length], c = chords[nodes[n].ci];
            items.push({ type: 'c', ci: nodes[n].ci, z: c.z, pts: nodes[n].end ? [...c.p].reverse() : c.p });
            k = rank.get(partner(n));
            if (k === k0) break;
        }
        let ring = dedupe(items.flatMap(it => it.pts));
        if (ring.length > 1 && Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 1e-9) ring.pop();
        faces.push({ items, ring, folds: ringSelfCrossings(ring) });
    }
    const folded = faces.filter(f => f.folds > 0);
    if (!folded.length) return null;   // nothing folded: plain CGAL is fine

    // 3. Stitch the folded strips: the contour on a level of its own vs the rest of the outline.
    const sv = [], st = [];
    let skipped = 0;
    for (const f of folded) {
        const cs = f.items.map((it, j) => ({ it, j })).filter(x => x.it.type === 'c');
        const count = {};
        cs.forEach(x => { count[x.it.z] = (count[x.it.z] || 0) + 1; });
        const r1 = cs.find(x => count[x.it.z] === 1);
        let g = null;
        if (r1) {
            // Rail 2 is the rest of the outline minus the two boundary arcs touching rail 1.
            // (Keeping those arcs makes rail 2 start on rail 1's ends; uniformStitch then builds
            // zero-length rungs whose rows collapse into overlapping triangles.)
            const L = f.items.length;
            let rail2 = [];
            if (cs.length === 1) rail2 = f.items[(r1.j + 1) % L].pts;
            else for (let s = 2; s <= L - 2; s++) rail2 = rail2.concat(f.items[(r1.j + s) % L].pts);
            g = uniformStitch(r1.it.pts.map(v => new THREE.Vector3(...v)), dedupe(rail2).map(v => new THREE.Vector3(...v)), MAX_EDGE);
        }
        if (!g) { f.folds = 0; skipped++; continue; }   // can't stitch: CGAL takes it (with crossing vertices)
        const pos = g.attributes.position.array, idx = g.index.array, base = sv.length;
        for (let q = 0; q < pos.length; q += 3) sv.push([pos[q], pos[q + 1], pos[q + 2]]);
        for (let q = 0; q < idx.length; q += 3) st.push([base + idx[q], base + idx[q + 1], base + idx[q + 2]]);
        g.dispose();
    }
    if (skipped) warnings.push(`${skipped} folded strip(s) have no contour on a level of their own and were left to CGAL.`);
    const patch = weld(sv, st, STRIP_WELD_TOL);
    orientConsistent(patch);

    // 4. CGAL on every other strip, each as its own boundary. Slope filter off: a steep strip
    //    is still part of the surface, and dropping it would leave a hole between strips.
    const flat = faces.filter(f => f.folds === 0);
    if (loops.length && folded.some(f => f.folds && loops.some(l => pointInPolygon(l[0], f.ring))))
        warnings.push('A closed contour loop lies inside a stitched strip; the stitch ignores it.');
    const cgal = { verts: [], tris: [], orphans: 0, droppedSlope: 0 };
    if (flat.length) {
        const data = await runMesh({ ...payloadBase, slope: 0, polylines: loops.map(l => l.map(toW)), boundaries: flat.map(f => f.ring.map(toW)) });
        appendCgal(cgal, data, ctx);
        // The subdivided contours have runs of collinear points; mesh_gen's weld grid nudges
        // them off the line and the CDT can keep a hair-thin triangle along a contour, which
        // overlaps the real one beside it (non-manifold edge). Drop triangles under 1 mm thick.
        const before = cgal.tris.length;
        cgal.tris = cgal.tris.filter(t => {
            const [a, b, c] = t.map(i => cgal.verts[i]);
            const longest = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1]), Math.hypot(a[0] - c[0], a[1] - c[1]));
            return longest > 0 && 2 * Math.abs(signedArea(a, b, c)) / longest > 1e-3;
        });
        cgal.slivers = before - cgal.tris.length;
    }

    // Seams: contours with a stitched strip on one side and a CGAL strip on the other.
    const sides = chords.map(() => new Set());
    faces.forEach(f => f.items.forEach(it => { if (it.type === 'c') sides[it.ci].add(f.folds > 0 ? 's' : 'c'); }));
    const seams = chords.filter((_, i) => sides[i].size === 2).map(c => ({ closed: false, pts: c.p }));
    const regions = faces.filter(f => f.folds > 0).map(f => ({ kind: 'strip', poly: f.ring }));
    return {
        patch, cgal, seams, regions, stitchCoverage: 1, weldTol: STRIP_WELD_TOL,
        stats: { strips: faces.length, stitchedStrips: regions.length, cgalStrips: flat.length, closedLoops: loops.length, leftOut: leftOut.length },
    };
}

// Number of proper crossings between non-adjacent edges of a closed ring, in XY.
function ringSelfCrossings(R) {
    const n = R.length;
    const bb = R.map((a, i) => { const b = R[(i + 1) % n]; return [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])]; });
    let hits = 0;
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const A = bb[i], D = bb[j];
        if (A[1] < D[0] || D[1] < A[0] || A[3] < D[2] || D[3] < A[2]) continue;
        const P = R[i], Q = R[(i + 1) % n], S = R[j], T = R[(j + 1) % n];
        const dx = Q[0] - P[0], dy = Q[1] - P[1], ex = T[0] - S[0], ey = T[1] - S[1], den = cross2(dx, dy, ex, ey);
        if (Math.abs(den) < 1e-12) continue;
        const t = cross2(S[0] - P[0], S[1] - P[1], ex, ey) / den, u = cross2(S[0] - P[0], S[1] - P[1], dx, dy) / den;
        if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) hits++;
    }
    return hits;
}

function appendCgal(cgal, data, { O }) {
    for (const m of data.meshes || []) {
        const base = cgal.verts.length;
        for (const v of m.vertices) cgal.verts.push([v[0] - O[0], v[1] - O[1], v[2]]);
        for (const t of m.triangles) cgal.tris.push(t.map(i => i + base));
        cgal.droppedSlope += m.dropped_slope || 0;
        cgal.slopeUsed = m.slope_used;
    }
    cgal.orphans += data.num_orphan_contours || 0;
}
