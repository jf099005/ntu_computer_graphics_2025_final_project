'use strict';

const canvas = document.getElementsByTagName('canvas')[0];
resizeCanvas();

// config is defined in config.js (loaded before this file)

const { gl, ext } = getWebGLContext(canvas);

// ── Initialise all functional modules (requires gl to exist) ──────────────────
initBaseShaders();   // shaders.js  – shared baseVertexShader
initDivergence();    // divergence.js
initCurl();          // curl.js
initPressure();      // pressure.js
initAdvection();     // advection.js
initBuoyancy();      // buoyancy.js
initSplat();         // splat.js
initRender();        // render.js

// ── Full-screen quad blit helper ──────────────────────────────────────────────
const blit = (() => {
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);

    // VAO (WebGL 2) so model drawing cannot clobber these attribs
    let blitVAO = null;
    if (gl.createVertexArray) {
        blitVAO = gl.createVertexArray();
        gl.bindVertexArray(blitVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bindVertexArray(null);
    } else {
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);
    }

    return (target, clear = false) => {
        if (blitVAO) gl.bindVertexArray(blitVAO);
        if (target == null) {
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        } else {
            gl.viewport(0, 0, target.width, target.height);
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        }
        if (clear) {
            gl.clearColor(0.0, 0.0, 0.0, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
        if (blitVAO) gl.bindVertexArray(null);
    };
})();

// ── 3D atlas FBO state ────────────────────────────────────────────────────────
let density;       // RGBA – smoke colour + alpha
let velocity3D;    // RGBA – XYZ velocity in RGB
let temperature;   // R    – temperature field
let divergence3D;  // R    – divergence
let curl3D;        // RGBA – vorticity vector field
let pressure3D;    // R    – pressure

let modeldepth3D;  // R    – model depth buffer
let modelcolor3D;  // RGBA – model colour buffer

// ── FPS camera state (initial values from config.js) ─────────────────────────
window.camera = {
    x: config.CAMERA_X ?? 0.0,
    y: config.CAMERA_Y ?? -2.0,
    z: config.CAMERA_Z ?? 14.0,

    yaw: config.CAMERA_YAW ?? 0.0,
    pitch: config.CAMERA_PITCH ?? 0.0,
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
initFramebuffers();
initSmoke();
createSceneGeometry();
loadProjectileTemplate('ball.glb');

updateProjectileHUD();

let lastUpdateTime = Date.now();
update();
