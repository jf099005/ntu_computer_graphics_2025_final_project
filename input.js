'use strict';
/* global camera, config */

// FPS-style controls:
//   P              – toggle pause
//   WASD           – move camera position
//   Space          – move up
//   Ctrl           – move down
//   Right mouse    – look around

const PITCH_LIMIT = Math.PI * 0.44;
const MOUSE_SENSITIVITY = 0.002;

let lastMouseX = 0;
let lastMouseY = 0;

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

window.addEventListener('mousemove', e => {
    const deltaX = e.clientX - lastMouseX;
    const deltaY = e.clientY - lastMouseY;

    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    // 按住右鍵才轉視角
    if (e.buttons & 2) {
        camera.yaw += deltaX * MOUSE_SENSITIVITY;

        // 滑鼠往上移，通常應該是抬頭，所以這裡用 -=
        camera.pitch -= deltaY * MOUSE_SENSITIVITY;

        camera.pitch = Math.max(
            -PITCH_LIMIT,
            Math.min(PITCH_LIMIT, camera.pitch)
        );

        e.preventDefault();
    }
});

// 避免右鍵選單跳出
window.addEventListener('contextmenu', e => {
    e.preventDefault();
});