
import * as THREE from 'three';
// Function to handle the file upload
export async function setupFileInput(onDataLoaded) {
  const fileInput = document.getElementById('json-upload');
  if (!fileInput) return;

  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      const fileText = await file.text();
      
      const data = JSON.parse(fileText);
      
      const lineSegments = [];

      data.forEach(meshItem => {
        if (!meshItem.FlattenedVertices) return;

        let currentSegment = [];
        let currentZ = null;

        const isBoundary = meshItem.IsBoundary === true || 
                           meshItem.Type === 'Polyline3d' || 
                           meshItem.Type === '3D Polyline' || 
                           meshItem.Type === 'Boundary';

        meshItem.FlattenedVertices.forEach(vertex => {
          const z = vertex[2];
          
          // If the Z value changes, start a new line segment (UNLESS it's a boundary line, which is allowed to be 3D!)
          if (!isBoundary && currentZ !== null && currentZ !== z) {
            if (currentSegment.length > 0) {
              currentSegment.isBoundary = false;
              lineSegments.push(currentSegment);
            }
            currentSegment = [];
          }

          currentSegment.push(new THREE.Vector3(vertex[0], vertex[1], z));
          currentZ = z;
        });
        
        if (currentSegment.length > 0) {
          currentSegment.isBoundary = isBoundary;
          lineSegments.push(currentSegment);
        }
      });

      // --- SPATIAL PROXIMITY CHAINING (HILL CLUSTERING) ---
      // Group lines geographically rather than blindly sorting all layers together by Z.
      // This prevents "skirts" from jumping across the map or down to the floor,
      // as separate topographic peaks are kept independent in the iteration array.

      lineSegments.sort((a,b) => b[0].z - a[0].z); // Initial global top-to-bottom sort

      const buildSpatialChains = (segments) => {
        const visited = new Array(segments.length).fill(false);
        const chains = [];

        // Helper to check if two bounding boxes overlap with some padding
        const doBoxesOverlap = (segA, segB) => {
          const boxA = new THREE.Box3().setFromPoints(segA);
          const boxB = new THREE.Box3().setFromPoints(segB);
          // Expand slightly to ensure we catch very steep cliffs that don't perfectly overlap
          // Also expand Z infinitely so vertical bounding box check doesn't fail due to Z differences
          boxA.expandByVector(new THREE.Vector3(50, 50, 10000));
          return boxA.intersectsBox(boxB);
        };

        // BFS to find all connected layers of a specific hill structure
        for (let i = 0; i < segments.length; i++) {
          if (visited[i] || segments[i].isBoundary) continue;
          
          const currentChain = [];
          const queue = [i];
          visited[i] = true;

          while (queue.length > 0) {
            const currIdx = queue.shift();
            const currSeg = segments[currIdx];
            currentChain.push(currSeg);

            // Look for valid topological neighbors (children or parents in the same hill)
            for (let j = 0; j < segments.length; j++) {
              if (visited[j] || segments[j].isBoundary) continue;
              
              const zA = currSeg[0].z;
              const zB = segments[j][0].z;
              
              // Only cluster layers that are directly adjacent vertically (allow larger units in case of steep drops)
              const zDiff = Math.abs(zA - zB);
              if (zDiff > 0.001 && zDiff <= 300) {
                if (doBoxesOverlap(currSeg, segments[j])) {
                  // To be completely sure it's the same hill, we check actual distance
                  let minDistance = Infinity;
                  const stepA = Math.max(1, Math.floor(currSeg.length / 20));
                  const stepB = Math.max(1, Math.floor(segments[j].length / 20));
                  
                  for(let a=0; a<currSeg.length; a+=stepA) {
                    for(let b=0; b<segments[j].length; b+=stepB) {
                      const dist = Math.hypot(currSeg[a].x - segments[j][b].x, currSeg[a].y - segments[j][b].y);
                      if (dist < minDistance) minDistance = dist;
                    }
                  }

                  if (minDistance < 500.0) {
                    visited[j] = true;
                    queue.push(j);
                  }
                }
              }
            }
          }
          
          // Sort this isolated hill descending by Z
          currentChain.sort((a,b) => b[0].z - a[0].z);
          chains.push(currentChain);
        }

        // Add boundary segments back as their own chains
        for (let i = 0; i < segments.length; i++) {
          if (segments[i].isBoundary) {
            chains.push([segments[i]]);
          }
        }

        return chains;
      };

      const chainedSegments = buildSpatialChains(lineSegments);        console.log(`Extracted ${chainedSegments.length} independent topological features (Hills/Ravines/Boundaries).`);
        // Pass the clustered Array of Arrays back
      if (onDataLoaded) {
        onDataLoaded(chainedSegments);
      }

    } catch (error) {
      console.error('Error reading or parsing the JSON file:', error);
      alert('Invalid JSON file!');
    }
  });
}