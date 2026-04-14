import * as THREE from 'three';

/**
 * A fast, lightweight "Zippering" algorithm to stitch two 3D polylines into a unified mesh.
 * This is incredibly efficient for topological layers where you just want to connect the Z-levels.
 */
function stitchLines(line1, line2) {
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


const v1 = [new THREE.Vector3(0,0,0), new THREE.Vector3(1,0,0)];
const v2 = [new THREE.Vector3(0,0,1), new THREE.Vector3(1,0,1)];
console.log(stitchLines(v1, v2));