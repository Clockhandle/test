// slicer_ui.js — CGAL PMP::Slicer front-end
//
// buildSlice()   → sends CDT input + slice params to /api/mesh, returns slice JSON
// renderSlices() → draws the polylines in the Three.js scene
// exportDxf()    → generates and downloads a layered DXF file

import * as THREE from 'three';

// ── axis mapping ──────────────────────────────────────────────────────────────
export const AXIS_MAP = {
    'z+': [0, 0,  1],
    'z-': [0, 0, -1],
    'x+': [1, 0,  0],
    'x-': [-1, 0, 0],
    'y+': [0,  1, 0],
    'y-': [0, -1, 0],
};

// ── buildSlice ────────────────────────────────────────────────────────────────
// Sends the full CDT input plus slice_axis / slice_step to /api/mesh and
// returns the parsed JSON response ({ ok, action_mode:'slice', slices:[...] }).
export async function buildSlice(rawDataSegments, opts = {}) {
    const { axis = [0, 0, 1], step = 5.0 } = opts;

    if (!rawDataSegments || rawDataSegments.length === 0) {
        alert('No contour data loaded. Upload a JSON first.');
        return null;
    }

    // Flatten all segments into CDT payload arrays (no per-group splitting needed
    // for slicing — we want to slice the combined terrain).
    const polylines = [], boundaries = [], holes = [], breaklines = [], scatter = [];
    for (const seg of rawDataSegments) {
        if (!seg || seg.length === 0) continue;
        const poly = seg.map(v => [v.x, v.y, v.z]);
        if (seg.isBoundary)       boundaries.push(poly);
        else if (seg.isHole)      holes.push(poly);
        else if (seg.isBreakLine) breaklines.push(poly);
        else if (seg.isBemat) {
            if (poly.length === 1) scatter.push(poly[0]);
            else                   polylines.push(poly);
        } else polylines.push(poly);
    }

    if (boundaries.length === 0) {
        alert('No boundary segments found in the dataset. Draw boundaries or ensure the JSON contains boundary lines.');
        return null;
    }

    let data;
    try {
        const resp = await fetch('/api/mesh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'slice',
                slice_axis: axis,
                slice_step: step,
                polylines,
                boundaries,
                holes,
                breaklines,
                scatter,
            }),
        });
        data = await resp.json();
        if (!resp.ok || !data.ok) throw new Error(data.error || resp.statusText);
    } catch (e) {
        console.error('[slicer] request failed:', e);
        alert('Slice failed: ' + e.message);
        return null;
    }

    const n = data.num_slices ?? 0;
    console.log(`[slicer] ${n} slice level(s), axis=(${axis}), step=${step}`);
    return data;
}

// ── renderSlices ──────────────────────────────────────────────────────────────
// Draws the slice polylines as coloured Three.js Line objects in a dedicated
// 'Slice_Lines' group inside meshGroup. Replaces any previous slice render.
export function renderSlices(sliceData, meshGroup) {
    // Dispose old group.
    let grp = meshGroup.getObjectByName('Slice_Lines');
    if (grp) {
        grp.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material)  o.material.dispose();
        });
        meshGroup.remove(grp);
    }

    grp = new THREE.Group();
    grp.name = 'Slice_Lines';
    meshGroup.add(grp);

    const slices = sliceData.slices || [];
    const total  = slices.reduce((s, sl) => s + sl.polylines.length, 0) || 1;
    let idx = 0;

    for (const slice of slices) {
        const hue   = (idx / total) * 360;
        const color = new THREE.Color(`hsl(${Math.floor(hue)}, 100%, 65%)`);
        const mat   = new THREE.LineBasicMaterial({ color, depthTest: false });

        for (const poly of slice.polylines) {
            if (poly.length < 2) { idx++; continue; }
            const buf = new Float32Array(poly.length * 3);
            for (let i = 0; i < poly.length; i++) {
                buf[i * 3]     = poly[i][0];
                buf[i * 3 + 1] = poly[i][1];
                buf[i * 3 + 2] = poly[i][2];
            }
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(buf, 3));
            grp.add(new THREE.Line(geom, mat));
            idx++;
        }
    }

    console.log(`[slicer] rendered ${idx} polyline(s) in scene`);
    return grp;
}

