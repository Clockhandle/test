import * as THREE from 'three';

// Track which keys are currently pressed
const keys = {
    w: false, a: false, s: false, d: false,
    q: false, e: false, // For moving vertically
    shift: false        // Sprint modifier
};

/**
 * Initializes the keyboard listeners for WASD camera panning.
 */
export function setupCameraMovement() {
    window.addEventListener('keydown', (e) => {
        // Prevent default scrolling for arrow keys
        if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].indexOf(e.code) > -1) {
            e.preventDefault();
        }
        switch(e.key.toLowerCase()) {
            case 'w': case 'arrowup': keys.w = true; break;
            case 'a': case 'arrowleft': keys.a = true; break;
            case 's': case 'arrowdown': keys.s = true; break;
            case 'd': case 'arrowright': keys.d = true; break;
            case 'e': keys.e = true; break; // Up (Elevation)
            case 'q': keys.q = true; break; // Down
            case 'shift': keys.shift = true; break;
        }
    }, { passive: false });

    window.addEventListener('keyup', (e) => {
        switch(e.key.toLowerCase()) {
            case 'w': case 'arrowup': keys.w = false; break;
            case 'a': case 'arrowleft': keys.a = false; break;
            case 's': case 'arrowdown': keys.s = false; break;
            case 'd': case 'arrowright': keys.d = false; break;
            case 'e': keys.e = false; break;
            case 'q': keys.q = false; break;
            case 'shift': keys.shift = false; break;
        }
    });
}

/**
 * Call this every frame in the animation loop to smoothly move the camera.
 * We move BOTH the camera and the OrbitControls target (pivot point) 
 * so you don't get leash-snapped back when you try to rotate after moving.
 * 
 * @param {THREE.Camera} camera 
 * @param {OrbitControls} controls 
 */
export function updateCameraMovement(camera, controls) {
    if (!controls.enabled) return; // Don't move if we are drawing boundaries

    // Speed scales based on how far we are zoomed out, so large scenes traverse quickly
    // holding Shift doubles the speed.
    const speedMultiplier = keys.shift ? 2.5 : 0.8;
    
    // Use the distance to the target as a baseline for the speed scalar
    const distToTarget = camera.position.distanceTo(controls.target);
    const speed = speedMultiplier * Math.max(distToTarget * 0.02, 0.1); 

    // Extract the camera's local axes so WASD feels intuitive to the screen view
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);

    const movement = new THREE.Vector3();

    // W/S moves forward/back relative to where you are looking
    if (keys.w) movement.add(forward);
    if (keys.s) movement.sub(forward);

    // A/D strafes left/right
    if (keys.a) movement.sub(right);
    if (keys.d) movement.add(right);

    // E/Q moves strictly up/down relative to your screen
    if (keys.e) movement.add(up);
    if (keys.q) movement.sub(up);

    // Apply movement
    if (movement.lengthSq() > 0) {
        movement.normalize().multiplyScalar(speed);
        camera.position.add(movement);
        controls.target.add(movement); // Move the pivot point smoothly
    }
}