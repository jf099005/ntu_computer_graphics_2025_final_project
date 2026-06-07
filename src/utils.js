'use strict';

// 3D volume atlas constants
// The 64³ grid is stored as a 512×512 2D texture atlas (8×8 tiles of 64×64 slices)
const VOLUME_SIZE = 64;
const SLICES_PER_ROW = 8;
const ATLAS_SIZE = VOLUME_SIZE * SLICES_PER_ROW; // 512

function normalizeColor (input) {
    return {
        r: input.r / 255,
        g: input.g / 255,
        b: input.b / 255
    };
}

function scaleByPixelRatio (input) {
    let pixelRatio = window.devicePixelRatio || 1;
    return Math.floor(input * pixelRatio);
}

function hashCode (s) {
    if (s.length == 0) return 0;
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
        hash = (hash << 5) - hash + s.charCodeAt(i);
        hash |= 0;
    }
    return hash;
}

// ── Camera matrix utilities ───────────────────────────────────────────────────
// All matrices are column-major Float32Array (WebGL convention).

function mat4Perspective (fovy, aspect, near, far) {
    const f  = 1.0 / Math.tan(fovy / 2);
    const nf = 1.0 / (near - far);
    return new Float32Array([
        f / aspect, 0, 0,  0,
        0,          f, 0,  0,
        0,          0, (far + near) * nf, -1,
        0,          0, 2 * far * near * nf, 0
    ]);
}

function mat4LookAt (eye, center, up) {
    let fx = center[0]-eye[0], fy = center[1]-eye[1], fz = center[2]-eye[2];
    let fl = Math.sqrt(fx*fx + fy*fy + fz*fz);
    fx/=fl; fy/=fl; fz/=fl;

    let sx = fy*up[2] - fz*up[1];
    let sy = fz*up[0] - fx*up[2];
    let sz = fx*up[1] - fy*up[0];
    let sl = Math.sqrt(sx*sx + sy*sy + sz*sz);
    sx/=sl; sy/=sl; sz/=sl;

    let ux = sy*fz - sz*fy;
    let uy = sz*fx - sx*fz;
    let uz = sx*fy - sy*fx;

    return new Float32Array([
        sx, ux, -fx, 0,   // col 0: [right.x, up.x, -fwd.x, 0]
        sy, uy, -fy, 0,   // col 1: [right.y, up.y, -fwd.y, 0]
        sz, uz, -fz, 0,   // col 2: [right.z, up.z, -fwd.z, 0]
        -(sx*eye[0]+sy*eye[1]+sz*eye[2]),
        -(ux*eye[0]+uy*eye[1]+uz*eye[2]),
        (fx*eye[0]+fy*eye[1]+fz*eye[2]),
        1
    ]);
}

function mat4Multiply (a, b) {
    let out = new Float32Array(16);
    for (let col = 0; col < 4; col++)
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++)
                sum += a[k*4 + row] * b[col*4 + k];
            out[col*4 + row] = sum;
        }
    return out;
}