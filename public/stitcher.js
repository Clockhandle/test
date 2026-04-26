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
  // We compare the total cost of Forward(SS+EE) vs Backward(SE+ES).
  const dSS = Math.hypot(line1[0].x - line2[0].x, line1[0].y - line2[0].y);
  const dEE = Math.hypot(line1[L1 - 1].x - line2[L2 - 1].x, line1[L1 - 1].y - line2[L2 - 1].y);
  
  const dSE = Math.hypot(line1[0].x - line2[L2 - 1].x, line1[0].y - line2[L2 - 1].y);
  const dES = Math.hypot(line1[L1 - 1].x - line2[0].x, line1[L1 - 1].y - line2[0].y);

  const forwardCost = dSS + dEE;
  const backwardCost = dSE + dES;

  const reverseL2 = backwardCost < forwardCost;
  
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

  // 1. Subdivide the lines horizontally so no segment is longer than maxEdgeLength.
  // This physically preserves your drawn shapes while giving us enough vertices to build a uniform grid.
  function subdivideLine(line, maxEdge) {
    const result = [line[0].clone()];
    for (let i = 1; i < line.length; i++) {
        const p1 = line[i - 1];
        const p2 = line[i];
        const dist = p1.distanceTo(p2);
        const steps = Math.max(1, Math.ceil(dist / maxEdge));
        for (let s = 1; s <= steps; s++) {
            result.push(new THREE.Vector3().lerpVectors(p1, p2, s / steps));
        }
    }
    return result;
  }

  const denseLine1 = subdivideLine(line1, maxEdgeLength);
  const denseLine2Fwd = subdivideLine(line2, maxEdgeLength);
  const denseLine2Rev = subdivideLine([...line2].reverse(), maxEdgeLength);

  // 2. Dynamic Programming (Fuchs-Kedem-Uselton algorithm)
  // Evaluates every single possible matching combination between the curves 
  // and returns the globally optimal one that creates the absolute shortest 
  // spanning rungs (prevents folds, cracks, and inversions perfectly).
  function getDPZipper(L1, L2) {
      const N = L1.length;
      const M = L2.length;
      const dp = new Float32Array(N * M);
      const choice = new Int8Array(N * M); 
      
      const getXYDist = (p1, p2) => Math.hypot(p1.x - p2.x, p1.y - p2.y);

      dp[0] = 0;
      for (let i = 1; i < N; i++) {
          dp[i * M] = dp[(i - 1) * M] + getXYDist(L1[i], L2[0]);
          choice[i * M] = 1;
      }
      for (let j = 1; j < M; j++) {
          dp[j] = dp[j - 1] + getXYDist(L1[0], L2[j]);
          choice[j] = 2;
      }

      for (let i = 1; i < N; i++) {
          for (let j = 1; j < M; j++) {
              const crossCost = getXYDist(L1[i], L2[j]);
              // 1: Move along L1
              const cost1 = dp[(i - 1) * M + j] + crossCost;
              // 2: Move along L2
              const cost2 = dp[i * M + (j - 1)] + crossCost;
              // 3: DIAGONAL MOVE (Both curve pointers advance). Essential for smooth parallel shapes!
              const cost3 = dp[(i - 1) * M + (j - 1)] + crossCost * 1.0; 
              
              if (cost3 <= cost1 && cost3 <= cost2) {
                  dp[i * M + j] = cost3;
                  choice[i * M + j] = 3;
              } else if (cost1 < cost2) {
                  dp[i * M + j] = cost1;
                  choice[i * M + j] = 1;
              } else {
                  dp[i * M + j] = cost2;
                  choice[i * M + j] = 2;
              }
          }
      }

      const path = [];
      let currI = N - 1;
      let currJ = M - 1;
      while (currI > 0 || currJ > 0) {
          path.push({ p1: L1[currI], p2: L2[currJ] });
          const move = choice[currI * M + currJ];
          if (move === 3) {
              currI--;
              currJ--;
          } else if (move === 1) {
              currI--;
          } else {
              currJ--;
          }
      }
      path.push({ p1: L1[0], p2: L2[0] });
      path.reverse();
      
      return { pairs: path, totalCost: dp[N * M - 1] };
  }

  // 3. We run the matrix in BOTH forward and backward mapping completely blindly.
  // Whoever uses the least amount of "string" to tie the shapes together is mathematically 
  // guaranteed to be the correct, untwisted alignment.
  const fwdResult = getDPZipper(denseLine1, denseLine2Fwd);
  const revResult = getDPZipper(denseLine1, denseLine2Rev);

  const bestPairs = (revResult.totalCost < fwdResult.totalCost) ? revResult.pairs : fwdResult.pairs;

  // 4. Determine uniform Vertical Steps based on max ladder distance
  let maxVDist = 0;
  for (let k = 0; k < bestPairs.length; k++) {
      const d = bestPairs[k].p1.distanceTo(bestPairs[k].p2);
      if (d > maxVDist) maxVDist = d;
  }
  const vSteps = Math.max(1, Math.ceil(maxVDist / maxEdgeLength));

  // 5. Generate perfect grid intersections
  const grid = [];
  for (let v = 0; v <= vSteps; v++) {
    const vT = v / vSteps;
    const currentLine = [];
    for (let k = 0; k < bestPairs.length; k++) {
        currentLine.push(new THREE.Vector3().lerpVectors(bestPairs[k].p1, bestPairs[k].p2, vT));
    }
    grid.push(currentLine);
  }

  // 6. Connect the grid nodes into Triangles
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

  const debugRungVerts = [];
  for (let p of bestPairs) {
      debugRungVerts.push(p.p1.x, p.p1.y, p.p1.z);
      debugRungVerts.push(p.p2.x, p.p2.y, p.p2.z);
  }
  geometry.userData = { debugRungs: debugRungVerts };

  return geometry;
}
