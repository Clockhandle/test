
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

        meshItem.FlattenedVertices.forEach(vertex => {
          const z = vertex[2];
          
          // If the Z value changes, start a new line segment
          if (currentZ !== null && currentZ !== z) {
            if (currentSegment.length > 0) {
              lineSegments.push(currentSegment);
            }
            currentSegment = [];
          }

          currentSegment.push(new THREE.Vector3(vertex[0], vertex[1], z));
          currentZ = z;
        });
        
        if (currentSegment.length > 0) {
          lineSegments.push(currentSegment);
        }
      });

      // SORT SEGMENTS BY Z-HEIGHT
      // This ensures that layer index 0 is at the bottom and layer 'Max' is at the top,
      // fixing issues where the JSON file stores the layers out of vertical order!
      lineSegments.sort((segmentA, segmentB) => {
        return segmentA[0].z - segmentB[0].z; 
      });

      // Pass the nested array of vertices back
      if (onDataLoaded) {
        onDataLoaded(lineSegments);
      }

    } catch (error) {
      console.error('Error reading or parsing the JSON file:', error);
      alert('Invalid JSON file!');
    }
  });
}