import * as THREE from 'three';
import {setupFileInput} from './points_extractor.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'; 
import { stitchLines } from './stitcher.js';
import { setupAxisHelper, renderAxisHelper } from './axis_helper.js';
import { setupBoundaryDrawer, getDrawnPoints, clearBoundaries } from './boundary_drawer.js';
import { setupCameraMovement, updateCameraMovement } from './camera_movement.js';
import { setupMesher } from './mesh_generator.js';
import { buildCgalMesh } from './cgal_mesher.js';
import { buildViaSolid, computeViaSolidVolumes } from './via_solid.js';
import { setupTypeToggles } from './type_toggles.js';
import { setupClipTest } from './clip_test.js';
import { buildSlice, renderSlices, exportDxf, AXIS_MAP } from './slicer_ui.js';
import { buildDuongLoMesh } from './duong_lo_mesher.js';
import { trimToBoundaries } from './boundary_trim.js';

let geometry, camera, line, scene, meshGroup
const rawDataSegments = []; // Keep a reference to the untouched original lines

const load = async () => {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    console.log('Backend status:', data.status, 'Time:', data.timestamp);
  } catch (error) {
    console.error('Failed to fetch from backend:', error);
  }

  initThreeJS();
  setupFileInput(handleNewPoints);
};

function initThreeJS() {
  const canvas = document.getElementById('three-canvas');
  if (!canvas) return;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // Add the Axis Helper to visually debug the X, Y, Z coordinate space
  // We initialize it (it builds a secondary small scene for the corner)
  setupAxisHelper();

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100000);
  camera.position.z = 5;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  
  renderer.localClippingEnabled = true; 
  renderer.autoClear = false;

  scene.userData.renderer = renderer;

  const controls = new OrbitControls(camera, renderer.domElement);
  // Optional but nice: Adds smooth drifting when you stop dragging
  controls.enableDamping = true;
  controls.dampingFactor = 0.05; 

  // Initialize Keyboard Panning Setup
  setupCameraMovement();

  // ----- FAST Z-LAYER STITCHING LOGIC -----
  setupMesher(scene, rawDataSegments);

  // ----- CGAL / HYBRID MESH BUTTONS -----
  const meshOpts = () => {
    const slopeInput = document.getElementById('cgal-slope');
    const slopeVal = slopeInput && slopeInput.value !== '' ? Number(slopeInput.value) : null;
    const opts = {};
    if (Number.isFinite(slopeVal) && slopeVal >= 0) opts.slope = slopeVal;
    return opts;
  };
  const cgalBtn = document.getElementById('cgal-mesh-btn');
  if (cgalBtn) {
    cgalBtn.addEventListener('click', () => buildCgalMesh(rawDataSegments, meshGroup, meshOpts()));
  }
  const hybridBtn = document.getElementById('hybrid-mesh-btn');
  if (hybridBtn) {
    hybridBtn.addEventListener('click', () => buildCgalMesh(rawDataSegments, meshGroup, { ...meshOpts(), hybrid: true }));
  }
  // ----- VIA SOLID BUTTON -----
  const viaSolidBtn = document.getElementById('via-solid-btn');
  if (viaSolidBtn) {
    viaSolidBtn.addEventListener('click', () => buildViaSolid(meshGroup));
  }
  const viaVolumeBtn = document.getElementById('via-volume-btn');
  if (viaVolumeBtn) {
    viaVolumeBtn.addEventListener('click', () => computeViaSolidVolumes(meshGroup));
  }
  // ----- BUILD LO BUTTON -----
  const buildLoBtn = document.getElementById('build-lo-btn');
  if (buildLoBtn) {
    buildLoBtn.addEventListener('click', () => {
      const wallH = parseFloat(document.getElementById('lo-wall-height')?.value) || 0;
      buildDuongLoMesh(rawDataSegments, meshGroup, wallH);
    });
  }
  // ----- SLICE BUTTON -----
  let lastSliceData = null;
  const sliceBtn      = document.getElementById('slice-btn');
  const exportDxfBtn  = document.getElementById('export-dxf-btn');
  if (sliceBtn) {
    sliceBtn.addEventListener('click', async () => {
      const axisKey = document.getElementById('slice-axis')?.value || 'z+';
      const step    = parseFloat(document.getElementById('slice-step')?.value) || 5.0;
      const axis    = AXIS_MAP[axisKey] || [0, 0, 1];
      sliceBtn.disabled  = true;
      sliceBtn.innerText = 'Slicing…';
      try {
        lastSliceData = await buildSlice(rawDataSegments, { axis, step });
        if (lastSliceData) {
          renderSlices(lastSliceData, meshGroup);
          if (exportDxfBtn) {
            exportDxfBtn.disabled        = false;
            exportDxfBtn.style.opacity   = '1';
          }
        }
      } catch (e) {
        alert('Slice failed: ' + e.message);
      } finally {
        sliceBtn.disabled  = false;
        sliceBtn.innerText = 'Slice';
      }
    });
  }
  if (exportDxfBtn) {
    exportDxfBtn.addEventListener('click', () => {
      if (!lastSliceData) return;
      const axisKey = document.getElementById('slice-axis')?.value || 'z+';
      const axis    = AXIS_MAP[axisKey] || [0, 0, 1];
      exportDxf(lastSliceData, { axis, filename: `contours_${axisKey}.dxf` });
    });
  }
  // -------------------------------

