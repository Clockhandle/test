import * as THREE from 'three';
import { uniformStitch } from './stitcher.js';
import { getDrawnPoints } from './boundary_drawer.js';

export function setupMesher(scene, rawDataSegments) {
  const stitchBtn = document.getElementById('stitch-mesh-btn');
  if (!stitchBtn) return;

  stitchBtn.addEventListener('click', () => {
    // Dynamically fetch the meshGroup from the scene's userData, so we're always using the active one
    const meshGroup = scene.userData.meshGroup;
    if (!meshGroup) {
      console.warn("Mesh group not initialized yet.");
      return;
    }

    console.log('Stitch Button Clicked. Layers loaded:', rawDataSegments.length);
    if (rawDataSegments.length < 2) {
      alert("Need at least 2 layers of points loaded to stitch together!");
      return;
    }
    
    console.log('Total Layers to stitch:', rawDataSegments.length);

    const wireMat = new THREE.LineBasicMaterial({ color: 0xffffff });

    let stitchedCount = 0;
    for (let i = 0; i < rawDataSegments.length - 1; i++) {
      let lineA = rawDataSegments[i];
      const zA = lineA[0].z;

      // --- DYNAMIC VERTICAL TOPOLOGY FIX ---
      // Find ALL correct physical partners on the NEXT Z level.
      let targetJs = [];
      let nextZ = null;
      let candidates = [];

      // 1. Gather all candidates on the next available Z-level
      for (let j = i + 1; j < rawDataSegments.length; j++) {
          const zB = rawDataSegments[j][0].z;
          
          // Skip lines that share the exact same Z height
          if (Math.abs(zB - zA) < 0.001) continue;

          // If we've found a new height level, lock it. If we move past it, stop searching!
          if (nextZ !== null && Math.abs(zB - nextZ) > 0.001) break;
          nextZ = zB;
          
          candidates.push(j);
      }

      if (candidates.length === 0) continue; // Top of the mountain, nothing above it

      // Bounding box for fast geographic overlap checking
      const boxA = new THREE.Box3().setFromPoints(lineA);
      // Expand slightly just to be safe with adjacent but non-intersecting grids
      const expandFactor = new THREE.Vector3(5, 5, 0); 
      boxA.expandByVector(expandFactor);

      let closestJ = -1;
      let minDistance = Infinity;

      // 2. Evaluate all candidates for physical overlaps and proximity
      for (let j of candidates) {
          const lineB_cand = rawDataSegments[j];
          
          // Geographic overlap test (XY plane)
          const boxB = new THREE.Box3().setFromPoints(lineB_cand);
          boxB.expandByVector(expandFactor);
          const overlapXY = !(boxA.max.x < boxB.min.x || boxA.min.x > boxB.max.x ||
                              boxA.max.y < boxB.min.y || boxA.min.y > boxB.max.y);

          // Compute actual geographic proximity
          let currentMin = Infinity;
          const stepA = Math.max(1, Math.floor(lineA.length / 10)); 
          const stepB = Math.max(1, Math.floor(lineB_cand.length / 10));
          
          for(let a = 0; a < lineA.length; a += stepA) {
              for(let b = 0; b < lineB_cand.length; b += stepB) {
                  const dist = Math.hypot(lineA[a].x - lineB_cand[b].x, lineA[a].y - lineB_cand[b].y);
                  if (dist < currentMin) currentMin = dist;
              }
          }

          if (currentMin < minDistance) {
              minDistance = currentMin;
              closestJ = j;
          }

          // Target condition 1: Geographic Overlap
          if (overlapXY) {
              if (!targetJs.includes(j)) targetJs.push(j);
          }
      }

      // Target condition 2: User EXPLICITLY drew a boundary connecting these two! Override distance.
      if (getDrawnPoints().length >= 4) {
          for (let j of candidates) {
              if (targetJs.includes(j)) continue; // Already added

              for (let p = 0; p < getDrawnPoints().length; p += 4) {
                  if (p + 3 >= getDrawnPoints().length) break;
                  const pt1 = getDrawnPoints()[p];
                  const pt2 = getDrawnPoints()[p+1];
                  const layer1 = pt1.layerIndex !== undefined ? pt1.layerIndex : -1;
                  const layer2 = pt2.layerIndex !== undefined ? pt2.layerIndex : -1;
                  
                  if ((layer1 === i && layer2 === j) || (layer1 === j && layer2 === i)) {
                      targetJs.push(j);
                      break;
                  }
              }
          }
      }

      // 3. Now loop over EVERY valid target layer we discovered and stitch exactly to them!
      for (let targetJ of targetJs) {
        let lineB = rawDataSegments[targetJ];
      
        console.log(`Stitching layer ${i} to dynamically found layer ${targetJ}...`);
        
        const hue = (i / (rawDataSegments.length - 1)) * 360; 
        const material = new THREE.MeshBasicMaterial({ 
          color: new THREE.Color(`hsl(${Math.floor(hue)}, 100%, 65%)`), 
          side: THREE.DoubleSide, 
          transparent: true,
          opacity: 0.6 
        });

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

            // Fetch the absolute Z heights for strict topological filtering
            const zBoundMin = Math.min(rawDataSegments[layerA][0].z, rawDataSegments[layerB][0].z);
            const zBoundMax = Math.max(rawDataSegments[layerA][0].z, rawDataSegments[layerB][0].z);
            const zTargetJ = rawDataSegments[targetJ][0].z;

            // HARDCODE: If the current layer pair (i and targetJ) is completely outside the strictly drawn bounds, skip!
            if (i < constraintMinLayer || targetJ > constraintMaxLayer) {
              continue;
            }

            // --- STRICT Y-BRANCHING BOUNDARY FIX ---
            // If this pair's upper level hits the exact Z-height of the boundary's roof, 
            // but isn't the EXACT layer index snapped by the user, skip it! (e.g. layer 12 and 13 same height)
            if (Math.abs(zTargetJ - zBoundMax) < 0.001 && targetJ !== constraintMaxLayer) {
              continue;
            }
            if (Math.abs(zA - zBoundMin) < 0.001 && i !== constraintMinLayer) {
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
            const boundsB = findBounds(lineB, targetJ);

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
          
          if (stitchGeom && stitchGeom.userData && stitchGeom.userData.debugRungs) {
              const rungsGeometry = new THREE.BufferGeometry();
              rungsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(stitchGeom.userData.debugRungs, 3));
              // Disable depth testing so the lines render ON TOP of everything, and make them bright yellow
              const rungsMaterial = new THREE.LineBasicMaterial({ 
                  color: 0xffff00, 
                  linewidth: 3,
                  depthTest: false,
                  depthWrite: false
              }); 
              const debugMesh = new THREE.LineSegments(rungsGeometry, rungsMaterial);
              debugMesh.renderOrder = 999;
              meshGroup.add(debugMesh);
          }

          if (stitchGeom) {
            const mesh = new THREE.Mesh(stitchGeom, material);
            meshGroup.add(mesh);
            
            // TEMPORARILY DISABLED WHITE WIREFRAME FOR DEBUGGING VISIBILITY
            // const wireframe = new THREE.LineSegments(new THREE.WireframeGeometry(stitchGeom), wireMat);
            // mesh.add(wireframe);
            
            stitchedCount++;
          }
        }
      } // END OF 'for (let targetJ of targetJs)' loop
    } // END OF 'for (let i = 0...)' loop

    if (stitchedCount > 0) {
      console.log(`Successfully added ${stitchedCount} multi-level mesh strips.`);
      alert(`Successfully stitched ${stitchedCount} adjacent Z-layers together!`);
    } else {
      alert("Stitching failed or returned empty geometry.");
    }
  });
}