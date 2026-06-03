'use strict';
/* global camera, config */

// FPS-style controls:
//   P        – toggle pause
//   WASD     – move camera position
//   Shift    – move up
//   Ctrl     – move down
//   Space    – toggle depth visualization
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

        case 'Space':
            config.SHOW_DEPTH_VIZ = !config.SHOW_DEPTH_VIZ;
            e.preventDefault();
            break;

        case 'KeyW':
        case 'KeyS':
        case 'KeyA':
        case 'KeyD':
        case 'ShiftLeft':
        case 'ShiftRight':
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

            if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
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

window.addEventListener('mousedown', e => {
    // 左鍵
    if (e.button !== 0) return;

    // 如果還沒鎖定滑鼠，第一次左鍵只拿來鎖定
    if (document.pointerLockElement !== inputCanvas) {
        inputCanvas.requestPointerLock();
        return;
    }

    const { eye, fwd } = getCameraBasis();

    const throwSpeed = 8.0;

    // 從相機前方一點點的位置生成，避免出生在相機裡面
    const spawnX = eye[0] + fwd[0] * 0.6;
    const spawnY = eye[1] + fwd[1] * 0.6;
    const spawnZ = eye[2] + fwd[2] * 0.6;

    const vx = fwd[0] * throwSpeed;
    const vy = fwd[1] * throwSpeed + 1.2;
    const vz = fwd[2] * throwSpeed;

    createProjectileBox(spawnX, spawnY, spawnZ, vx, vy, vz);

    e.preventDefault();
});