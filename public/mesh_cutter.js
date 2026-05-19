import * as THREE from 'three';

// ─── State ───────────────────────────────────────────────────────────────────

let _scene, _camera, _controls, _meshGroup, _canvas;

// 'idle' | 'selecting' | 'confirming' | 'clipping'
let _mode = 'idle';

// Screen-space start/end points (pixels)
let _p1 = null, _p2 = null;

// Three.js objects for previews (added to scene, removed on cancel/confirm)
let _linePreview = null;   // screen-space line drawn as a 3D world-space ray plane edge
let _planePreview = null;  // semi-transparent cutting plane mesh
let _cutGroup = null;      // group holding the clipped result meshes

// Overlay canvas for drawing the 2D cut line
let _overlay = null;

// Current computed plane
let _plane = null;  // { a, b, c, d }

// Counter for assigning unique solidIndex values to cut halves (avoids
// colliding with original solid indices 0, 1, 2 … set by via_solid.js)
let _nextSolidIndex = 1000;

// Meshes hidden by the last cut (restored when Restore Cut is pressed)
let _hiddenMeshes = [];

// ─── Public API ──────────────────────────────────────────────────────────────

export function setupMeshCutter(scene, camera, controls, meshGroup, canvas) {
    _scene     = scene;
    _camera    = camera;
    _controls  = controls;
    _meshGroup = meshGroup;
    _canvas    = canvas;

    _buildOverlay();
    _buildCutUI();
}

// ─── Drag-to-move ─────────────────────────────────────────────────────────────
// Click and hold any CGAL / solid mesh to translate all solid groups together.
// Works in idle mode only (disabled while cut mode is active).

export function setupDragToMove(scene, camera, controls, meshGroup, canvas) {
    const raycaster     = new THREE.Raycaster();
    const mouse         = new THREE.Vector2();
    const dragPlane     = new THREE.Plane();
    const planeHit      = new THREE.Vector3();
    const prevHit       = new THREE.Vector3();

    let dragging = false;
    let dragTargets = [];  // individual meshes that belong to the clicked solid

    // ── Helpers ───────────────────────────────────────────────────────────────

    function solidMeshes() {
        const out = [];
        ['CGAL_Meshes', 'Via_Solid', 'Clipped_Solid'].forEach(name => {
            const g = meshGroup.getObjectByName(name);
            if (g) g.traverse(o => { if (o instanceof THREE.Mesh) out.push(o); });
        });
        return out;
    }

    function ndcFromEvent(e) {
        mouse.set(
            (e.clientX / window.innerWidth)  *  2 - 1,
            (e.clientY / window.innerHeight) * -2 + 1
        );
    }

    // ── Mouse down — start drag if we hit a solid mesh ────────────────────────
    canvas.addEventListener('mousedown', e => {
        if (e.button !== 0 || _mode !== 'idle') return;

        ndcFromEvent(e);
        raycaster.setFromCamera(mouse, camera);

        const meshes = solidMeshes();
        if (meshes.length === 0) return;

        const hits = raycaster.intersectObjects(meshes, false);
        if (hits.length === 0) return;

        // Drag plane: faces the camera, passes through the hit point.
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        dragPlane.setFromNormalAndCoplanarPoint(camDir, hits[0].point);
        raycaster.ray.intersectPlane(dragPlane, prevHit);

        // Find all meshes that belong to the same solid as the hit mesh.
        const hitMesh  = hits[0].object;
        const solidIdx = hitMesh.userData.solidIndex;

        dragTargets = [];
        if (solidIdx !== undefined) {
            meshGroup.traverse(o => {
                if (o instanceof THREE.Mesh && o.userData.solidIndex === solidIdx) dragTargets.push(o);
            });
        } else {
            // Via_Solid not built yet — drag just the clicked mesh.
            dragTargets = [hitMesh];
        }
        if (dragTargets.length === 0) return;

        dragging = true;
        controls.enabled = false;
        canvas.style.cursor = 'grabbing';
    });

    // ── Mouse move — translate groups ─────────────────────────────────────────
    window.addEventListener('mousemove', e => {
        if (!dragging) return;
        ndcFromEvent(e);
        raycaster.setFromCamera(mouse, camera);
        if (!raycaster.ray.intersectPlane(dragPlane, planeHit)) return;

        const delta = planeHit.clone().sub(prevHit);
        dragTargets.forEach(m => m.position.add(delta));
        prevHit.copy(planeHit);
    });

    // ── Mouse up — end drag ───────────────────────────────────────────────────
    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        controls.enabled = true;
        canvas.style.cursor = '';
        dragTargets = [];
    });

    // ── Cursor hint on hover ──────────────────────────────────────────────────
    canvas.addEventListener('mousemove', e => {
        if (dragging || _mode !== 'idle') return;
        ndcFromEvent(e);
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObjects(solidMeshes(), false);
        canvas.style.cursor = hits.length > 0 ? 'grab' : '';
    });
}

