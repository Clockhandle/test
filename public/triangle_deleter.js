import * as THREE from 'three';

/**
 * Click-to-delete-triangle tool.
 *
 * When active, OrbitControls and other tools should be off (we toggle
 * controls.enabled here). Each left click raycasts against meshGroup; if it
 * hits an indexed BufferGeometry, we remove the three indices belonging to
 * the picked face and rebuild the index buffer. Holding Shift adds a brief
 * highlight tint instead of deleting (preview).
 */

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let active = false;

export function setupTriangleDeleter(scene, camera, controls, meshGroup) {
  const btn = document.getElementById('delete-tri-btn');
  if (!btn) return;

  const setLabel = () => {
    btn.innerText = active ? 'Delete Triangles (On)' : 'Delete Triangles (Off)';
    btn.style.background = active ? '#a51d2c' : '#dc3545';
  };

  btn.addEventListener('click', () => {
    active = !active;
    if (active) controls.enabled = false;
    else controls.enabled = true;
    setLabel();
  });

  // Use 'click' so we don't fight with OrbitControls drags when the tool is off.
  window.addEventListener('pointerdown', (event) => {
    if (!active) return;
    if (event.button !== 0) return; // left button only
    if (event.target.tagName === 'BUTTON' || event.target.tagName === 'INPUT' || event.target.tagName === 'LABEL') return;

    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(meshGroup, true);
    if (hits.length === 0) return;

    // Pick the closest hit that is an indexed Mesh (skip Lines, LineSegments).
    const hit = hits.find(h => h.object && h.object.isMesh && h.object.geometry && h.object.geometry.index);
    if (!hit) return;

    deleteFace(hit.object, hit.faceIndex);
  });
}

function deleteFace(mesh, faceIndex) {
  if (faceIndex == null) return;
  const geom = mesh.geometry;
  const index = geom.index;
  if (!index) return;

  const arr = index.array;
  const start = faceIndex * 3;
  if (start + 2 >= arr.length) return;

  // Build a new index buffer without the 3 entries.
  const Ctor = arr.constructor; // preserve Uint16Array vs Uint32Array
  const next = new Ctor(arr.length - 3);
  next.set(arr.subarray(0, start), 0);
  next.set(arr.subarray(start + 3), start);

  geom.setIndex(new THREE.BufferAttribute(next, 1));
  geom.index.needsUpdate = true;
  // Recompute normals/bounds so lighting/raycasting stay correct.
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
}

