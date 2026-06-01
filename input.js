'use strict';

// Keyboard controls:
//   P          – toggle pause
//   ← / →     – orbit camera horizontally (azimuth)
//   ↑ / ↓     – orbit camera vertically (elevation, clamped ±80°)

const CAMERA_SPEED = 0.05; // radians per key event
const PHI_LIMIT    = Math.PI * 0.44; // ~79° – prevents gimbal lock near poles

window.addEventListener('keydown', e => {
    switch (e.code) {
        case 'KeyP':
            config.PAUSED = !config.PAUSED;
            break;
        case 'ArrowLeft':
            camera.theta -= CAMERA_SPEED;
            e.preventDefault();
            break;
        case 'ArrowRight':
            camera.theta += CAMERA_SPEED;
            e.preventDefault();
            break;
        case 'ArrowUp':
            camera.phi = Math.min(camera.phi + CAMERA_SPEED, PHI_LIMIT);
            e.preventDefault();
            break;
        case 'ArrowDown':
            camera.phi = Math.max(camera.phi - CAMERA_SPEED, -PHI_LIMIT);
            e.preventDefault();
            break;
    }
});