export function enterCutMode() {
    if (_mode !== 'idle') return;
    _mode = 'selecting';

    _controls.enabled = false;
    _canvas.style.cursor = 'crosshair';

    _overlay.style.display = 'block';
    _overlay.style.pointerEvents = 'auto';  // must receive mouse events in cut mode
    _overlay.width  = window.innerWidth;
    _overlay.height = window.innerHeight;

    document.getElementById('cut-instructions').style.display = 'block';
    document.getElementById('cut-confirm-bar').style.display  = 'none';

    _overlay.addEventListener('mousedown', _onMouseDown);
    _overlay.addEventListener('mousemove', _onMouseMove);
    _overlay.addEventListener('mouseup',   _onMouseUp);
    window.addEventListener('keydown', _onKeyDown);
}

// ─── Overlay canvas ──────────────────────────────────────────────────────────

function _buildOverlay() {
    _overlay = document.createElement('canvas');
    _overlay.id = 'cut-overlay';
    Object.assign(_overlay.style, {
        position: 'fixed', top: '0', left: '0',
        width: '100%', height: '100%',
        pointerEvents: 'none',
        display: 'none',
        zIndex: '100',
    });
    document.body.appendChild(_overlay);
}

// ─── Cut UI (instructions + confirm/cancel bar) ──────────────────────────────

function _buildCutUI() {
    // Floating instruction label
    const instr = document.createElement('div');
    instr.id = 'cut-instructions';
    Object.assign(instr.style, {
        position: 'fixed', top: '60px', left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,0.75)', color: '#fff',
        padding: '8px 16px', borderRadius: '6px',
        fontSize: '13px', pointerEvents: 'none',
        display: 'none', zIndex: '200',
    });
    instr.textContent = 'Click and drag to draw the cut line';
    document.body.appendChild(instr);

    // Confirm / Cancel bar
    const bar = document.createElement('div');
    bar.id = 'cut-confirm-bar';
    Object.assign(bar.style, {
        position: 'fixed', top: '60px', left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,0.8)', color: '#fff',
        padding: '8px 14px', borderRadius: '6px',
        fontSize: '13px', display: 'none', zIndex: '200',
        gap: '10px', alignItems: 'center',
    });
    // display starts as none; shown via style.display='flex' in _onMouseUp
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'Apply Cut';
    Object.assign(confirmBtn.style, { background: '#28a745', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: '4px', cursor: 'pointer', marginRight: '8px' });
    confirmBtn.addEventListener('click', _applyClip);

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    Object.assign(cancelBtn.style, { background: '#555', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: '4px', cursor: 'pointer' });
    cancelBtn.addEventListener('click', _cancelCutMode);

    bar.appendChild(confirmBtn);
    bar.appendChild(cancelBtn);
    document.body.appendChild(bar);
}

// ─── Mouse handlers ───────────────────────────────────────────────────────────

function _onMouseDown(e) {
    if (_mode !== 'selecting') return;
    _p1 = { x: e.clientX, y: e.clientY };
    _p2 = null;
    _removePlanePreview();
}

