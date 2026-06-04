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
        case 'Digit1':
            setProjectileType('white');
            e.preventDefault();
            console.log('Projectile type: white');
            break;

        case 'Digit2':
            setProjectileType('red');
            e.preventDefault();
            console.log('Projectile type: red');
            break;

        case 'Digit3':
            setProjectileType('blue');
            e.preventDefault();
            console.log('Projectile type: blue');
            break;

        case 'Digit4':
            setProjectileType('green');
            e.preventDefault();
            console.log('Projectile type: green');
            break;

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
    if (e.button !== 0) return;

    if (document.pointerLockElement !== inputCanvas) {
        inputCanvas.requestPointerLock();
        return;
    }

    const { eye, fwd } = getCameraBasis();

    const spawn = [
        eye[0] + fwd[0] * 0.6,
        eye[1] + fwd[1] * 0.6,
        eye[2] + fwd[2] * 0.6,
    ];

    const throwSpeed = 8.0;

    const vx = fwd[0] * throwSpeed;
    const vy = fwd[1] * throwSpeed + 1.2;
    const vz = fwd[2] * throwSpeed;

    createProjectileModel(
        spawn[0],
        spawn[1],
        spawn[2],
        vx, vy, vz,
        currentProjectileType
    );

    e.preventDefault();
});