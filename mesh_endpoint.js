// /api/mesh handler — spawns the CDT mesh generator.
//
// POST JSON body: {
//   polylines:  [[[x,y,z], ...], ...],   // open contour lines
//   boundaries: [[[x,y,z], ...], ...],   // closed boundary loops (required)
//   slope?: number,   // max (delta_z / XY_edge) kept (default 5.0; 0 = no filter)
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
        const holes      = body.holes      || [];
        const breaklines = body.breaklines || [];
        const scatter    = body.scatter    || [];
        const action     = typeof body.action === 'string' ? body.action : 'mesh';
        const clip_plane = Array.isArray(body.clip_plane) && body.clip_plane.length === 4
                           ? body.clip_plane.map(Number) : null;
        const slice_axis = Array.isArray(body.slice_axis) && body.slice_axis.length === 3
                           ? body.slice_axis.map(Number) : null;
        const slice_step = typeof body.slice_step === 'number' && body.slice_step > 0
                           ? body.slice_step : null;
        if (!Array.isArray(boundaries) || boundaries.length === 0) {
            // clip_mesh / split_mesh don't use boundaries — they supply raw geometry.
            if (action !== 'clip_mesh' && action !== 'split_mesh') {
                res.status(400).json({ ok: false, error: 'Request body must include non-empty "boundaries" array (closed loops).' });
                return;
            }
        }

        // Build the stdin text payload.
        // clip_mesh / split_mesh supply raw geometry instead of CDT polylines.
        if (action === 'clip_mesh') {
            const rawVerts = body.vertices  || [];
            const rawTris  = body.triangles || [];
            if (rawVerts.length === 0 || rawTris.length === 0) {
                res.status(400).json({ ok: false, error: `${action} requires non-empty "vertices" and "triangles" arrays.` });
                return;
            }
            if (!clip_plane) {
                res.status(400).json({ ok: false, error: `${action} requires a "clip_plane" [a,b,c,d].` });
                return;
            }
            const [a, b, c, d] = clip_plane;
            if (![a, b, c, d].every(Number.isFinite)) {
                res.status(400).json({ ok: false, error: 'Non-finite value in clip_plane.' });
                return;
            }
            const rawLines = [`NUMVERTS ${rawVerts.length}`];
            for (const v of rawVerts) {
                const x = Number(v[0]), y = Number(v[1]), z = Number(v[2] ?? 0);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                    res.status(400).json({ ok: false, error: 'Non-finite vertex in vertices.' });
                    return;
                }
                rawLines.push(`${x} ${y} ${z}`);
            }
            rawLines.push(`NUMTRIS ${rawTris.length}`);
            for (const t of rawTris) rawLines.push(`${t[0]} ${t[1]} ${t[2]}`);
            rawLines.push(`CLIPPLANE ${a} ${b} ${c} ${d}`);
            const t0 = Date.now();
            const rawArgs = [`--mode=${action}`];
            const child = spawn(exe, rawArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
            let stdout = '', stderr = '';
            child.stdout.on('data', d => { stdout += d.toString('utf8'); });
            child.stderr.on('data', d => { stderr += d.toString('utf8'); });
            child.on('error', err => res.status(500).json({ ok: false, error: 'Failed to spawn mesh_gen: ' + err.message }));
            child.on('close', code => {
                const elapsed_ms = Date.now() - t0;
                if (stderr) console.warn('[mesh_gen stderr]', stderr);
                if (code !== 0) { res.status(500).json({ ok: false, error: `mesh_gen exited ${code}`, stderr: stderr.slice(0,2000), elapsed_ms }); return; }
                try {
                    const parsed = JSON.parse(stdout.trim());
                    parsed.elapsed_ms = elapsed_ms;
                    res.json(parsed);
                } catch (e) {
                    res.status(500).json({ ok: false, error: 'mesh_gen output was not valid JSON: ' + e.message, stdout_head: stdout.slice(0,500) });
                }
            });
            child.stdin.write(rawLines.join('\n') + '\n');
            child.stdin.end();
            return; // handled — skip CDT pipeline below
        }

        // Build the stdin text payload.
        const lines = [];
        lines.push(`POLYLINES ${polylines.length}`);
        lines.push(`BOUNDARIES ${boundaries.length}`);
        lines.push(`HOLES ${holes.length}`);
        lines.push(`BREAKLINES ${breaklines.length}`);
        lines.push(`SCATTER ${scatter.length}`);
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
        for (const poly of holes) {
            if (!writePoly('HOLE', poly)) {
                res.status(400).json({ ok: false, error: 'Non-finite vertex in holes.' });
                return;
            }
        }
        for (const poly of breaklines) {
            if (!writePoly('BRLINE', poly)) {
                res.status(400).json({ ok: false, error: 'Non-finite vertex in breaklines.' });
                return;
            }
        }
        for (const pt of scatter) {
            const x = Number(pt[0]), y = Number(pt[1]), z = Number(pt[2] ?? 0);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                res.status(400).json({ ok: false, error: 'Non-finite vertex in scatter.' });
                return;
            }
            lines.push(`PT ${x} ${y} ${z}`);
            ++totalVerts;
        }
        if (typeof body.slope === 'number' && body.slope >= 0) {
            lines.push(`SLOPE ${body.slope}`);
        }
        if ((action === 'clip' || action === 'split') && clip_plane) {
            const [a, b, c, d] = clip_plane;
            if (![a, b, c, d].every(Number.isFinite)) {
                res.status(400).json({ ok: false, error: 'Non-finite value in clip_plane.' });
                return;
            }
            lines.push(`CLIPPLANE ${a} ${b} ${c} ${d}`);
        }
        if (action === 'slice') {
            if (!slice_axis || !slice_step) {
                res.status(400).json({ ok: false, error: 'slice requires slice_axis [nx,ny,nz] and slice_step > 0.' });
                return;
            }
            const [nx, ny, nz] = slice_axis;
            if (![nx, ny, nz].every(Number.isFinite)) {
                res.status(400).json({ ok: false, error: 'Non-finite value in slice_axis.' });
                return;
            }
            lines.push(`SLICEAXIS ${nx} ${ny} ${nz}`);
            lines.push(`SLICESTEP ${slice_step}`);
        }
        const stdinPayload = lines.join('\n') + '\n';

        const t0 = Date.now();
        const args = ['clip_mesh', 'clip', 'split', 'slice'].includes(action)
                     ? [`--mode=${action}`] : [];
        const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d.toString('utf8'); });
        child.stderr.on('data', d => { stderr += d.toString('utf8'); });
        child.on('error', err => {
            res.status(500).json({ ok: false, error: 'Failed to spawn mesh_gen: ' + err.message });
        });
        child.on('close', code => {
            const elapsed_ms = Date.now() - t0;
            if (stderr) console.warn('[mesh_gen stderr]', stderr);
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
