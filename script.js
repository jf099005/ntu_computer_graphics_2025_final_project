'use strict';

const canvas = document.getElementsByTagName('canvas')[0];
resizeCanvas();

let config = {
    // Smoke dissipation (decay rate per second)
    DENSITY_DISSIPATION:     0.3,
    VELOCITY_DISSIPATION:    0.2,
    TEMPERATURE_DISSIPATION: 1.0,
    // Fluid solver
    PRESSURE:            0.8,
    PRESSURE_ITERATIONS: 25,
    CURL:                30,
    // Smoke behaviour
    BUOYANCY:     0.5,
    SMOKE_WEIGHT: 0.05,
    // Seed splat radius (used by initSmoke, not exposed in GUI)
    SPLAT_RADIUS: 0.25,
    // Ray march rendering
    DENSITY_SCALE: 0.7,
    ABSORPTION:    15.0,
    // Display
    PAUSED:     false,
    BACK_COLOR: { r: 8, g: 15, b: 40 },
    TRANSPARENT: false,
};

const { gl, ext } = getWebGLContext(canvas);

startGUI();

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

// ── Orbit camera ──────────────────────────────────────────────────────────────
const camera = {
    theta:  0.0,
    phi:    0.3,
    radius: 2.0,
    cx: 0.0,
    cy: 0.0,
    cz: 0.0,
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
initFramebuffers();
initSmoke();
createFloor();

loadGLBModel('f-16.glb', 0, 0, -0.5);

let lastUpdateTime = Date.now();
update();
