// /api/mesh handler — spawns the compiled CGAL mesh generator.
//
// POST JSON body: {
//   polylines:  [[[x,y,z], ...], ...],   // open contour lines
//   boundaries: [[[x,y,z], ...], ...],   // closed boundary loops (required)
//   alpha?:            number,
//   slope?:            number,
//   bridge_step?:      number,
//   bridge_neighbors?: number,
// }
// Response: JSON emitted verbatim by cpp/build/Release/mesh_gen.exe
//
// The C++ binary expects a simple whitespace-separated text stream on stdin
// (see cpp/mesh_gen.cpp header comment for the grammar). We translate the
// JSON request to that stream here so the browser stays in pure JSON land.

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

function locateBinary(rootDir) {
    const candidates = [
        path.join(rootDir, 'cpp', 'build', 'Release', 'mesh_gen.exe'),
        path.join(rootDir, 'cpp', 'build', 'Debug', 'mesh_gen.exe'),
        path.join(rootDir, 'cpp', 'build', 'mesh_gen.exe'),
        path.join(rootDir, 'cpp', 'build', 'mesh_gen'),
    ];
    return candidates.find(p => fs.existsSync(p));
}

export function createMeshHandler(rootDir) {
    return async function meshHandler(req, res) {
        const exe = locateBinary(rootDir);
        if (!exe) {
            res.status(500).json({
                ok: false,
                error: 'mesh_gen binary not found. Build it with: cmake --build cpp/build --config Release',
            });
            return;
        }

        const body = req.body || {};
        const polylines  = body.polylines  || [];
        const boundaries = body.boundaries || [];
        if (!Array.isArray(boundaries) || boundaries.length === 0) {
            res.status(400).json({ ok: false, error: 'Request body must include non-empty "boundaries" array (closed loops).' });
            return;
        }

        // Build the stdin text payload.
        const lines = [];
        lines.push(`POLYLINES ${polylines.length}`);
        lines.push(`BOUNDARIES ${boundaries.length}`);
        let totalVerts = 0;

        const writePoly = (token, poly) => {
            if (!Array.isArray(poly) || poly.length === 0) return true;
            lines.push(`${token} ${poly.length}`);
            for (const v of poly) {
                const x = Number(v[0]), y = Number(v[1]), z = Number(v[2] ?? 0);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
                lines.push(`${x} ${y} ${z}`);
                ++totalVerts;
            }
            return true;
        };

        for (const poly of polylines) {
            if (!writePoly('POLY', poly)) {
                res.status(400).json({ ok: false, error: 'Non-finite vertex in polylines.' });
                return;
            }
        }
        for (const poly of boundaries) {
            if (!writePoly('BPOLY', poly)) {
                res.status(400).json({ ok: false, error: 'Non-finite vertex in boundaries.' });
                return;
            }
        }
        if (typeof body.alpha === 'number' && body.alpha > 0) {
            lines.push(`ALPHA ${body.alpha}`);
        }
        if (typeof body.slope === 'number' && body.slope > 0) {
            lines.push(`SLOPE ${body.slope}`);
        }
        if (typeof body.bridge_step === 'number' && body.bridge_step > 0) {
            lines.push(`BRIDGE_STEP ${body.bridge_step}`);
        }
        if (typeof body.bridge_neighbors === 'number' && body.bridge_neighbors >= 0) {
            lines.push(`BRIDGE_NEIGHBORS ${Math.floor(body.bridge_neighbors)}`);
        }
        const stdinPayload = lines.join('\n') + '\n';

        const t0 = Date.now();
        const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d.toString('utf8'); });
        child.stderr.on('data', d => { stderr += d.toString('utf8'); });
        child.on('error', err => {
            res.status(500).json({ ok: false, error: 'Failed to spawn mesh_gen: ' + err.message });
        });
        child.on('close', code => {
            const elapsed_ms = Date.now() - t0;
            if (code !== 0) {
                res.status(500).json({
                    ok: false,
                    error: `mesh_gen exited with code ${code}`,
                    stderr: stderr.slice(0, 2000),
                    elapsed_ms,
                });
                return;
            }
            try {
                const parsed = JSON.parse(stdout.trim());
                parsed.elapsed_ms = elapsed_ms;
                parsed.input_polylines = polylines.length;
                parsed.input_vertices = totalVerts;
                res.json(parsed);
            } catch (e) {
                res.status(500).json({
                    ok: false,
                    error: 'mesh_gen output was not valid JSON: ' + e.message,
                    stdout_head: stdout.slice(0, 500),
                    stderr: stderr.slice(0, 500),
                });
            }
        });

        child.stdin.write(stdinPayload);
        child.stdin.end();
    };
}
