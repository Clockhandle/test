import * as THREE from 'three';
import {setupFileInput} from './points_extractor.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'; 
import { stitchLines, uniformStitch } from './stitcher.js'; // <-- NEW
import { setupAxisHelper, renderAxisHelper } from './axis_helper.js';
import { setupBoundaryDrawer, getDrawnPoints } from './boundary_drawer.js';
import { setupCameraMovement, updateCameraMovement } from './camera_movement.js';

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
  const stitchBtn = document.getElementById('stitch-mesh-btn');
  if (stitchBtn) {
    stitchBtn.addEventListener('click', () => {
      console.log('Stitch Button Clicked. Layers loaded:', rawDataSegments.length);
      if (rawDataSegments.length < 2) {
        alert("Need at least 2 layers of points loaded to stitch together!");
        return;
      }
      
      console.log('Total Layers to stitch:', rawDataSegments.length);

      const wireMat = new THREE.LineBasicMaterial({ color: 0xffffff });

      let stitchedCount = 0;
      for (let i = 0; i < rawDataSegments.length - 1; i++) {
        console.log(`Stitching layer ${i} to layer ${i + 1}...`);
        
        const hue = (i / (rawDataSegments.length - 1)) * 360; 
        const material = new THREE.MeshBasicMaterial({ 
          color: new THREE.Color(`hsl(${Math.floor(hue)}, 100%, 65%)`), 
          side: THREE.DoubleSide, 
          transparent: true,
          opacity: 0.6 
        });

        let lineA = rawDataSegments[i];
        let lineB = rawDataSegments[i + 1];

        // --- BOUNDARY CONSTRAINT LOGIC ---
        let hasActiveBoundary = false;

        // If the user actively drew boundaries, we check if any apply to this specific layer pair!
        if (getDrawnPoints().length >= 4) {

          for (let p = 0; p < getDrawnPoints().length; p += 4) {
            if (p + 3 >= getDrawnPoints().length) break;

            const pt1 = getDrawnPoints()[p];
            const pt2 = getDrawnPoints()[p+1];

            // Safely grab the EXACT topological layer constraints recorded during click/drag
            const layerA = pt1.layerIndex !== undefined ? pt1.layerIndex : 0;
            const layerB = pt2.layerIndex !== undefined ? pt2.layerIndex : rawDataSegments.length - 1;
            
            const constraintMinLayer = Math.min(layerA, layerB);
            const constraintMaxLayer = Math.max(layerA, layerB);

            // HARDCODE: If the current layer pair (i and i+1) is completely outside the strictly drawn bounds, skip!
            if (i < constraintMinLayer || i + 1 > constraintMaxLayer) {
              continue;
            }

            // We found a boundary that explicitly controls this pair of layers!
            hasActiveBoundary = true;

            const findBounds = (line, currentLayerIndex) => {
              let minIdx = Infinity, maxIdx = -Infinity;

              for (let k = p; k <= p + 2; k += 2) {
                const drawStart = getDrawnPoints()[k];
                const drawEnd = getDrawnPoints()[k+1];
                const wall = new THREE.Line3(drawStart, drawEnd);
                
                let closestDist = Infinity, closestIdx = -1, isSpannedByBoundary = false;

                // First, check if this wall directly snapped to this exact layer!
                // If it did, we completely bypass 3D math and perfectly use the topological index!
                if (drawStart.layerIndex === currentLayerIndex && drawStart.vertexIndex !== undefined) {
                   closestIdx = drawStart.vertexIndex;
                   isSpannedByBoundary = true;
                } else if (drawEnd.layerIndex === currentLayerIndex && drawEnd.vertexIndex !== undefined) {
                   closestIdx = drawEnd.vertexIndex;
                   isSpannedByBoundary = true;
                } else {
                  // Fallback for intermediate skipped layers: find mathematically closest vertex projection
                  for (let j = 0; j < line.length; j++) {
                    const worldPos = line[j].clone().applyMatrix4(meshGroup.matrixWorld);
                    const t = wall.closestPointToPointParameter(worldPos, false);
                    if (t >= -0.1 && t <= 1.1) {
                      isSpannedByBoundary = true;
                      let ptWall = new THREE.Vector3();
                      wall.closestPointToPoint(worldPos, true, ptWall);
                      const dist = ptWall.distanceTo(worldPos);
                      if (dist < closestDist) {
                        closestDist = dist;
                        closestIdx = j;
                      }
                    }
                  }
                }

                if (isSpannedByBoundary && closestIdx !== -1) {
                  minIdx = Math.min(minIdx, closestIdx);
                  maxIdx = Math.max(maxIdx, closestIdx);
                }
              }
              return { minIdx, maxIdx };
            };

            const boundsA = findBounds(lineA, i);
            const boundsB = findBounds(lineB, i + 1);

            if (boundsA.minIdx !== Infinity && boundsB.minIdx !== Infinity && boundsA.minIdx !== boundsA.maxIdx && boundsB.minIdx !== boundsB.maxIdx) {
              const slicedLineA = lineA.slice(boundsA.minIdx, boundsA.maxIdx + 1);
              const slicedLineB = lineB.slice(boundsB.minIdx, boundsB.maxIdx + 1);
              const stitchGeom = uniformStitch(slicedLineA, slicedLineB, 20.0);
              if (stitchGeom) {
                const mesh = new THREE.Mesh(stitchGeom, material);
                meshGroup.add(mesh);
                const wireframe = new THREE.LineSegments(new THREE.WireframeGeometry(stitchGeom), wireMat);
                mesh.add(wireframe);
                stitchedCount++;
              }
            }
          }
        }
        
        // If NO boundaries were drawn specifically over this pair of layers, just stitch the whole lines!
        if (!hasActiveBoundary) {
          const stitchGeom = uniformStitch(lineA, lineB, 20.0);
          if (stitchGeom) {
            const mesh = new THREE.Mesh(stitchGeom, material);
            meshGroup.add(mesh);
            const wireframe = new THREE.LineSegments(new THREE.WireframeGeometry(stitchGeom), wireMat);
            mesh.add(wireframe);
            stitchedCount++;
          }
        }
      }

      if (stitchedCount > 0) {
        console.log(`Successfully added ${stitchedCount} multi-level mesh strips.`);
        alert(`Successfully stitched ${stitchedCount} adjacent Z-layers together!`);
      } else {
        alert("Stitching failed or returned empty geometry.");
      }
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