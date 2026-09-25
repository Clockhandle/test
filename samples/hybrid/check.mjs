// Runs both hybrid samples through the app's own code (parseMeshJson → buildCgalMesh) against a
// running server, with and without hybrid mode, and prints the mesh checks per surface.
//
//   PORT=3001 npm start                 # in one terminal
//   node samples/hybrid/check.mjs       # in another (BASE=http://localhost:3001 by default)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const BASE = process.env.BASE || 'http://localhost:3001';

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(url.startsWith('/') ? BASE + url : url, init);
globalThis.alert = msg => print('[alert]', msg);
const print = console.log;
console.log = () => {}; // silence the meshers' debug logging; warnings still show

const THREE = await import('file:///' + path.join(root, 'node_modules/three/build/three.module.js'));
const { parseMeshJson } = await import('file:///' + path.join(root, 'public/points_extractor.js'));
const { buildCgalMesh } = await import('file:///' + path.join(root, 'public/cgal_mesher.js'));

function summarise(group) {
    const rows = [];
    group.getObjectByName('CGAL_Meshes').traverse(o => {
        if (!o.isMesh) return;
        const T = o.userData.rawTriangles, E = new Map();
        for (const t of T) for (let e = 0; e < 3; e++) {
            const a = t[e], b = t[(e + 1) % 3], k = a < b ? `${a},${b}` : `${b},${a}`;
            E.set(k, (E.get(k) || 0) + 1);
        }
        const adj = new Map();
        let nonManifold = 0;
        for (const [k, c] of E) {
            if (c > 2) nonManifold++;
            if (c !== 1) continue;
            const [a, b] = k.split(',').map(Number);
            (adj.get(a) || adj.set(a, []).get(a)).push(b);
            (adj.get(b) || adj.set(b, []).get(b)).push(a);
        }
        let loops = 0;
        const seen = new Set();
        for (const s of adj.keys()) {
            if (seen.has(s)) continue;
            loops++;
            for (const st = [s]; st.length;) { const v = st.pop(); if (!seen.has(v)) { seen.add(v); st.push(...adj.get(v)); } }
        }
        const h = o.userData.hybrid;
        rows.push(`${o.userData.featureType.padEnd(4)} ${String(T.length).padStart(5)} tris` +
            (h ? ` (stitch ${h.stitchTriangles} + CGAL ${h.cgalTriangles}, ${h.mode}), seam ${h.seamSegments - h.seamOpen}/${h.seamSegments} shared, overhang ${h.overhang}`
               : ' (plain CGAL)') +
            `, open loops ${loops}, non-manifold ${nonManifold}`);
    });
    return rows;
}

for (const file of ['hybrid_test1_circle.json', 'hybrid_test2_3_band_crossing.json']) {
    const segs = parseMeshJson(JSON.parse(fs.readFileSync(path.join(here, file), 'utf8')));
    segs.sort((a, b) => (!a.length || !b.length) ? 0 : b[0].z - a[0].z); // as main.js does on load
    print(`\n${file}`);
    for (const [label, opts] of [['CGAL Mesh  ', {}], ['Hybrid Mesh', { hybrid: true }]]) {
        const group = new THREE.Group();
        await buildCgalMesh(segs, group, opts);
        for (const row of summarise(group)) print(`  ${label}  ${row}`);
    }
}