function _onMouseMove(e) {
    if (_mode !== 'selecting' || !_p1) return;
    _p2 = { x: e.clientX, y: e.clientY };
    _drawOverlayLine();
}

function _onMouseUp(e) {
    if (_mode !== 'selecting' || !_p1) return;
    _p2 = { x: e.clientX, y: e.clientY };

    if (Math.hypot(_p2.x - _p1.x, _p2.y - _p1.y) < 10) {
        // Too short — ignore
        _clearOverlay();
        _p1 = null;
        return;
    }

    _drawOverlayLine();
    _plane = _computePlane(_p1, _p2);
    _showPlanePreview(_plane);

    _mode = 'confirming';
    document.getElementById('cut-instructions').style.display = 'none';
    const bar = document.getElementById('cut-confirm-bar');
    bar.style.display = 'flex';
}

function _onKeyDown(e) {
    if (e.key === 'Escape') _cancelCutMode();
}

// ─── 2D overlay drawing ───────────────────────────────────────────────────────

function _drawOverlayLine() {
    if (!_p1 || !_p2) return;
    const ctx = _overlay.getContext('2d');
    ctx.clearRect(0, 0, _overlay.width, _overlay.height);
    ctx.strokeStyle = '#00ffff';
    ctx.lineWidth   = 2;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.moveTo(_p1.x, _p1.y);
    ctx.lineTo(_p2.x, _p2.y);
    ctx.stroke();

    // Draw endpoint dots
    ctx.fillStyle = '#00ffff';
    ctx.setLineDash([]);
    [_p1, _p2].forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
    });
}

function _clearOverlay() {
    const ctx = _overlay.getContext('2d');
    ctx.clearRect(0, 0, _overlay.width, _overlay.height);
}

// ─── Plane computation ────────────────────────────────────────────────────────

/**
 * Given two screen-space points, compute a world-space cutting plane.
 *
 * The plane:
 *   - Contains the 3D line defined by the screen segment (extruded through depth)
 *   - Is perpendicular to the screen (extends along the camera's view direction)
 *
 * Normal = normalize( worldLineDir × cameraForward )
 * Passes through the bounding-box centre of all visible CGAL meshes.
 *
 * Convention: keep side where a·x + b·y + c·z + d >= 0
 * (i.e. the side the camera is on, so you always see the front face of the cut)
 */
function _computePlane(p1px, p2px) {
    const W = window.innerWidth, H = window.innerHeight;

    // NDC of the two screen points (z=-1 = near plane)
    const toNDC = px => new THREE.Vector3(
        (px.x / W) * 2 - 1,
        -(px.y / H) * 2 + 1,
        -1
    );

    const ndc1 = toNDC(p1px);
    const ndc2 = toNDC(p2px);

    // Unproject to world space (near plane)
    const w1 = ndc1.clone().unproject(_camera);
    const w2 = ndc2.clone().unproject(_camera);

    // Direction of the drawn line in world space
    const lineDir = new THREE.Vector3().subVectors(w2, w1).normalize();

    // Camera forward direction
    const camFwd = new THREE.Vector3();
    _camera.getWorldDirection(camFwd);

    // Plane normal: perpendicular to both the line and the viewing direction
    const normal = new THREE.Vector3().crossVectors(lineDir, camFwd).normalize();

    // Anchor: bounding-box centre of all clippable meshes
    const anchor = _getSceneCenter();

    // d = −(normal · anchor)  →  keep side where normal·p + d >= 0
    // We want to keep the side the camera is on.
    let d = -normal.dot(anchor);

    // Ensure the camera is on the positive side; if not, flip the normal.
    const camPos = _camera.position.clone();
    if (normal.dot(camPos) + d < 0) {
        normal.negate();
        d = -normal.dot(anchor);
    }

    return { a: normal.x, b: normal.y, c: normal.z, d };
}

