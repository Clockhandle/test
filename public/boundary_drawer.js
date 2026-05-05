import * as THREE from 'three';

let isDrawing = false;
let boundaryLine = null;
let snapSphere = null;
let tempLine = null; 
let isDragging = false;
let dragStartPoint = null;
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); 
const drawnPoints = [];
const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 10;
const mouse = new THREE.Vector2();

export function getDrawnPoints() {
    return drawnPoints;
}

export function clearBoundaries() {
    drawnPoints.length = 0;
    if (boundaryLine && boundaryLine.geometry) {
        boundaryLine.geometry.dispose();
        boundaryLine.geometry = new THREE.BufferGeometry();
    }
}

export function setupBoundaryDrawer(scene, camera, controls, meshGroup) {
  const drawBtn = document.getElementById('draw-boundary-btn');
  if (!drawBtn) return;

  drawBtn.addEventListener('click', () => {
      isDrawing = !isDrawing;
      controls.enabled = !isDrawing; // Turn off orbit controls so you can click freely
      drawBtn.innerText = isDrawing ? 'Draw Boundary (On)' : 'Draw Boundary (Off)';
      drawBtn.style.background = isDrawing ? 'red' : '';
      drawBtn.style.color = isDrawing ? 'white' : '';

      if (isDrawing && !boundaryLine) {
        // Create an empty, thick red line for our boundary drawing (Use LineSegments so we can draw disconnected lines!)
        const mat = new THREE.LineBasicMaterial({ color: 0xff0000 });
        const geom = new THREE.BufferGeometry();
        boundaryLine = new THREE.LineSegments(geom, mat);
        scene.add(boundaryLine);

        // Dashed temporary line for the "drag phase"
        const dashedMat = new THREE.LineDashedMaterial({ color: 0xffa500, dashSize: 1, gapSize: 1 }); // Orange dashed
        const dashedGeom = new THREE.BufferGeometry();
        tempLine = new THREE.Line(dashedGeom, dashedMat);
        tempLine.visible = false;
        scene.add(tempLine);

        // Also create a yellow snapping sphere
        const sphereGeom = new THREE.SphereGeometry(1, 16, 16);
        const sphereMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });     
        snapSphere = new THREE.Mesh(sphereGeom, sphereMat);
        snapSphere.visible = false;
        scene.add(snapSphere);
      }
  });

  // Handle mouse movement for snapping and tooltip
  window.addEventListener('pointermove', (event) => {
      const tooltip = document.getElementById('hover-tooltip');

      mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);

      // Make the threshold dynamic based on how far zoomed out the camera is!  
      // This makes it MUCH easier to hover over thin lines.
      raycaster.params.Line.threshold = camera.position.z * 0.01;

      const intersects = raycaster.intersectObject(meshGroup, true);

      if (intersects.length > 0) {
        const intersect = intersects[0];
        let targetPoint = intersect.point;
        
        const layerIndex = meshGroup.children.indexOf(intersect.object);

        // Update Tooltip
        if (tooltip) {
          tooltip.style.display = 'block';
          tooltip.style.left = event.clientX + 15 + 'px';
          tooltip.style.top = event.clientY + 15 + 'px';
          
          // Get original actual z-value instead of interpolated raycast point if possible
          let zValue = targetPoint.z;
          if (intersect.object.type === 'Line') {
             const positions = intersect.object.geometry.attributes.position;
             if (positions.count > 0) {
                const z0 = positions.getZ(0); 
                zValue = z0; // Since all points in a layer usually share Z
             }
          }
          
          tooltip.innerHTML = `<strong>Layer:</strong> ${layerIndex}<br/><strong>Z-Elevation:</strong> ${zValue.toFixed(3)}`;
        }

        if (!isDrawing || !snapSphere) return; // Only process snapping if drawing is active

        // "Snap" to the absolute closest mathematical vertex rather than just anywhere on the line
        if (intersect.object.type === 'Line' && intersect.index !== undefined) {
          const positions = intersect.object.geometry.attributes.position;      

          // The raycaster gives us an index into the geometry's buffer array   
          const p1 = new THREE.Vector3().fromBufferAttribute(positions, intersect.index);
          const p2 = new THREE.Vector3().fromBufferAttribute(positions, intersect.index + 1);

          // Convert the local coordinates to world space
          p1.applyMatrix4(intersect.object.matrixWorld);
          p2.applyMatrix4(intersect.object.matrixWorld);

          // Which of the two vertices on the line segment is closer to our mouse ray?
          const isP1 = p1.distanceTo(intersect.point) < p2.distanceTo(intersect.point);
          targetPoint = isP1 ? p1 : p2;
          
          // PERFECT TOPOLOGY FIX: Store exactly which layer and vertex index we snapped to
          snapSphere.userData = {
             layerIndex: layerIndex,
             vertexIndex: isP1 ? intersect.index : intersect.index + 1
          };
        }

        snapSphere.position.copy(targetPoint);
        // Scale the sphere relative to camera distance so it never looks too big or too small
        const scale = camera.position.z * 0.005;
        snapSphere.scale.set(scale, scale, scale);
        snapSphere.visible = true;

      } else {
        if (tooltip) tooltip.style.display = 'none';
        if (snapSphere) snapSphere.visible = false;
      }

      // If we are holding click & dragging, update the dashed line
      if (isDragging && dragStartPoint && tempLine) {
        let dragEndPoint = new THREE.Vector3();

        if (snapSphere && snapSphere.visible) {
          // Snap end point to our target point perfectly
          dragEndPoint.copy(snapSphere.position);
        } else {
          // If we drag into empty space, draw a trace on the same depth layer as our start point
          raycaster.ray.intersectPlane(dragPlane, dragEndPoint);
        }

        if (dragEndPoint) {
           tempLine.geometry.setFromPoints([dragStartPoint, dragEndPoint]);     

           // Make dashed scaling somewhat dynamic based on how far our camera is zoomed
           const curScale = Math.max(camera.position.z * 0.005, 0.1);
           tempLine.material.dashSize = curScale;
           tempLine.material.gapSize = curScale;
           tempLine.computeLineDistances(); // REQUIRED for Dashed material to loop properly
        }
      }
  });

  // Handle mouse down (START Dragging)
  window.addEventListener('pointerdown', (event) => {
      if (!isDrawing) return;

      // Don't draw if the user is just clicking the UI menu
      if (event.target.tagName === 'INPUT' || event.target.tagName === 'BUTTON') return;

      // If our yellow sphere is visible, start an active drag constraint!      
      if (snapSphere && snapSphere.visible) {

        isDragging = true;
        dragStartPoint = snapSphere.position.clone();
        
        // Preserve the topological data of the click!
        dragStartPoint.layerIndex = snapSphere.userData.layerIndex;
        dragStartPoint.vertexIndex = snapSphere.userData.vertexIndex;

        // Define a mathematical 3D invisible plane at the depth of the starting click.
        dragPlane.set(new THREE.Vector3(0, 0, 1), -dragStartPoint.z);

        tempLine.geometry.setFromPoints([dragStartPoint, dragStartPoint]);      
        tempLine.visible = true;
      }
  });

  // Handle mouse up (END Dragging)
  window.addEventListener('pointerup', (event) => {
      if (!isDrawing || !isDragging) return;

      isDragging = false;
      if (tempLine) tempLine.visible = false; // Hide the orange dashed phantom line

      // Are we currently releasing over a valid snapping position?
      if (snapSphere && snapSphere.visible && dragStartPoint) {
        const dragEndPoint = snapSphere.position.clone();
        dragEndPoint.layerIndex = snapSphere.userData.layerIndex;
        dragEndPoint.vertexIndex = snapSphere.userData.vertexIndex;

        // Make sure we didn't just click and release on the exact same vertex (0 length edge)
        if (dragStartPoint.distanceTo(dragEndPoint) > 0.001) {
          // Store line segment to our primary drawer
          drawnPoints.push(dragStartPoint);
          drawnPoints.push(dragEndPoint);

          // Re-generate the geometry (Three.js locks buffer sizes, so we must recreate it to add more points)
          boundaryLine.geometry.dispose();
          boundaryLine.geometry = new THREE.BufferGeometry().setFromPoints(drawnPoints);

          console.log("Segment Registered:", dragStartPoint.layerIndex, `[${dragStartPoint.vertexIndex}]`, "to", dragEndPoint.layerIndex, `[${dragEndPoint.vertexIndex}]`);
        }
      }

      dragStartPoint = null;
  });
}
