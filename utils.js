'use strict';

// 3D volume atlas constants
// The 64³ grid is stored as a 512×512 2D texture atlas (8×8 tiles of 64×64 slices)
const VOLUME_SIZE = 64;
const SLICES_PER_ROW = 8;
const ATLAS_SIZE = VOLUME_SIZE * SLICES_PER_ROW; // 512

function isMobile () {
    return /Mobi|Android/i.test(navigator.userAgent);
}

function clamp01 (input) {
    return Math.min(Math.max(input, 0), 1);
}

function downloadURI (filename, uri) {
    let link = document.createElement('a');
    link.download = filename;
    link.href = uri;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function generateColor () {
    let c = HSVtoRGB(Math.random(), 1.0, 1.0);
    c.r *= 0.15;
    c.g *= 0.15;
    c.b *= 0.15;
    return c;
}

function HSVtoRGB (h, s, v) {
    let r, g, b, i, f, p, q, t;
    i = Math.floor(h * 6);
    f = h * 6 - i;
    p = v * (1 - s);
    q = v * (1 - f * s);
    t = v * (1 - (1 - f) * s);

    switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }

    return { r, g, b };
}

function normalizeColor (input) {
    return {
        r: input.r / 255,
        g: input.g / 255,
        b: input.b / 255
    };
}

function wrap (value, min, max) {
    let range = max - min;
    if (range == 0) return min;
    return (value - min) % range + min;
}

function getResolution (resolution) {
    let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspectRatio < 1)
        aspectRatio = 1.0 / aspectRatio;

    let min = Math.round(resolution);
    let max = Math.round(resolution * aspectRatio);

    if (gl.drawingBufferWidth > gl.drawingBufferHeight)
        return { width: max, height: min };
    else
        return { width: min, height: max };
}

function getTextureScale (texture, width, height) {
    return {
        x: width / texture.width,
        y: height / texture.height
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

    // Column-major: [right | up | -forward | translation]
    return new Float32Array([
        sx, sy, sz, 0,
        ux, uy, uz, 0,
        -fx, -fy, -fz, 0,
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

// Build perspective * view matrix for an orbit camera.
// theta = azimuth (radians), phi = elevation (radians), radius = distance.
function getCameraViewProjection (theta, phi, radius, aspect) {
    const eye = [
        radius * Math.sin(theta) * Math.cos(phi),
        radius * Math.sin(phi),
        radius * Math.cos(theta) * Math.cos(phi)
    ];
    const view = mat4LookAt(eye, [0, 0, 0], [0, 1, 0]);
    const proj = mat4Perspective(Math.PI / 3.0, aspect, 0.1, 10.0);
    return mat4Multiply(proj, view);
}

//depth calculation 