function _getSceneCenter() {
    const box = new THREE.Box3();
    _meshGroup.traverse(obj => {
        if (obj instanceof THREE.Mesh) box.expandByObject(obj);
    });
    if (box.isEmpty()) return new THREE.Vector3();
    return box.getCenter(new THREE.Vector3());
}

// ─── Plane preview mesh ───────────────────────────────────────────────────────

function _showPlanePreview(plane) {
    _removePlanePreview();

    const normal = new THREE.Vector3(plane.a, plane.b, plane.c).normalize();
    const anchor = _getSceneCenter();

    // Size the preview quad to cover the scene's bounding box diagonal
    const box = new THREE.Box3();
    _meshGroup.traverse(obj => { if (obj instanceof THREE.Mesh) box.expandByObject(obj); });
    const size = box.isEmpty() ? 500 : box.getSize(new THREE.Vector3()).length() * 1.2;

    const geom = new THREE.PlaneGeometry(size, size);
    const mat  = new THREE.MeshBasicMaterial({
        color: 0x00ffff, opacity: 0.18, transparent: true,
        side: THREE.DoubleSide, depthWrite: false,
    });
    _planePreview = new THREE.Mesh(geom, mat);

    // Orient: PlaneGeometry lies in XY (normal = +Z); rotate to match cutting normal.
    _planePreview.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    _planePreview.position.copy(anchor);
    _planePreview.renderOrder = 999;

    _scene.add(_planePreview);
}

function _removePlanePreview() {
    if (_planePreview) {
        _planePreview.geometry.dispose();
        _planePreview.material.dispose();
        _scene.remove(_planePreview);
        _planePreview = null;
    }
}

// ─── Apply clip ───────────────────────────────────────────────────────────────

async function _applyClip() {
    if (_mode !== 'confirming' || !_plane) return;
    _mode = 'clipping';

    document.getElementById('cut-confirm-bar').style.display = 'none';
    document.getElementById('cut-instructions').style.display = 'block';
    document.getElementById('cut-instructions').textContent = 'Clipping…';

    try {
        // 1. Group all solid meshes by solidIndex.
        const solidMap = new Map();  // solidIndex -> [{mesh, vertices, triangles}]
        _meshGroup.traverse(obj => {
            if (!(obj instanceof THREE.Mesh)) return;
            const ft     = obj.userData.featureType;
            const isWall = obj.name && obj.name.startsWith('Via_SideWall_');
            if (!ft && !isWall) return;
            const solidIdx = obj.userData.solidIndex;
            if (solidIdx === undefined) return;
            const raw = _getRawData(obj);
            if (!raw) return;
            if (!solidMap.has(solidIdx)) solidMap.set(solidIdx, []);
            solidMap.get(solidIdx).push({ mesh: obj, ...raw });
        });

        if (solidMap.size === 0) {
            alert('No clippable solids found. Build Via Solid first.');
            _cancelCutMode();
            return;
        }

        // 2. Find target solid: raycast from the cut-line midpoint (primary);
        //    fall back to bounding-box test if the ray misses all meshes.
        let targetSolidIdx = null;
        {
            const midPx = { x: (_p1.x + _p2.x) * 0.5, y: (_p1.y + _p2.y) * 0.5 };
            const ndcMid = new THREE.Vector2(
                (midPx.x / window.innerWidth)  *  2 - 1,
                -(midPx.y / window.innerHeight) * 2 + 1
            );

            // Build a flat list of {mesh, solidIdx} for raycasting.
            const allParts = [];
            for (const [solidIdx, parts] of solidMap)
                parts.forEach(p => allParts.push({ mesh: p.mesh, solidIdx }));

            const rc = new THREE.Raycaster();
            rc.setFromCamera(ndcMid, _camera);
            const hits = rc.intersectObjects(allParts.map(c => c.mesh), false);
            if (hits.length > 0) {
                const found = allParts.find(c => c.mesh === hits[0].object);
                if (found) targetSolidIdx = found.solidIdx;
            }

            // Fallback: bounding-box intersection.
            if (targetSolidIdx === null) {
                for (const [solidIdx, parts] of solidMap) {
                    const box = new THREE.Box3();
                    parts.forEach(p => box.expandByObject(p.mesh));
                    if (_planeCutsBBox(_plane, box)) { targetSolidIdx = solidIdx; break; }
                }
            }
        }

        if (targetSolidIdx === null) {
            alert('The cut line does not pass through any solid. Try repositioning the cut line.');
            _cancelCutMode();
            return;
        }

        const targets      = solidMap.get(targetSolidIdx);
        const flippedPlane = { a: -_plane.a, b: -_plane.b, c: -_plane.c, d: -_plane.d };

        // 3. Clip each mesh of the target solid both ways simultaneously.
        const [posResults, negResults] = await Promise.all([
            Promise.all(targets.map(t => _clipMesh(t.vertices, t.triangles, _plane))),
            Promise.all(targets.map(t => _clipMesh(t.vertices, t.triangles, flippedPlane))),
        ]);

        const failedPos = posResults.findIndex(r => !r.ok);
        const failedNeg = negResults.findIndex(r => !r.ok);
        if (failedPos !== -1) { alert(`Clip (+) failed: ${posResults[failedPos].error}`); _cancelCutMode(); return; }
        if (failedNeg !== -1) { alert(`Clip (−) failed: ${negResults[failedNeg].error}`); _cancelCutMode(); return; }

        // 4. Assign fresh solidIndex values to each half so they drag independently.
        const posIdx = _nextSolidIndex++;
        const negIdx = _nextSolidIndex++;

        // 5. Build cut group with both halves inside _meshGroup (inherits survey offset).
        _removeCutGroup();
        _cutGroup = new THREE.Group();
        _cutGroup.name = 'Clipped_Solid';

        _buildHalf(targets, posResults, posIdx, _cutGroup,  0.12);  // slightly lighter tint
        _buildHalf(targets, negResults, negIdx, _cutGroup, -0.12);  // slightly darker tint

        // 6. Hide only the original solid's meshes; all other solids stay visible.
        _hiddenMeshes = targets.map(t => t.mesh);
        _hiddenMeshes.forEach(m => { m.visible = false; });

        _meshGroup.add(_cutGroup);
        _ensureRestoreButton();

    } catch (err) {
        alert('Clip request failed: ' + err.message);
    }

    _exitCutMode();
}

