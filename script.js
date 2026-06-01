'use strict';

const canvas = document.getElementsByTagName('canvas')[0];
resizeCanvas();

let config = {
    // Smoke dissipation (decay rate per second)
    DENSITY_DISSIPATION: 0.3,
    VELOCITY_DISSIPATION: 0.2,
    TEMPERATURE_DISSIPATION: 1.0,
    // Fluid solver
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 25,
    CURL: 30,
    // Smoke behaviour
    BUOYANCY: 1.5,
    SMOKE_WEIGHT: 0.05,    // downward drag per unit density (counters buoyancy)
    // Seed splat radius (used by initSmoke, not exposed in GUI)
    SPLAT_RADIUS: 0.25,
    // Ray march rendering
    DENSITY_SCALE: 0.7,    // density multiplier during ray marching
    ABSORPTION: 15.0,      // opacity per unit distance
    // Display
    PAUSED: false,
    BACK_COLOR: { r: 255, g: 255, b: 255 },
    TRANSPARENT: false,
};

const { gl, ext } = getWebGLContext(canvas);

// (Bloom / sunrays removed — rendering uses ray marching)

startGUI();

// Compiled shaders
const {
    baseVertexShader,
    clearShader,
    colorShader,
    displayShaderSource,
    displayVertexShader,
    atlasHelperGLSL,
    // 3D shaders
    advection3DShader,
    divergence3DShader,
    pressure3DShader,
    gradientSubtract3DShader,
    curl3DShader,
    vorticity3DShader,
    splat3DShader,
    buoyancyShader,
    rayMarchShader,
} = initShaders(gl, ext);

const blit = (() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    return (target, clear = false) => {
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
    };
})();

// ── 3D atlas FBO state ────────────────────────────────────────────────────────
// All buffers use ATLAS_SIZE × ATLAS_SIZE (512×512) to store the 64³ volume
// as an 8×8 grid of 64×64 slices.

let density;      // RGBA  – smoke colour + alpha   (replaces dye)
let velocity3D;   // RGBA  – XYZ velocity in RGB    (replaces velocity)
let temperature;  // R     – temperature field for buoyancy (new)
let divergence3D; // R     – divergence             (replaces divergence)
let curl3D;       // R     – vorticity scalar        (replaces curl)
let pressure3D;   // R     – pressure               (replaces pressure)

// Simulation programs (3D only)
const clearProgram           = new Program(baseVertexShader, clearShader);
const colorProgram           = new Program(baseVertexShader, colorShader);

// 3D simulation programs
const advection3DProgram       = new Program(baseVertexShader, advection3DShader);
const divergence3DProgram      = new Program(baseVertexShader, divergence3DShader);
const pressure3DProgram        = new Program(baseVertexShader, pressure3DShader);
const gradientSubtract3DProgram= new Program(baseVertexShader, gradientSubtract3DShader);
const curl3DProgram            = new Program(baseVertexShader, curl3DShader);
const vorticity3DProgram       = new Program(baseVertexShader, vorticity3DShader);
const splat3DProgram           = new Program(baseVertexShader, splat3DShader);
const buoyancyProgram          = new Program(baseVertexShader, buoyancyShader);
const rayMarchProgram          = new Program(baseVertexShader, rayMarchShader);

const displayMaterial = new Material(displayVertexShader, displayShaderSource);

// ── Orbit camera state ────────────────────────────────────────────────────────
// theta = horizontal azimuth (radians), phi = vertical elevation (radians).
// Controlled by arrow keys (input.js). Used by drawDisplay to build the MVP.
const camera = {
    theta:  0.0,
    phi:    0.3,   // slight upward tilt so the quad isn't exactly face-on
    radius: 2.0,
};

// Bootstrap
initFramebuffers();
initSmoke();

let lastUpdateTime = Date.now();
update();
