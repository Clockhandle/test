// /api/clip handler — spawns mesh_clip.exe to cut a mesh with a half-space.
//
// POST JSON body: {
//   vertices:  [[x,y,z], ...],
//   triangles: [[i0,i1,i2], ...],
//   plane: { a, b, c, d }     // keep side where ax+by+cz+d >= 0
// }
// Response: { ok:true, vertices:[[x,y,z],...], triangles:[[i,j,k],...] }

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

function locateBinary(rootDir) {
    const candidates = [
        path.join(rootDir, 'cpp', 'build', 'Release', 'mesh_clip.exe'),
        path.join(rootDir, 'cpp', 'build', 'Debug',   'mesh_clip.exe'),
        path.join(rootDir, 'cpp', 'build', 'mesh_clip.exe'),
        path.join(rootDir, 'cpp', 'build', 'mesh_clip'),
    ];
    return candidates.find(p => fs.existsSync(p));
}

export function createClipHandler(rootDir) {
    return function clipHandler(req, res) {
        const exe = locateBinary(rootDir);
        if (!exe) {
            res.status(500).json({
                ok: false,
                error: 'mesh_clip binary not found. Build with: cmake --build cpp/build --config Release',
            });
            return;
        }

        const { vertices, triangles, plane } = req.body || {};
        if (!Array.isArray(vertices) || !Array.isArray(triangles) || !plane) {
            res.status(400).json({ ok: false, error: 'Need "vertices", "triangles", and "plane" ({a,b,c,d}).' });
            return;
        }

        const lines = [];
        lines.push(`VERTICES ${vertices.length}`);
        for (const v of vertices) lines.push(`${v[0]} ${v[1]} ${v[2]}`);
        lines.push(`TRIANGLES ${triangles.length}`);
        for (const t of triangles) lines.push(`${t[0]} ${t[1]} ${t[2]}`);
        lines.push(`PLANE ${plane.a} ${plane.b} ${plane.c} ${plane.d}`);
        const stdin = lines.join('\n') + '\n';

        const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdin.write(stdin);
        child.stdin.end();

        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });

        child.on('close', code => {
            if (code !== 0) {
                res.status(500).json({ ok: false, error: stderr || `mesh_clip exited with code ${code}` });
                return;
            }
            try {
                res.json(JSON.parse(stdout));
            } catch {
                res.status(500).json({ ok: false, error: 'Failed to parse mesh_clip output', raw: stdout.slice(0, 200) });
            }
        });
    };
}
