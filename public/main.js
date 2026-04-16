import * as THREE from 'three';
import {setupFileInput} from './points_extractor.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'; 
import { stitchLines } from './stitcher.js';
import { setupAxisHelper, renderAxisHelper } from './axis_helper.js';
import { setupBoundaryDrawer, getDrawnPoints } from './boundary_drawer.js';
import { setupCameraMovement, updateCameraMovement } from './camera_movement.js';
import { setupMesher } from './mesh_generator.js';

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
  
  // We MUST turn autoClear off so the corner widget doesn't erase the main scene when it renders
  renderer.autoClear = false;

  const controls = new OrbitControls(camera, renderer.domElement);
  // Optional but nice: Adds smooth drifting when you stop dragging
  controls.enableDamping = true;
  controls.dampingFactor = 0.05; 

  // Initialize Keyboard Panning Setup
  setupCameraMovement();

  // ----- FAST Z-LAYER STITCHING LOGIC -----
  setupMesher(scene, rawDataSegments);
  // -------------------------------

// Material
	const material = new THREE.LineBasicMaterial( { color: 0x0000ff } );

  // We'll store all our lines inside a Group to make them easy to manage
  meshGroup = new THREE.Group();
  scene.add(meshGroup);
  // Temporarily store it so handleNewPoints can access it
  scene.userData.meshGroup = meshGroup;

  // Initialize the boundary drawer module
  setupBoundaryDrawer(scene, camera, controls, meshGroup);

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
  // Store globally so the Fast Stitch / CGAL buttons can access the data
  rawDataSegments.length = 0;
  rawDataSegments.push(...arrayOfLineSegments);

  // Clear out ANY old lines/points inside the group
  meshGroup.clear();

  const centerBox = new THREE.Box3(); // To calculate total bounds

  // 2. Loop through each independent array of points (each layer/segment)
  arrayOfLineSegments.forEach((segmentArray, index) => {
    
    // Create a distinctive color that pops for each line using HSL (Hue, Saturation, Lightness)
    // By dividing the current index by the total length, we sweep cleanly across the full rainbow
    const hue = (index / arrayOfLineSegments.length) * 360; 
    const layerMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(`hsl(${Math.floor(hue)}, 100%, 65%)`) // 100% saturation, 65% lightness to pop against dark backgrounds
    });

    // Create an independent geometry for exactly this block of points
    const newGeom = new THREE.BufferGeometry().setFromPoints(segmentArray);
    
    // Add that geometry bounding box into our 'total scene bounds' calculation
    newGeom.computeBoundingBox();
    centerBox.expandByPoint(newGeom.boundingBox.min);
    centerBox.expandByPoint(newGeom.boundingBox.max);

    // Create an independent line, then add it to our parent mesh group!
    const newLine = new THREE.Line(newGeom, layerMaterial);
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