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

  // ----- CGAL MESH BUTTON -----
  const cgalBtn = document.getElementById('cgal-mesh-btn');
  if (cgalBtn) {
    cgalBtn.addEventListener('click', () => {
      const slopeInput = document.getElementById('cgal-slope');
      const slopeVal = slopeInput && slopeInput.value !== '' ? Number(slopeInput.value) : null;
      const opts = {};
      if (Number.isFinite(slopeVal) && slopeVal >= 0) opts.slope = slopeVal;
      buildCgalMesh(rawDataSegments, meshGroup, opts);
    });
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
    buildLoBtn.addEventListener('click', () => buildDuongLoMesh(rawDataSegments, meshGroup));
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
  // Sort the lines topologically by their Z height so algorithms that walk the layers (like the Mesher)
  // don't get completely confused if the JSON file has elements randomly out-of-order!
  arrayOfLineSegments.sort((a, b) => {
      if (!a.length || !b.length) return 0;
      // Sort descending (top to bottom) or ascending (bottom to top)
      return b[0].z - a[0].z; 
  });

  // Store globally so the Fast Stitch / CGAL buttons can access the data
  rawDataSegments.length = 0;
  rawDataSegments.push(...arrayOfLineSegments);

  // Clear out ANY old lines/points inside the group
  meshGroup.clear();

  // Automatically clear old drawn boundaries so they don't incorrectly apply to the new file
  clearBoundaries();

  const centerBox = new THREE.Box3(); // To calculate total bounds

  arrayOfLineSegments.forEach((segmentArray, index) => {
    
    const hue = (index / arrayOfLineSegments.length) * 360; 
    let layerMaterial;
    
    if (segmentArray.isDuongLo) {
      // Mine-tunnel skeleton: colour by layer type
      //   Nền (floor) = orange, Nóc (roof) = cyan, Biên (wall) = light grey
      const duongLoColor =
          segmentArray.duongLoLayer === 'nen'  ? 0xff8800 :
          segmentArray.duongLoLayer === 'noc'  ? 0x00ddff :
          segmentArray.duongLoLayer === 'bien' ? 0xcccccc : 0xffffff;
      layerMaterial = new THREE.LineBasicMaterial({ color: duongLoColor, depthTest: false });
    } else if (segmentArray.isBoundary) {
      layerMaterial = new THREE.LineBasicMaterial({
         color: 0xffffff,
         linewidth: 3,
      });
    } else {
      layerMaterial = new THREE.LineBasicMaterial({
        color: new THREE.Color(`hsl(${Math.floor(hue)}, 100%, 65%)`),
      });
    }

    const newGeom = new THREE.BufferGeometry().setFromPoints(segmentArray);
    
    // ... rest of your code ...
    
    // Add that geometry bounding box into our 'total scene bounds' calculation
    newGeom.computeBoundingBox();
    centerBox.expandByPoint(newGeom.boundingBox.min);
    centerBox.expandByPoint(newGeom.boundingBox.max);

    // Create an independent line, then add it to our parent mesh group!
    const newLine = new THREE.Line(newGeom, layerMaterial);
    if (segmentArray.featureType)  newLine.userData.featureType  = segmentArray.featureType;
    if (segmentArray.isDuongLo)    newLine.userData.isDuongLo    = true;
    if (segmentArray.duongLoLayer) newLine.userData.duongLoLayer = segmentArray.duongLoLayer;
    meshGroup.add(newLine);
  });

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

load();