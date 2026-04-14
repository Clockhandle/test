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
  const distStartToStart = line1[0].distanceTo(line2[0]);
  const distStartToEnd = line1[0].distanceTo(line2[line2.length - 1]);
  const workingLine2 = (distStartToEnd < distStartToStart) ? [...line2].reverse() : line2;

  // 2. Map cumulative lengths to parameterize the curves from t=0.0 to t=1.0
  function getLengths(line) {
    let total = 0;
    const lengths = [0];
    for (let i = 1; i < line.length; i++) {
        total += line[i - 1].distanceTo(line[i]);
        lengths.push(total);
    }
    const max = total > 0 ? total : 1;
    const normalized = lengths.map(l => l / max);
    return { total, normalized };
  }

  const l1Data = getLengths(line1);
  const l2Data = getLengths(workingLine2);

  // Helper to trace the lines based on % completion (t)
  function getPointAtT(line, normalizedLengths, t) {
    if (t <= 0) return line[0].clone();
    if (t >= 1) return line[line.length - 1].clone();
    
    for (let i = 0; i < normalizedLengths.length - 1; i++) {
        if (t >= normalizedLengths[i] && t <= normalizedLengths[i + 1]) {
            const segmentStart = normalizedLengths[i];
            const segmentEnd = normalizedLengths[i + 1];
            const localT = (t - segmentStart) / (segmentEnd - segmentStart);
            return new THREE.Vector3().lerpVectors(line[i], line[i + 1], localT);
        }
    }
    return line[line.length - 1].clone();
  }

  // 3. Determine Grid Resolution
  const maxLineLen = Math.max(l1Data.total, l2Data.total);
  const uSteps = Math.max(2, Math.ceil(maxLineLen / maxEdgeLength)); // Horizontal Segments

  const startDist = line1[0].distanceTo(workingLine2[0]);
  const endDist = line1[line1.length - 1].distanceTo(workingLine2[workingLine2.length - 1]);
  const maxVDist = Math.max(startDist, endDist);
  const vSteps = Math.max(1, Math.ceil(maxVDist / maxEdgeLength)); // Vertical Segments (Z-Layers)

  // 4. Generate the perfectly spaced vertices grid!
  const grid = [];
  for (let v = 0; v <= vSteps; v++) {
    const vT = v / vSteps;
    const currentLine = [];
    for (let u = 0; u <= uSteps; u++) {
        const uT = u / uSteps;
        const p1 = getPointAtT(line1, l1Data.normalized, uT);
        const p2 = getPointAtT(workingLine2, l2Data.normalized, uT);
        // Lerp between top line and bottom line to create "middle points"
        currentLine.push(new THREE.Vector3().lerpVectors(p1, p2, vT));
    }
    grid.push(currentLine);
  }

  // 5. Connect the grid dots into Triangles
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
        // Triangle 1
        allIndices.push(
          vertexOffset + c,
          vertexOffset + rowLen + c + 1,
          vertexOffset + rowLen + c
        );
        // Triangle 2
        allIndices.push(
          vertexOffset + c,
          vertexOffset + c + 1,
          vertexOffset + rowLen + c + 1
        );
    }
    vertexOffset += rowLen * 2;
  }

  // 6. Bake the structured uniform geometry
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(allVertices, 3));
  geometry.setIndex(allIndices);
  geometry.computeVertexNormals();

  return geometry;
}
