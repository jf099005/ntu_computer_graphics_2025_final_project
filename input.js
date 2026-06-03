'use strict';

// FPS-style controls:
//   P          – toggle pause
//   WASD       – move camera position (based on current view direction)
//   Mouse      – look around (adjust view angle)

// speeds from config.js
const PHI_LIMIT = Math.PI * 0.44; // ~79° – prevents gimbal lock near poles

// Mouse sensitivity for FPS-style look
const MOUSE_SENSITIVITY = 0.002;
let lastMouseX = 0;
let lastMouseY = 0;

window.addEventListener('keydown', e => {
    switch (e.code) {
        case 'KeyP':
            config.PAUSED = !config.PAUSED;
            break;

        // WASD: move camera position in horizontal plane aligned with current view direction
        case 'KeyW':
        case 'KeyS':
        case 'KeyA':
        case 'KeyD': {
            const th = camera.theta;
            // horizontal forward: direction camera looks at projected on XZ plane
            const fhx = -Math.sin(th), fhz = -Math.cos(th);
            // horizontal right: perpendicular to forward, in XZ plane
            const rhx =  Math.cos(th), rhz = -Math.sin(th);

            if (e.code === 'KeyW') { camera.cx += fhx * config.CAMERA_MOVE_SPEED; camera.cz += fhz * config.CAMERA_MOVE_SPEED; }
            if (e.code === 'KeyS') { camera.cx -= fhx * config.CAMERA_MOVE_SPEED; camera.cz -= fhz * config.CAMERA_MOVE_SPEED; }
            if (e.code === 'KeyA') { camera.cx -= rhx * config.CAMERA_MOVE_SPEED; camera.cz -= rhz * config.CAMERA_MOVE_SPEED; }
            if (e.code === 'KeyD') { camera.cx += rhx * config.CAMERA_MOVE_SPEED; camera.cz += rhz * config.CAMERA_MOVE_SPEED; }
            e.preventDefault();
            break;
        }
    }
});

// Mouse movement for FPS-style camera control (right button only)
window.addEventListener('mousemove', e => {
    const deltaX = e.clientX - lastMouseX;
    const deltaY = e.clientY - lastMouseY;

    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    // Only adjust view when right mouse button is pressed
    if (e.buttons & 2) {
        // Update horizontal angle (theta) based on horizontal mouse movement
        camera.theta += deltaX * MOUSE_SENSITIVITY;

        // Update vertical angle (phi) based on vertical mouse movement, clamped to prevent flipping
        camera.phi = Math.max(-PHI_LIMIT, Math.min(PHI_LIMIT, camera.phi + deltaY * MOUSE_SENSITIVITY));
    }
});