// ── exportDxf ─────────────────────────────────────────────────────────────────
// Generates an AutoCAD R12 (AC1009) DXF and triggers a browser download.
// R12 is the most universally compatible format — every AutoCAD version reads it.
//
// Projection rules (3D → 2D):
//   dominant axis = Z  → keep X, Y   (plan view)
//   dominant axis = X  → keep Y, Z   (side elevation)
//   dominant axis = Y  → keep X, Z   (front elevation)
//
// Layers: Contour_NEG_<N> for negative elevations, Contour_<N> for positive.
// Text:   Z-height label placed at the first vertex of each polyline.
export function exportDxf(sliceData, opts = {}) {
    const { axis = [0, 0, 1], filename = 'contours.dxf' } = opts;

    const slices = sliceData?.slices;
    if (!slices || slices.length === 0) { alert('No slice data to export.'); return; }

    // Determine which coordinate to drop for the 2D projection.
    const absAxis = axis.map(Math.abs);
    const dom = absAxis.indexOf(Math.max(...absAxis)); // 0=X, 1=Y, 2=Z
    const project = pt =>
        dom === 2 ? [pt[0], pt[1]] :
        dom === 0 ? [pt[1], pt[2]] :
                    [pt[0], pt[2]];

    const layerName = level => {
        // Keep one decimal to avoid rounding collisions (e.g. 0.0 vs 0.5 → both "0").
        const s = level.toFixed(1).replace('.', '_').replace('-', 'NEG_');
        return `Contour_${s}`;
    };

    const contourLayers = [...new Set(slices.map(s => layerName(s.level)))];

    // ── HEADER ───────────────────────────────────────────────────────────────
    let dxf = '0\nSECTION\n2\nHEADER\n'
            + '9\n$ACADVER\n1\nAC1009\n'
            + '9\n$INSUNITS\n70\n6\n'   // 6 = metres
            + '0\nENDSEC\n';

    // ── TABLES ───────────────────────────────────────────────────────────────
    // R12 only requires LTYPE and LAYER tables.
    dxf += '0\nSECTION\n2\nTABLES\n';

    // LTYPE table — must include CONTINUOUS
    dxf += '0\nTABLE\n2\nLTYPE\n70\n1\n'
         + '0\nLTYPE\n2\nCONTINUOUS\n70\n64\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n'
         + '0\nENDTAB\n';

    // LAYER table — layer 0 (required) + contour layers + Labels
    const allLayers = ['0', 'Labels', ...contourLayers];
    dxf += '0\nTABLE\n2\nLAYER\n70\n' + allLayers.length + '\n';
    dxf += '0\nLAYER\n2\n0\n70\n0\n62\n7\n6\nCONTINUOUS\n';
    dxf += '0\nLAYER\n2\nLabels\n70\n0\n62\n3\n6\nCONTINUOUS\n';
    for (const lyr of contourLayers)
        dxf += '0\nLAYER\n2\n' + lyr + '\n70\n0\n62\n7\n6\nCONTINUOUS\n';
    dxf += '0\nENDTAB\n';

    dxf += '0\nENDSEC\n';

    // ── ENTITIES ─────────────────────────────────────────────────────────────
    dxf += '0\nSECTION\n2\nENTITIES\n';

    for (const slice of slices) {
        const lyr    = layerName(slice.level);
        const zLabel = slice.level.toFixed(2);

        for (const poly of slice.polylines) {
            if (poly.length < 2) continue;
            const pts2d = poly.map(project);

            // R12 POLYLINE / VERTEX / SEQEND
            dxf += '0\nPOLYLINE\n8\n' + lyr + '\n66\n1\n70\n0\n';
            for (const [x, y] of pts2d)
                dxf += '0\nVERTEX\n8\n' + lyr + '\n10\n' + x.toFixed(4) + '\n20\n' + y.toFixed(4) + '\n';
            dxf += '0\nSEQEND\n8\n' + lyr + '\n';
        }

        // One TEXT label per slice level — offset in Y by slice index so they don't stack.
        const firstPoly = slice.polylines.find(p => p.length > 0);
        if (firstPoly) {
            const [lx, ly] = project(firstPoly[0]);
            const labelOffset = slices.indexOf(slice) * 3.0; // 3 units apart in Y
            dxf += '0\nTEXT\n8\nLabels\n'
                 + '10\n' + lx.toFixed(4) + '\n'
                 + '20\n' + (ly + labelOffset).toFixed(4) + '\n'
                 + '40\n2.5\n'
                 + '1\nZ=' + zLabel + '\n';
        }
    }

    dxf += '0\nENDSEC\n0\nEOF\n';

    // Trigger download.
    const blob = new Blob([dxf], { type: 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log(`[slicer] DXF exported: ${filename} — ${slices.length} levels, ${contourLayers.length} layers`);
}

