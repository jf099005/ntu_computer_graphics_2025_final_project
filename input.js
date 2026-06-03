'use strict';
/* global camera, config */

// FPS-style controls:
//   P        – toggle pause
//   WASD     – move camera position
//   Space    – move up
//   Ctrl     – move down
//   Mouse    – look around after pointer lock

const PITCH_LIMIT = Math.PI * 0.44;
const MOUSE_SENSITIVITY = 0.002;

const inputCanvas = document.getElementsByTagName('canvas')[0];

function getHorizontalMoveBasis() {
    const yaw = camera.yaw;

    // yaw = 0 時，看向 -Z
    const forward = [
        -Math.sin(yaw),
        0,
        -Math.cos(yaw),
    ];

    const right = [
        Math.cos(yaw),
        0,
        -Math.sin(yaw),
    ];

    return { forward, right };
}

window.addEventListener('keydown', e => {
    switch (e.code) {
        case 'KeyP':
            config.PAUSED = !config.PAUSED;
            break;

        case 'KeyW':
        case 'KeyS':
        case 'KeyA':
        case 'KeyD':
        case 'Space':
        case 'ControlLeft':
        case 'ControlRight': {
            const { forward, right } = getHorizontalMoveBasis();
            const speed = config.CAMERA_MOVE_SPEED;

            if (e.code === 'KeyW') {
                camera.x += forward[0] * speed;
                camera.z += forward[2] * speed;
            }

            if (e.code === 'KeyS') {
                camera.x -= forward[0] * speed;
                camera.z -= forward[2] * speed;
            }

            if (e.code === 'KeyA') {
                camera.x -= right[0] * speed;
                camera.z -= right[2] * speed;
            }

            if (e.code === 'KeyD') {
                camera.x += right[0] * speed;
                camera.z += right[2] * speed;
            }

            if (e.code === 'Space') {
                camera.y += speed;
            }

            if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
                camera.y -= speed;
            }

            e.preventDefault();
            break;
        }
    }
});

inputCanvas.addEventListener('click', () => {
    inputCanvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
    console.log('pointer lock:', document.pointerLockElement === inputCanvas);
});

window.addEventListener('mousemove', e => {
    if (document.pointerLockElement !== inputCanvas) return;

    camera.yaw -= e.movementX * MOUSE_SENSITIVITY;
    camera.pitch -= e.movementY * MOUSE_SENSITIVITY;

    camera.pitch = Math.max(
        -PITCH_LIMIT,
        Math.min(PITCH_LIMIT, camera.pitch)
    );
});