async function _clipMesh(vertices, triangles, plane) {
    const resp = await fetch('/api/clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vertices, triangles, plane }),
    });
    return resp.json();
}

// ─── Cancel / exit ────────────────────────────────────────────────────────────

function _cancelCutMode() {
    _removePlanePreview();
    _exitCutMode();
}

function _exitCutMode() {
    _mode = 'idle';
    _p1 = _p2 = _plane = null;

    _clearOverlay();
    _overlay.style.display = 'none';
    _overlay.style.pointerEvents = 'none';
    _overlay.removeEventListener('mousedown', _onMouseDown);
    _overlay.removeEventListener('mousemove', _onMouseMove);
    _overlay.removeEventListener('mouseup',   _onMouseUp);
    window.removeEventListener('keydown', _onKeyDown);

    _controls.enabled = true;
    _canvas.style.cursor = '';

    document.getElementById('cut-instructions').style.display = 'none';
    document.getElementById('cut-confirm-bar').style.display  = 'none';
    document.getElementById('cut-instructions').textContent   = 'Click and drag to draw the cut line';
}

// ─── Restore button ───────────────────────────────────────────────────────────

function _ensureRestoreButton() {
    if (document.getElementById('cut-restore-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'cut-restore-btn';
    btn.textContent = 'Restore Cut';
    Object.assign(btn.style, {
        marginLeft: '10px', background: '#e67e22', color: '#fff',
        border: 'none', padding: '5px 10px', borderRadius: '4px', cursor: 'pointer',
    });
    btn.addEventListener('click', () => {
        _removeCutGroup();  // also restores _hiddenMeshes
    });

    // Insert next to the cut button
    const cutBtn = document.getElementById('cut-btn');
    if (cutBtn) cutBtn.after(btn);
    else document.querySelector('.ui-overlay').appendChild(btn);
}

function _removeCutGroup() {
    if (!_cutGroup) return;
    _cutGroup.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
    });
    _meshGroup.remove(_cutGroup);
    _cutGroup = null;

    // Restore only the meshes that were hidden by the last cut.
    _hiddenMeshes.forEach(m => { m.visible = true; });
    _hiddenMeshes = [];

    const restoreBtn = document.getElementById('cut-restore-btn');
    if (restoreBtn) restoreBtn.remove();
}

