
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

        // Vùng giới hạn region blocks are now identified by the explicit boolean
        // flag IsVungGioiHan rather than by string-matching the Type field.
        // When the flag is set, VungName / Name are the grouping keys (via / block).
        const isVungGioiHan = meshItem.IsVungGioiHan === true;
        const viaName   = isVungGioiHan
            ? (meshItem.VungName || null)
            : (meshItem.ViaName  || meshItem.VungName || null);
        let blockName = isVungGioiHan
            ? (meshItem.Name     || null)
            : (meshItem.BlockName || meshItem.Name || null);
        const handle    = meshItem.Handle    || null;  // AutoCAD entity handle (hex, e.g. "2F4A")
        const layer     = meshItem.Layer     || null;  // AutoCAD layer name

        // Normalise Type to derive featureType.
        // For IsVungGioiHan records the Type field IS the surface role ("Vách" / "Trụ").
        // For legacy gioi_han records that used Type="Vùng giới hạn", SurfaceType
        // carries the role — keep the fallback for backward compatibility.
        const rawType        = (meshItem.Type        || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const rawSurfaceType = (meshItem.SurfaceType || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const featureType =
            (rawType.includes('vach') || rawSurfaceType.includes('vach')) ? 'vach'
          : (rawType.includes('tru')  || rawSurfaceType.includes('tru'))  ? 'tru'
          : (rawType.includes('be mat') || rawType.includes('bemat'))      ? 'bemat'
          : null;
        const isBemat = featureType === 'bemat';
        // Mine-tunnel skeleton lines (Địa hình lò).
        // Detection: check for 'hinh lo' in the normalised type (the leading 'Đ'
        // is U+0110 and does NOT decompose under NFD, so 'dia hinh lo' never
        // matches — use 'hinh lo' instead), or fall back to the LayerType field
        // which is only present on duong-lo records.
        const isDuongLo = rawType.includes('hinh lo') || !!meshItem.LayerType;
        let duongLoLayer = isDuongLo
            ? (meshItem.LayerType || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
            : null;
        // Loai 2: remap grouping key and layer tokens expected by the mesher.
        const isLoai2      = rawType.includes('loai 2');
        const tietDienName = isLoai2 ? (meshItem.TietDienName || null) : null;
        if (isLoai2) {
            blockName    = meshItem.DuongLoName || blockName;
            // LayerType = new format; SubType = old format
            const sub    = (meshItem.LayerType || meshItem.SubType || '').toLowerCase();
            duongLoLayer = sub === 'tietdien' ? 'tiet dien' : 'nen';
        }
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
          // (holes, boundaries, breaklines, bemat, and mine-path lines are 3-D
          // continuous paths that must never be split by Z-layer logic)
          if (!isBoundary && !isHole && !isBreakLine && !isBemat && !isDuongLo && currentZ !== null && currentZ !== z) {
            if (currentSegment.length > 0) {
              currentSegment.isBoundary  = false;
              currentSegment.isBreakLine = isBreakLine;
              currentSegment.isBemat     = isBemat;
              currentSegment.isDuongLo    = isDuongLo;
              currentSegment.duongLoLayer  = duongLoLayer;
              currentSegment.tietDienName  = tietDienName;
              currentSegment.featureType   = featureType;
              currentSegment.blockName     = blockName;
              currentSegment.viaName       = viaName;
              currentSegment.handle        = handle;
              currentSegment.layer         = layer;
              lineSegments.push(currentSegment);
            }
            currentSegment = [];
          }

          currentSegment.push(new THREE.Vector3(debugX, debugY, debugZ));
          currentZ = z;
        });
        
        if (currentSegment.length > 0) {
          // For closed Đứt gãy fault lines (IsClosed:true), the CAD data does not
          // repeat the first vertex — add it explicitly so the cutting wall becomes
          // a closed cylinder for polyline_split instead of an open curtain.
          // Note: 'Đứt gãy' normalises to 'đut gay'; use 'ut gay' to avoid the
          // non-decomposable Đ/đ character.
          const isClosed         = meshItem.IsClosed === true;
          const isDutGay          = rawType.includes('ut gay');
          const isLoai2TietDien   = isLoai2 && (meshItem.SubType === 'TietDien' || meshItem.LayerType === 'TietDien');
          if ((isDutGay || isLoai2TietDien) && isClosed && currentSegment.length >= 2) {
              const first = currentSegment[0];
              currentSegment.push(new THREE.Vector3(first.x, first.y, first.z));
          }
          currentSegment.isBoundary   = isBoundary;
          currentSegment.isHole       = isHole;
          currentSegment.isBreakLine  = isBreakLine;
          currentSegment.isBemat      = isBemat;
          currentSegment.isDuongLo    = isDuongLo;
          currentSegment.duongLoLayer  = duongLoLayer;
          currentSegment.tietDienName  = tietDienName;
          currentSegment.featureType   = featureType;
          currentSegment.blockName     = blockName;
          currentSegment.viaName       = viaName;
          currentSegment.handle        = handle;
          currentSegment.layer         = layer;
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