
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
        const isHole      = meshItem.IsHole      === true;
        const isBreakLine = meshItem.IsBreakLine === true || meshItem.IsBreakline === true;
        const blockName = meshItem.BlockName || null;
        const viaName   = meshItem.ViaName   || null;
        const handle    = meshItem.Handle    || null;  // AutoCAD entity handle (hex, e.g. "2F4A")
        const layer     = meshItem.Layer     || null;  // AutoCAD layer name

        // Normalise the Type string to a simple ASCII key for featureType.
        const rawType = (meshItem.Type || '').normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const featureType = rawType.includes('vach') ? 'vach'
                          : rawType.includes('tru')  ? 'tru'
                          : (rawType.includes('be mat') || rawType.includes('bemat')) ? 'bemat'
                          : null;
        const isBemat = featureType === 'bemat';

        meshItem.FlattenedVertices.forEach(vertex => {
          const x = vertex[0];
          const y = vertex[1];
          const z = vertex[2];

          // ── DEBUG OFFSET (remove when done testing) ──────────────────
          // Shift Trụ 50 units down so Vách and Trụ surfaces are visually
          // separated and easy to verify independently before volume work.
          const debugX = featureType === 'tru' ? x - 0 : x;
          const debugY = featureType === 'tru' ? y - 0 : y;
          const debugZ = featureType === 'tru' ? z - 0 : z;
          // ─────────────────────────────────────────────────────────────
          
          // If the Z value changes, start a new line segment
          // (holes and boundaries are 3D closed loops — never split them)
          if (!isBoundary && !isHole && !isBreakLine && !isBemat && currentZ !== null && currentZ !== z) {
            if (currentSegment.length > 0) {
              currentSegment.isBoundary  = false;
              currentSegment.isBreakLine = isBreakLine;
              currentSegment.isBemat     = isBemat;
              currentSegment.featureType = featureType;
              currentSegment.blockName   = blockName;
              currentSegment.viaName     = viaName;
              currentSegment.handle      = handle;
              currentSegment.layer       = layer;
              lineSegments.push(currentSegment);
            }
            currentSegment = [];
          }

          currentSegment.push(new THREE.Vector3(debugX, debugY, debugZ));
          currentZ = z;
        });
        
        if (currentSegment.length > 0) {
          currentSegment.isBoundary  = isBoundary;
          currentSegment.isHole      = isHole;
          currentSegment.isBreakLine = isBreakLine;
          currentSegment.isBemat     = isBemat;
          currentSegment.featureType = featureType;
          currentSegment.blockName   = blockName;
          currentSegment.viaName     = viaName;
          currentSegment.handle      = handle;
          currentSegment.layer       = layer;
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