function _setOriginalVisibility(visible) {
    ['CGAL_Meshes', 'Via_Solid'].forEach(name => {
        const g = _meshGroup.getObjectByName(name);
        if (g) g.visible = visible;
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract raw vertex/triangle arrays from a mesh, preferring userData.rawVertices
 * (set by cgal_mesher.js) and falling back to reading the BufferGeometry directly.
 */
function _getRawData(mesh) {
    if (mesh.userData.rawVertices && mesh.userData.rawTriangles) {
        return {
            vertices:  mesh.userData.rawVertices,
            triangles: mesh.userData.rawTriangles,
        };
    }
    // Read from geometry
    const pos = mesh.geometry.attributes.position;
    const idx = mesh.geometry.index;
    if (!pos) return null;

    const vertices = [];
    for (let i = 0; i < pos.count; i++)
        vertices.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);

    const triangles = [];
    if (idx) {
        for (let i = 0; i < idx.count; i += 3)
            triangles.push([idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)]);
    } else {
        for (let i = 0; i < pos.count; i += 3)
            triangles.push([i, i + 1, i + 2]);
    }
    return { vertices, triangles };
}

// ─── Cut helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if the plane {a,b,c,d} (ax+by+cz+d>=0 convention) crosses the
 * given world-space Box3 (i.e. the box has corners on both sides of the plane).
 */
function _planeCutsBBox(plane, box) {
    if (box.isEmpty()) return false;
    const { a, b, c, d } = plane;
    let hasPos = false, hasNeg = false;
    const xs = [box.min.x, box.max.x];
    const ys = [box.min.y, box.max.y];
    const zs = [box.min.z, box.max.z];
    for (const x of xs) for (const y of ys) for (const z of zs) {
        if (a*x + b*y + c*z + d >= 0) hasPos = true;
        else hasNeg = true;
    }
    return hasPos && hasNeg;
}

/**
 * Build clipped meshes for one half and append them to parentGroup.
 * Each resulting mesh gets mesh.userData.solidIndex = solidIdx so it is
 * draggable independently of the other half.
 */
function _buildHalf(targets, results, solidIdx, parentGroup, brightnessOffset = 0) {
    results.forEach((result, i) => {
        if (!result.vertices || result.vertices.length === 0 || result.triangles.length === 0) return;
        const original = targets[i].mesh;
        const geom = _buildGeometry(result.vertices, result.triangles);
        const mat  = original.material.clone();
        if (brightnessOffset !== 0) mat.color.offsetHSL(0, 0, brightnessOffset);
        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = original.name + '_half' + solidIdx;
        mesh.userData.featureType = original.userData.featureType;
        mesh.userData.solidIndex  = solidIdx;
        parentGroup.add(mesh);

        const wire = new THREE.LineSegments(
            new THREE.WireframeGeometry(geom),
            new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.15, transparent: true })
        );
        mesh.add(wire);
    });
}

function _buildGeometry(vertices, triangles) {
    const positions = new Float32Array(vertices.length * 3);
    vertices.forEach(([x, y, z], i) => {
        positions[i * 3]     = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
    });

    const indices = new Uint32Array(triangles.length * 3);
    triangles.forEach(([a, b, c], i) => {
        indices[i * 3]     = a;
        indices[i * 3 + 1] = b;
        indices[i * 3 + 2] = c;
    });

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.computeVertexNormals();
    return geom;
}
