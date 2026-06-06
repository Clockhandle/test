
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
        const isBreakLine = meshItem.IsBreakLine === true;
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

      // Z-OUTLIER DETECTION
      // Flag segments that contain vertices whose Z is more than 3×IQR outside
      // [Q1, Q3] of the whole dataset.  Typical cause: drafter left Z unset
      // (defaults to 0) — shows as vertical spikes in the side view.
      //
      // Scatter/elevation points (isBemat) and breaklines are valid survey
      // reference data — their Z values ARE the surface. Exclude them from
      // both the IQR pool and the outlier check so they are never falsely flagged.
      {
        const _allZ = [];
        for (const s of lineSegments) {
          if (s.isBemat || s.isBreakLine) continue;  // reference data — skip
          for (const v of s) _allZ.push(v.z);
        }
        if (_allZ.length > 1) {
          const _sorted = [..._allZ].sort((a, b) => a - b);
          const _q1    = _sorted[Math.floor(_sorted.length * 0.25)];
          const _q3    = _sorted[Math.floor(_sorted.length * 0.75)];
          const _iqr   = _q3 - _q1;
          const _zLow  = _q1 - 3 * _iqr;
          const _zHigh = _q3 + 3 * _iqr;
          // Also flag exact Z=0 when the dataset median is far from zero —
          // AutoCAD defaults unset Z to exactly 0.0, which is the primary
          // cause of vertical spikes in negative-elevation mining data.
          const _median = _sorted[Math.floor(_sorted.length * 0.5)];
          const _flagZero = Math.abs(_median) > 10;
          for (const seg of lineSegments) {
            if (seg.isBemat || seg.isBreakLine) continue;  // reference data — skip
            const bad = seg.filter(v =>
              v.z < _zLow || v.z > _zHigh || (_flagZero && v.z === 0)
            );
            if (bad.length > 0)
              seg.zOutliers = bad.map(v => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]);
          }
        }
      }

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