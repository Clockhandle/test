// Spawns the compiled CGAL test binary and parses its JSON stdout.
// Run AFTER building:
//   cmake -S cpp -B cpp/build -DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake
//   cmake --build cpp/build --config Release
//   node test_cgal.cjs

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const candidates = [
    path.join(__dirname, 'cpp', 'build', 'Release', 'cgal_test.exe'),
    path.join(__dirname, 'cpp', 'build', 'Debug', 'cgal_test.exe'),
    path.join(__dirname, 'cpp', 'build', 'cgal_test.exe'),
    path.join(__dirname, 'cpp', 'build', 'cgal_test'),
];

const exe = candidates.find(p => fs.existsSync(p));
if (!exe) {
    console.error('cgal_test binary not found. Looked in:');
    candidates.forEach(c => console.error('  ' + c));
    console.error('\nBuild it first with:');
    console.error('  cmake -S cpp -B cpp/build -DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake');
    console.error('  cmake --build cpp/build --config Release');
    process.exit(1);
}

console.log('Running:', exe);
const result = spawnSync(exe, [], { encoding: 'utf8' });

if (result.error) {
    console.error('Failed to spawn:', result.error);
    process.exit(1);
}
if (result.status !== 0) {
    console.error('Exit code:', result.status);
    console.error('stderr:', result.stderr);
    process.exit(result.status || 1);
}

const raw = result.stdout.trim();
console.log('Raw stdout:\n' + raw + '\n');

let parsed;
try {
    parsed = JSON.parse(raw);
} catch (e) {
    console.error('Failed to parse JSON from binary:', e.message);
    process.exit(1);
}

console.log('Parsed result:');
console.log('  ok:             ', parsed.ok);
console.log('  cgal:           ', parsed.cgal);
console.log('  input points:   ', parsed.num_input_points);
console.log('  vertices:       ', parsed.num_vertices);
console.log('  triangles:      ', parsed.num_triangles);
console.log('  first triangle: ', parsed.triangles && parsed.triangles[0]);

if (parsed.ok && parsed.num_triangles > 0) {
    console.log('\nCGAL link + Node->exe round-trip OK.');
    process.exit(0);
} else {
    console.error('\nUnexpected result.');
    process.exit(2);
}
