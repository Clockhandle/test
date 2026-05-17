// Node-side driver for cpp/mesh_gen.exe.
//
// Loads a contour-polyline JSON file, converts it to the simple text format
// the C++ binary expects, spawns the binary, parses its JSON output, and
// prints a summary. This is the same flow the eventual /api/mesh server
// endpoint will use.
//
// Expected input JSON shape (flexible; both forms accepted):
//   1. { "polylines": [ [ [x,y,z], [x,y,z], ... ], ... ] }
//   2. [ [ [x,y,z], ... ], ... ]                // bare array of polylines
//   3. [ { "points": [ [x,y,z], ... ] }, ... ]  // polylines as objects
//
// Optional top-level "alpha" number overrides the auto-computed threshold.
//
// Usage:
//   node test_mesh_gen.cjs <contours.json> [alpha]
//   node test_mesh_gen.cjs                          (uses built-in tiny demo)

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const candidates = [
    path.join(__dirname, 'cpp', 'build', 'Release', 'mesh_gen.exe'),
    path.join(__dirname, 'cpp', 'build', 'Debug', 'mesh_gen.exe'),
    path.join(__dirname, 'cpp', 'build', 'mesh_gen.exe'),
    path.join(__dirname, 'cpp', 'build', 'mesh_gen'),
];
const exe = candidates.find(p => fs.existsSync(p));
if (!exe) {
    console.error('mesh_gen binary not found. Build it first:');
    console.error('  cmake --build cpp/build --config Release');
    console.error('Looked in:');
    candidates.forEach(c => console.error('  ' + c));
    process.exit(1);
}

// ----- load polylines -----
let polylines;
let alphaOverride = null;

const inputPath = process.argv[2];
if (process.argv[3]) alphaOverride = Number(process.argv[3]);

if (inputPath) {
    const raw = fs.readFileSync(inputPath, 'utf8');
    const parsed = JSON.parse(raw);
    polylines = extractPolylines(parsed);
    if (alphaOverride == null && parsed && typeof parsed.alpha === 'number') {
        alphaOverride = parsed.alpha;
    }
    if (!polylines || polylines.length === 0) {
        console.error('No polylines extracted from', inputPath);
        process.exit(1);
    }
    console.log(`Loaded ${polylines.length} polylines from ${inputPath}`);
} else {
    // Tiny built-in demo: two stacked contour squares + a small offset patch.
    polylines = [
        // square at z=0
        [[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,0]],
        // square at z=5
        [[2,2,5],[8,2,5],[8,8,5],[2,8,5],[2,2,5]],
        // disconnected patch far away — alpha filter should drop bridges to main mesh
        [[100,100,2],[103,100,2],[103,103,2],[100,103,2],[100,100,2]],
    ];
    console.log('Using built-in demo (3 polylines).');
}

function extractPolylines(p) {
    if (p && Array.isArray(p.polylines)) return p.polylines.map(normalizePoly);
    if (Array.isArray(p)) {
        if (p.length === 0) return [];
        // bare array of polylines or array of objects?
        if (Array.isArray(p[0])) return p.map(normalizePoly);
        if (p[0] && Array.isArray(p[0].points)) return p.map(o => normalizePoly(o.points));
    }
    return null;
}
function normalizePoly(poly) {
    // accept [x,y,z] or {x,y,z}
    return poly.map(v => {
        if (Array.isArray(v)) return [Number(v[0]), Number(v[1]), Number(v[2] ?? 0)];
        return [Number(v.x), Number(v.y), Number(v.z ?? 0)];
    });
}

// ----- build text input for the C++ binary -----
const lines = [];
lines.push(`POLYLINES ${polylines.length}`);
let totalVerts = 0;
for (const poly of polylines) {
    lines.push(`POLY ${poly.length}`);
    for (const v of poly) lines.push(`${v[0]} ${v[1]} ${v[2]}`);
    totalVerts += poly.length;
}
if (alphaOverride != null && Number.isFinite(alphaOverride)) {
    lines.push(`ALPHA ${alphaOverride}`);
}
const stdinPayload = lines.join('\n') + '\n';

console.log(`Sending ${polylines.length} polylines, ${totalVerts} vertices to ${path.basename(exe)}`);
if (alphaOverride != null) console.log(`Alpha override: ${alphaOverride}`);

const t0 = Date.now();
const result = spawnSync(exe, [], { input: stdinPayload, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const dt = Date.now() - t0;

if (result.error) {
    console.error('Failed to spawn:', result.error);
    process.exit(1);
}
if (result.status !== 0) {
    console.error('Exit code:', result.status);
    console.error('stderr:', result.stderr);
    process.exit(result.status || 1);
}

let parsed;
try {
    parsed = JSON.parse(result.stdout.trim());
} catch (e) {
    console.error('Failed to parse JSON from binary:', e.message);
    console.error('First 500 chars of stdout:', result.stdout.slice(0, 500));
    process.exit(1);
}

console.log('--- mesh_gen result ---');
console.log('  ok:                    ', parsed.ok);
console.log('  polylines in:          ', parsed.num_polylines);
console.log('  input vertices:        ', parsed.num_input_vertices);
console.log('  unique vertices:       ', parsed.num_vertices);
console.log('  triangles kept:        ', parsed.num_triangles);
console.log('  triangles dropped:     ', parsed.dropped_triangles, '(alpha filter)');
console.log('  alpha used:            ', parsed.alpha_used);
console.log('  median segment length: ', parsed.median_segment_length);
console.log('  elapsed (ms):          ', dt);

// Optional: write a side-car JSON for inspection / browser preview.
if (inputPath) {
    const outPath = inputPath.replace(/\.json$/i, '') + '.mesh.json';
    fs.writeFileSync(outPath, JSON.stringify({
        vertices: parsed.vertices,
        triangles: parsed.triangles,
        meta: {
            num_polylines: parsed.num_polylines,
            num_vertices: parsed.num_vertices,
            num_triangles: parsed.num_triangles,
            alpha_used: parsed.alpha_used,
        },
    }));
    console.log('Wrote mesh to:', outPath);
}
