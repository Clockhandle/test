import * as THREE from 'three';

let axisScene;
let axisCamera;
// Define the size of the corner widget in pixels
const WIDGET_SIZE = 150;

/**
 * Creates a 2D text sprite to label axes without needing external 3D fonts.
 */
function createTextSprite(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    
    // Draw text
    context.font = 'Bold 40px Arial';
    context.fillStyle = color;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 32, 32);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.8, 0.8, 0.8); // Adjust this to make text bigger/smaller
    return sprite;
}

/**
 * Sets up a completely separate scene and camera for the axis helper 
 * so it can be drawn over the main scene in the bottom right corner.
 */
export function setupAxisHelper() {
    axisScene = new THREE.Scene();

    // Add some ambient light if you ever want to add 3D objects instead of just lines
    const ambientLight = new THREE.AmbientLight(0xffffff, 1);
    axisScene.add(ambientLight);

    // Create the AxesHelper
    const axesLength = 2;
    const axesHelper = new THREE.AxesHelper(axesLength); // Local size
    axisScene.add(axesHelper);

    // Add text labels exactly at the tips of the X, Y, and Z lines
    const spriteX = createTextSprite('X', '#ff0000'); // Red for X
    spriteX.position.set(axesLength + 0.3, 0, 0);
    axisScene.add(spriteX);

    const spriteY = createTextSprite('Y', '#00ff00'); // Green for Y
    spriteY.position.set(0, axesLength + 0.3, 0);
    axisScene.add(spriteY);

    const spriteZ = createTextSprite('Z', '#0044ff'); // Blue for Z (slight contrast so it's readable)
    spriteZ.position.set(0, 0, axesLength + 0.3);
    axisScene.add(spriteZ);

    // Setup a dedicated camera for the axis widget
    axisCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
    axisCamera.position.set(0, 0, 4); // Sit back a bit

    return { axisScene, axisCamera };
}

/**
 * Handles syncing the rotation from the main camera and rendering the 
 * axis scene as an overlay in the bottom right corner.
 * 
 * @param {THREE.WebGLRenderer} renderer - The active WebGLRenderer.
 * @param {THREE.Camera} mainCamera - The main scene's camera to sync rotation from.
 */
export function renderAxisHelper(renderer, mainCamera) {
    if (!axisScene || !axisCamera) return;

    // 1. Sync the rotation of the helper camera to the main camera
    // We do this by pointing the helper camera at the origin, from a direction
    // that matches the main camera's rotation relative to its origin.
    axisCamera.position.copy(mainCamera.position);
    axisCamera.position.sub(mainCamera.quaternion > 0 ? new THREE.Vector3() : new THREE.Vector3()); // Just to show intent
    axisCamera.position.set(0, 0, 5); // Keep fixed distance
    axisCamera.position.applyQuaternion(mainCamera.quaternion);
    axisCamera.lookAt(axisScene.position);

    // 2. Temporarily adjust renderer to draw the overlay
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Clear depth so the axes draw *over* the 3D scene, not inside it
    renderer.clearDepth();

    // Set viewport to the bottom-right corner
    // params: x, y (from bottom-left), width, height
    renderer.setViewport(width - WIDGET_SIZE, 0, WIDGET_SIZE, WIDGET_SIZE);
    
    // Render the helper scene
    renderer.render(axisScene, axisCamera);

    // Restore the viewport to full screen so the next frame draws properly
    renderer.setViewport(0, 0, width, height);
}