// Material
	const material = new THREE.LineBasicMaterial( { color: 0x0000ff } );

  // We'll store all our lines inside a Group to make them easy to manage
  meshGroup = new THREE.Group();
  scene.add(meshGroup);
  // Temporarily store it so handleNewPoints can access it
  scene.userData.meshGroup = meshGroup;

  // Initialize the boundary drawer module
  setupClipTest(rawDataSegments, renderer, meshGroup);

  // Toggle visibility of all imported contour lines.
  const toggleLinesBtn = document.getElementById('toggle-lines-btn');
  if (toggleLinesBtn) {
    let linesVisible = true;
    toggleLinesBtn.addEventListener('click', () => {
      linesVisible = !linesVisible;
      for (const c of [...meshGroup.children])
        if (c.isLine) c.visible = linesVisible;
      toggleLinesBtn.innerText  = linesVisible ? 'Hide Lines' : 'Show Lines';
      toggleLinesBtn.style.background = linesVisible ? '#555' : '#222';
    });
  }
  setupBoundaryDrawer(scene, camera, controls, meshGroup);
  setupTypeToggles(scene);

	const points = [];
	points.push( new THREE.Vector3( - 5, -3, 0 ) );
	points.push( new THREE.Vector3( 0, 2, 0 ) );
	points.push( new THREE.Vector3( 5, -3, 0 ) );

	geometry = new THREE.BufferGeometry().setFromPoints( points );
	line = new THREE.Line(geometry, material)
	meshGroup.add( line ); // Add to group instead of directly to scene

  // Handle window resize
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Animation loop
  function animate() {
    requestAnimationFrame(animate);
    
    // Process WASD panning hooks BEFORE we update the OrbitControls
    updateCameraMovement(camera, controls);

    controls.update();
    
    // 1. Manually clear the renderer since we disabled autoClear
    renderer.clear();
    
    // 2. Render the big main scene taking up the whole screen
    renderer.render(scene, camera);
    
    // 3. Render the little axis gizmo over top of it in the corner
    renderAxisHelper(renderer, camera);
  }

  animate();
}

function handleNewPoints(arrayOfLineSegments) {
  // Hard-trim every line to its group's boundary (plan view) before anything uses it.
  const trim = trimToBoundaries(arrayOfLineSegments);
  arrayOfLineSegments = trim.segments;
  if (trim.removedVerts > 0)
    console.log(`[trim] ${trim.removedVerts} vertices outside the boundary removed: ${trim.trimmedLines} line(s) trimmed, ${trim.droppedLines} dropped`);

  // Sort the lines topologically by their Z height so algorithms that walk the layers (like the Mesher)
  // don't get completely confused if the JSON file has elements randomly out-of-order!
  arrayOfLineSegments.sort((a, b) => {
      if (!a.length || !b.length) return 0;
      // Sort descending (top to bottom) or ascending (bottom to top)
      return b[0].z - a[0].z; 
  });

  // Store globally so the Fast Stitch / CGAL buttons can access the data
  rawDataSegments.length = 0;
  // Avoid spread operator here: push(...largeArray) passes every element as a
  // call-stack argument and throws "Maximum call stack size exceeded" on big files.
  for (const seg of arrayOfLineSegments) rawDataSegments.push(seg);

  // Clear out ANY old lines/points inside the group (and free their GPU buffers)
  meshGroup.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) [].concat(o.material).forEach(m => m.dispose());
  });
  meshGroup.clear();

  // Automatically clear old drawn boundaries so they don't incorrectly apply to the new file
  clearBoundaries();

  const centerBox = buildLineObjects(arrayOfLineSegments).reduce((box, obj) => {
    meshGroup.add(obj);
    obj.geometry.computeBoundingBox();
    return box.union(obj.geometry.boundingBox);
  }, new THREE.Box3());

  // 3. Re-center the entire mesh group and camera
  const center = new THREE.Vector3();
  centerBox.getCenter(center);
  
  // Automatically calculate the furthest edge to pull the camera backwards
  const size = new THREE.Vector3();
  centerBox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);

  meshGroup.position.set(-center.x, -center.y, -center.z);
  camera.position.z = maxDim > 0 ? maxDim * 1.5 : 5;
}

