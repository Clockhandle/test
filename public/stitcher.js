import * as THREE from 'three';

/**
 * A fast, lightweight "Zippering" algorithm to stitch two 3D polylines into a unified mesh.
 * This is incredibly efficient for topological layers where you just want to connect the Z-levels.
 */
export function stitchLines(line1, line2) {
  const vertices = [];
  const indices = [];

  const L1 = line1.length;
  const L2 = line2.length;

  if (L1 === 0 || L2 === 0) return null;

  // 1. Flatten all vertices into a single coordinate array for Three.js BufferGeometry
  for (let p of line1) vertices.push(p.x, p.y, p.z);
  for (let p of line2) vertices.push(p.x, p.y, p.z);

  // Optional: Check if lines are drawn in opposite directions and reverse the virtual reading if needed.
  // We compare the start of line1 to start vs end of line2.
  const distStartToStart = line1[0].distanceTo(line2[0]);
  const distStartToEnd = line1[0].distanceTo(line2[L2 - 1]);
  const reverseL2 = distStartToEnd < distStartToStart;
  
  console.log(`Stitching Lines. L1: ${L1}, L2: ${L2}. Reversing Line 2? ${reverseL2}`);

  let i = 0; // Pointer for line 1
  let j = 0; // Pointer for line 2

  // Helper macro to get the correct L2 index whether we are reading it forwards or backwards
  const getL2Index = (index) => reverseL2 ? (L2 - 1 - index) : index;
  const getL2Point = (index) => line2[getL2Index(index)];

  // 2. "Zipper" loop. Walk along both lines, always forming a triangle using the shortest diagonal.
  while (i < L1 - 1 || j < L2 - 1) {
    if (i === L1 - 1) {
      // Line 1 is out of points, fan out the rest of Line 2
      indices.push(i, L1 + getL2Index(j + 1), L1 + getL2Index(j));
      j++;
    } else if (j === L2 - 1) {
      // Line 2 is out of points, fan out the rest of Line 1
      indices.push(i, L1 + getL2Index(j), i + 1);
      i++;
    } else {
      // We have valid next points on both lines. Find the shortest diagonal cross-connection.
      const p1_next = line1[i + 1];
      const p2_curr = getL2Point(j);
      const d1 = p1_next.distanceTo(p2_curr); // Diagonal A

      const p1_curr = line1[i];
      const p2_next = getL2Point(j + 1);
      const d2 = p1_curr.distanceTo(p2_next); // Diagonal B

      if (d1 < d2) {
        // Connect across diagonal A
        indices.push(i, L1 + getL2Index(j), i + 1);
        i++;
      } else {
        // Connect across diagonal B
        indices.push(i, L1 + getL2Index(j + 1), L1 + getL2Index(j));
        j++;
      }
    }
  }

  // 3. Bake the geometry
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

/**
 * Advanced Stitching: Generates a uniform grid mesh by resampling both lines
 * and injecting intermediate mid-points to enforce a maximum triangle edge length.
 * This completely fixes the "long/skewed triangles" problem by subdividing the space.
 */
export function uniformStitch(line1, line2, maxEdgeLength = 20.0) {
  if (line1.length < 2 || line2.length < 2) return null;

  // 1. Check if line2 is drawn backwards relative to line1
  const distStartToStart = Math.hypot(line1[0].x - line2[0].x, line1[0].y - line2[0].y);
  const distStartToEnd = Math.hypot(line1[0].x - line2[line2.length - 1].x, line1[0].y - line2[line2.length - 1].y);
  const workingLine2 = (distStartToEnd < distStartToStart) ? [...line2].reverse() : line2;

  // 2. Subdivide the lines horizontally so no segment is longer than maxEdgeLength.
  // This physically preserves your drawn shapes while giving us enough vertices to build a uniform grid.
  function subdivideLine(line, maxEdge) {
    const result = [line[0].clone()];
    for (let i = 1; i < line.length; i++) {
        const p1 = line[i - 1];
        const p2 = line[i];
        const dist = p1.distanceTo(p2);
        const steps = Math.ceil(dist / maxEdge);
        for (let s = 1; s <= steps; s++) {
            result.push(new THREE.Vector3().lerpVectors(p1, p2, s / steps));
        }
    }
    return result;
  }

  const denseLine1 = subdivideLine(line1, maxEdgeLength);
  const denseLine2 = subdivideLine(workingLine2, maxEdgeLength);

  // 3. Compute Proportional Arc Length (t) based on 2D footprint to prevent folding
  const getXYLengths = (line) => {
    let total = 0;
    const lengths = [0];
    for (let i = 1; i < line.length; i++) {
        const dx = line[i].x - line[i-1].x;
        const dy = line[i].y - line[i-1].y;
        total += Math.hypot(dx, dy);
        lengths.push(total);
    }
    const normalized = lengths.map(l => total > 0 ? l / total : 0);
    return normalized;
  };

  const t1Data = getXYLengths(denseLine1);
  const t2Data = getXYLengths(denseLine2);

  // 4. Proportional Arc-Length Zipper: Find corresponding pairs
  const pairs = [];
  let i = 0;
  let j = 0;

  while (i < denseLine1.length - 1 || j < denseLine2.length - 1) {
    pairs.push({ p1: denseLine1[i], p2: denseLine2[j] });
    
    if (i === denseLine1.length - 1) {
      j++;
    } else if (j === denseLine2.length - 1) {
      i++;
    } else {
      const t1_next = t1Data[i + 1];
      const t2_curr = t2Data[j];
      const diffA = Math.abs(t1_next - t2_curr); 

      const t1_curr = t1Data[i];
      const t2_next = t2Data[j + 1];
      const diffB = Math.abs(t1_curr - t2_next); 

      if (diffA < diffB) {
        i++;
      } else {
        j++;
      }
    }
  }
  // Push the final matched endpoint correctly
  pairs.push({ p1: denseLine1[denseLine1.length - 1], p2: denseLine2[denseLine2.length - 1] });

  // 5. Determine uniform Vertical Steps based on max ladder distance
  let maxVDist = 0;
  for (let k = 0; k < pairs.length; k++) {
      const d = pairs[k].p1.distanceTo(pairs[k].p2);
      if (d > maxVDist) maxVDist = d;
  }
  const vSteps = Math.max(1, Math.ceil(maxVDist / maxEdgeLength));

  // 6. Generate perfect grid intersections
  const grid = [];
  for (let v = 0; v <= vSteps; v++) {
    const vT = v / vSteps;
    const currentLine = [];
    for (let k = 0; k < pairs.length; k++) {
        currentLine.push(new THREE.Vector3().lerpVectors(pairs[k].p1, pairs[k].p2, vT));
    }
    grid.push(currentLine);
  }

  // 7. Connect the grid nodes into Triangles
  const allVertices = [];
  const allIndices = [];
  let vertexOffset = 0;

  for (let r = 0; r < grid.length - 1; r++) {
    const rowA = grid[r];
    const rowB = grid[r + 1];
    
    // Flatten vertices
    for (let c = 0; c < rowA.length; c++) allVertices.push(rowA[c].x, rowA[c].y, rowA[c].z);
    for (let c = 0; c < rowB.length; c++) allVertices.push(rowB[c].x, rowB[c].y, rowB[c].z);

    const rowLen = rowA.length;
    for (let c = 0; c < rowLen - 1; c++) {
        const p0 = rowA[c];
        const p1 = rowA[c + 1];
        const p2 = rowB[c];
        const p3 = rowB[c + 1];

        // Ensure we aren't creating degenerate (0-area) triangles which can happen 
        // during fanning stages on the zipper.
        
        // Triangle 1: p0, p3, p2
        const D1 = p0.distanceTo(p3);
        const D2 = p3.distanceTo(p2);
        const D3 = p2.distanceTo(p0);
        const S1 = (D1 + D2 + D3) / 2;
        const Area1 = Math.sqrt(Math.max(0, S1 * (S1 - D1) * (S1 - D2) * (S1 - D3)));
        
        if (Area1 > 0.0001) {
            allIndices.push(
              vertexOffset + c,
              vertexOffset + rowLen + c + 1,
              vertexOffset + rowLen + c
            );
        }

        // Triangle 2: p0, p1, p3
        const da = p0.distanceTo(p1);
        const db = p1.distanceTo(p3);
        const dc = p3.distanceTo(p0);
        const S2 = (da + db + dc) / 2;
        const Area2 = Math.sqrt(Math.max(0, S2 * (S2 - da) * (S2 - db) * (S2 - dc)));
        
        if (Area2 > 0.0001) {
            allIndices.push(
              vertexOffset + c,
              vertexOffset + c + 1,
              vertexOffset + rowLen + c + 1
            );
        }
    }
    vertexOffset += rowLen * 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(allVertices, 3));
  geometry.setIndex(allIndices);
  geometry.computeVertexNormals();

  return geometry;
}
