'use strict';

// Keyboard controls:
//   P          – toggle pause
//   WASD       – translate camera (based on current horizontal view direction)
//   ← / →     – orbit camera horizontally (azimuth)
//   ↑ / ↓     – orbit camera vertically (elevation, clamped ±80°)

const CAMERA_SPEED = 0.05; // radians per key event
const MOVE_SPEED   = 0.05; // world units per key event
const PHI_LIMIT    = Math.PI * 0.44; // ~79° – prevents gimbal lock near poles

window.addEventListener('keydown', e => {
    switch (e.code) {
        case 'KeyP':
            config.PAUSED = !config.PAUSED;
            break;

        // WASD: translate orbit center in horizontal plane aligned with current azimuth
        case 'KeyW':
        case 'KeyS':
        case 'KeyA':
        case 'KeyD': {
            const th = camera.theta;
            // horizontal forward: direction camera looks at projected on XZ plane
            const fhx = -Math.sin(th), fhz = -Math.cos(th);
            // horizontal right: perpendicular to forward, in XZ plane
            const rhx =  Math.cos(th), rhz = -Math.sin(th);

            if (e.code === 'KeyW') { camera.cx += fhx * MOVE_SPEED; camera.cz += fhz * MOVE_SPEED; }
            if (e.code === 'KeyS') { camera.cx -= fhx * MOVE_SPEED; camera.cz -= fhz * MOVE_SPEED; }
            if (e.code === 'KeyA') { camera.cx -= rhx * MOVE_SPEED; camera.cz -= rhz * MOVE_SPEED; }
            if (e.code === 'KeyD') { camera.cx += rhx * MOVE_SPEED; camera.cz += rhz * MOVE_SPEED; }
            e.preventDefault();
            break;
        }

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
