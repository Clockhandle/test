import * as THREE from 'three';
import { buildCgalMesh } from './cgal_mesher.js';
import { buildViaSolid } from './via_solid.js';

// ── Clip wall meshes via CGAL raw-mesh mode ─────────────────────────────────
// Finds all Via_SideWall_* meshes, sends each to /api/mesh with action
// 'clip_mesh', and replaces the geometry in-place with the clipped result.
async function clipWallMeshes(clip_plane, meshGroup) {
    const solidGroup = meshGroup.getObjectByName('Via_Solid');
    if (!solidGroup) return;

    const wallMeshes = [];
    solidGroup.traverse(obj => {
        if (obj instanceof THREE.Mesh && obj.name.startsWith('Via_SideWall_'))
            wallMeshes.push(obj);
    });
    if (wallMeshes.length === 0) return;

    for (const wallMesh of wallMeshes) {
        const geom    = wallMesh.geometry;
        const posAttr = geom.attributes.position;

        const vertices = [];
        for (let i = 0; i < posAttr.count; i++)
            vertices.push([posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)]);

        const triangles = [];
        if (geom.index) {
            const idx = geom.index;
            for (let i = 0; i < idx.count; i += 3)
                triangles.push([idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)]);
        } else {
            for (let i = 0; i < posAttr.count; i += 3)
                triangles.push([i, i + 1, i + 2]);
        }

        let data;
        try {
            const resp = await fetch('/api/mesh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'clip_mesh', clip_plane, vertices, triangles }),
            });
            data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || resp.statusText);
        } catch (e) {
            console.error(`[clipWall] ${wallMesh.name} failed:`, e);
            continue;
        }

        const m = (data.meshes || [])[0];
        if (!m || !m.vertices) continue;

        const pos = new Float32Array(m.vertices.length * 3);
        for (let i = 0; i < m.vertices.length; i++) {
            pos[i * 3]     = m.vertices[i][0];
            pos[i * 3 + 1] = m.vertices[i][1];
            pos[i * 3 + 2] = m.vertices[i][2];
        }
        const idxBuf = new Uint32Array(m.triangles.length * 3);
        for (let i = 0; i < m.triangles.length; i++) {
            idxBuf[i * 3]     = m.triangles[i][0];
            idxBuf[i * 3 + 1] = m.triangles[i][1];
            idxBuf[i * 3 + 2] = m.triangles[i][2];
        }
        geom.dispose();
        const newGeom = new THREE.BufferGeometry();
        newGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        newGeom.setIndex(new THREE.BufferAttribute(idxBuf, 1));
        newGeom.computeVertexNormals();
        wallMesh.geometry = newGeom;
        console.log(`[clipWall] ${wallMesh.name}: ${m.num_triangles} tris after clip`);
    }
}

export function setupClipTest(rawDataSegments, renderer, meshGroup) {
    const cutBtn = document.getElementById('cut-mesh-btn');
    if (!cutBtn) return;

    cutBtn.addEventListener('click', async () => {
        if (!rawDataSegments || rawDataSegments.length === 0) {
            alert('Upload a JSON dataset first!');
            return;
        }
        if (!meshGroup) {
            alert('No scene geometry available.');
            return;
        }

        // Cut at world-space X = 0, discard right side (world X > 0).
        //
        // meshGroup.position.x = -centerX (survey origin is shifted to world origin),
        // so world X=0 corresponds to survey X = centerX = -meshGroup.position.x.
        //
        // CGAL plane ax+by+cz+d=0 removes the side where ax+by+cz+d > 0.
        // Plane: x - centerX = 0  →  clip_plane [1, 0, 0, meshGroup.position.x]
        // removes survey x > centerX  ≡  world x > 0.
        const clip_plane = [1, 0, 0, meshGroup.position.x];

        const orig = cutBtn.innerText;
        cutBtn.disabled = true;
        cutBtn.innerText = 'Clipping…';
        try {
            await buildCgalMesh(rawDataSegments, meshGroup, { action: 'clip', clip_plane });
            await clipWallMeshes(clip_plane, meshGroup);
        } finally {
            cutBtn.disabled = false;
            cutBtn.innerText = orig;
        }
    });

    const splitBtn = document.getElementById('split-mesh-btn');
    if (!splitBtn) return;

    splitBtn.addEventListener('click', async () => {
        if (!rawDataSegments || rawDataSegments.length === 0) {
            alert('Upload a JSON dataset first!');
            return;
        }
        if (!meshGroup) {
            alert('No scene geometry available.');
            return;
        }

        // Same plane as Cut Shape: world X=0 → survey X = -meshGroup.position.x.
        // Both halves are returned as separate mesh entries.
        const clip_plane = [1, 0, 0, meshGroup.position.x];

        const orig = splitBtn.innerText;
        splitBtn.disabled = true;
        splitBtn.innerText = 'Splitting…';
        try {
            // 1. Split terrain meshes (Vách + Trụ) into two halves.
            await buildCgalMesh(rawDataSegments, meshGroup, { action: 'split', clip_plane });
            // 2. Re-stitch walls from the freshly split terrain meshes.
            //    buildViaSolid removes the old Via_Solid and rebuilds from whatever
            //    is now in CGAL_Meshes — each half's boundary loop (original outer
            //    edge + new cut edge as one connected loop) gets stitched into a
            //    complete side wall including the cross-section closing face.
            buildViaSolid(meshGroup);
        } finally {
            splitBtn.disabled = false;
            splitBtn.innerText = orig;
        }
    });
}