// Draw all loaded lines as a handful of merged LineSegments objects — one per
// (kind, featureType, duong lo layer) — instead of one THREE.Line per polyline: a
// dataset of thousands of lines was thousands of draw calls every frame.
// Per vertex, userData.segIndex / vtxIndex give the source line's index in the
// loaded array (= rawDataSegments) and the vertex's index within that line, so the
// tooltip and the boundary drawer's snapping can still name the line they hit.
const DUONG_LO_COLORS = { nen: 0xff8800, noc: 0x00ddff, bien: 0xcccccc };

function buildLineObjects(segments) {
  const buckets = new Map();
  segments.forEach((seg, index) => {
    if (seg.length < 2) return; // single points draw nothing as a line
    // TietDien vertices are in local CAD block space, not world coords — exclude from scene
    if (seg.isDuongLo && seg.duongLoLayer === 'tiet dien') return;
    const kind = seg.isDuongLo ? 'duongLo' : seg.isStitchRegion ? 'stitch' : seg.isBoundary ? 'boundary' : 'line';
    const key = `${kind}|${seg.featureType || ''}|${seg.isDuongLo ? seg.duongLoLayer : ''}`;
    if (!buckets.has(key)) buckets.set(key, { kind, seg, items: [], nVerts: 0 });
    const b = buckets.get(key);
    b.items.push(index);
    b.nVerts += (seg.length - 1) * 2;
  });

  const color = new THREE.Color();
  const objects = [];
  for (const { kind, seg: first, items, nVerts } of buckets.values()) {
    const pos = new Float32Array(nVerts * 3);
    const col = kind === 'line' ? new Float32Array(nVerts * 3) : null;
    const segIndex = new Uint32Array(nVerts), vtxIndex = new Uint32Array(nVerts);
    let o = 0;
    for (const index of items) {
      const seg = segments[index];
      if (col) color.setHSL(Math.floor((index / segments.length) * 360) / 360, 1.0, 0.65, THREE.SRGBColorSpace);
      for (let i = 0; i + 1 < seg.length; i++) {
        for (const k of [i, i + 1]) {
          pos[o * 3] = seg[k].x; pos[o * 3 + 1] = seg[k].y; pos[o * 3 + 2] = seg[k].z;
          if (col) { col[o * 3] = color.r; col[o * 3 + 1] = color.g; col[o * 3 + 2] = color.b; }
          segIndex[o] = index; vtxIndex[o] = k;
          o++;
        }
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (col) geom.setAttribute('color', new THREE.BufferAttribute(col, 3));

    const material =
        kind === 'duongLo'  ? new THREE.LineBasicMaterial({ color: DUONG_LO_COLORS[first.duongLoLayer] ?? 0xffffff, depthTest: false })
      : kind === 'stitch'   ? new THREE.LineBasicMaterial({ color: 0xff00ff, depthTest: false }) // hybrid-mesh stitch region outline
      : kind === 'boundary' ? new THREE.LineBasicMaterial({ color: 0xffffff })
      :                       new THREE.LineBasicMaterial({ vertexColors: true });

    const obj = new THREE.LineSegments(geom, material);
    obj.name = `Lines_${kind}${first.featureType ? '_' + first.featureType : ''}`;
    obj.userData = { loadedLines: true, segIndex, vtxIndex };
    if (first.featureType)  obj.userData.featureType  = first.featureType;
    if (first.isDuongLo)    obj.userData.isDuongLo    = true;
    if (first.duongLoLayer) obj.userData.duongLoLayer = first.duongLoLayer;
    objects.push(obj);
  }
  return objects;
}

load();