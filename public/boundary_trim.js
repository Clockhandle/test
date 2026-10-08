// Hard trim of loaded lines to their boundary, looking straight down (XY only).
// Every vertex outside the boundary is deleted; the line is split where vertices were
// deleted, and any piece left with fewer than 2 vertices is dropped (so a 2-vertex line
// with one end outside disappears). Lines are trimmed only against boundaries of their
// own group (viaName + blockName + featureType, the same grouping cgal_mesher.js uses);
// a group with no boundary is left untouched.
//
// A group can hold several boundaries stacked at different Z (e.g. two Bề mặt surfaces
// overlapping in plan). Each line belongs to exactly one of them — see ownerBoundary() —
// so a boundary never trims or meshes the lines of the surface above or below it.

const ON_EDGE_TOL = 0.01;  // vertices this close to the boundary line count as inside
                           // (CAD contours usually end exactly on it)

// Points are THREE.Vector3 (loaded segments) or [x, y, z] arrays (mesher payloads).
const X = p => p.x ?? p[0], Y = p => p.y ?? p[1], Z = p => p.z ?? p[2];

export const groupKey = seg =>
    `${seg.viaName || '__default__'}||${seg.blockName || '__default__'}||${seg.featureType || '__other__'}`;

function pointInPolygon(x, y, P) {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const a = P[i], b = P[j];
        if ((Y(a) > y) !== (Y(b) > y) && x < (X(b) - X(a)) * (y - Y(a)) / (Y(b) - Y(a)) + X(a)) c = !c;
    }
    return c;
}

function nearRing(x, y, P, tol) {
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const a = P[j], b = P[i];
        const dx = X(b) - X(a), dy = Y(b) - Y(a), L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((x - X(a)) * dx + (y - Y(a)) * dy) / L)) : 0;
        if (Math.hypot(x - X(a) - t * dx, y - Y(a) - t * dy) <= tol) return true;
    }
    return false;
}

const insideRing = (v, R) => pointInPolygon(X(v), Y(v), R) || nearRing(X(v), Y(v), R, ON_EDGE_TOL);

function zStats(pts) {
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const p of pts) { const z = Z(p); if (z < lo) lo = z; if (z > hi) hi = z; sum += z; }
    return { lo, hi, mean: sum / pts.length };
}

/**
 * The one boundary a line belongs to: among the rings containing any of its vertices in
 * plan, the one closest in Z (gap between Z ranges, then difference of mean Z, then the
 * most vertices inside). Returns the ring's index, or -1 when no ring contains it.
 */
export function ownerBoundary(line, rings) {
    if (rings.length === 1) return line.some(v => insideRing(v, rings[0])) ? 0 : -1;
    const lz = zStats(line);
    let best = -1, bestKey = null;
    rings.forEach((R, i) => {
        const inside = line.filter(v => insideRing(v, R)).length;
        if (inside === 0) return;
        const rz = zStats(R);
        const key = [Math.max(0, rz.lo - lz.hi, lz.lo - rz.hi), Math.abs(rz.mean - lz.mean), -inside];
        if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] &&
            (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
            best = i; bestKey = key;
        }
    });
    return best;
}

// Copy the flags (isBemat, viaName, handle, …) from the source line onto a piece.
function withFlags(piece, src) {
    for (const k of Object.keys(src)) if (!/^\d+$/.test(k)) piece[k] = src[k];
    return piece;
}

/**
 * @param {Array<Array<THREE.Vector3>>} segments  parsed lines (flags as array properties)
 * @returns {{ segments: Array, removedVerts: number, droppedLines: number, trimmedLines: number }}
 */
export function trimToBoundaries(segments) {
    const rings = new Map();
    for (const s of segments)
        if (s.isBoundary && s.length >= 3) (rings.get(groupKey(s)) || rings.set(groupKey(s), []).get(groupKey(s))).push(s);

    const out = [];
    let removedVerts = 0, droppedLines = 0, trimmedLines = 0;
    for (const seg of segments) {
        const G = rings.get(groupKey(seg));
        if (!G || seg.length === 0 || seg.isBoundary || seg.isHole || seg.isStitchRegion || seg.isDuongLo) {
            out.push(seg);
            continue;
        }
        const owner = ownerBoundary(seg, G);
        if (owner < 0) { removedVerts += seg.length; droppedLines++; continue; }
        const R = G[owner];
        const keep = seg.map(v => insideRing(v, R));
        const nOut = keep.filter(k => !k).length;
        if (nOut === 0) { out.push(seg); continue; }
        removedVerts += nOut;

        let pieces = [];
        let cur = null;
        seg.forEach((v, i) => {
            if (keep[i]) { if (!cur) { cur = []; pieces.push(cur); } cur.push(v); }
            else cur = null;
        });
        // A closed loop cut somewhere in the middle: its last and first runs are one piece.
        const closed = seg.length > 2 && seg[0].distanceTo(seg[seg.length - 1]) < 1e-9;
        if (closed && pieces.length > 1 && keep[0] && keep[seg.length - 1])
            pieces = [[...pieces.pop(), ...pieces[0].slice(1)], ...pieces.slice(1)];

        pieces = pieces.filter(p => p.length >= 2);
        if (pieces.length === 0) { droppedLines++; continue; }
        trimmedLines++;
        for (const p of pieces) out.push(withFlags(p, seg));
    }
    return { segments: out, removedVerts, droppedLines, trimmedLines };
}
