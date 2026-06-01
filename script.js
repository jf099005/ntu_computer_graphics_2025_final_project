'use strict';

const canvas = document.getElementsByTagName('canvas')[0];
resizeCanvas();

let config = {
    // Smoke dissipation (decay rate per second)
    DENSITY_DISSIPATION: 0.5,
    VELOCITY_DISSIPATION: 0.2,
    TEMPERATURE_DISSIPATION: 1.0,
    // Fluid solver
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 25,
    CURL: 30,
    // Smoke behaviour
    BUOYANCY: 1.5,
    // Seed splat radius (used by initSmoke, not exposed in GUI)
    SPLAT_RADIUS: 0.25,
    // Display
    PAUSED: false,
    BACK_COLOR: { r: 0, g: 0, b: 0 },
    TRANSPARENT: false,
    // Post-processing
    BLOOM: true,
    BLOOM_ITERATIONS: 8,
    BLOOM_RESOLUTION: 256,
    BLOOM_INTENSITY: 0.8,
    BLOOM_THRESHOLD: 0.6,
    BLOOM_SOFT_KNEE: 0.7,
    SUNRAYS: true,
    SUNRAYS_RESOLUTION: 196,
    SUNRAYS_WEIGHT: 1.0,
};

const { gl, ext } = getWebGLContext(canvas);

if (!ext.supportLinearFiltering) {
    config.BLOOM = false;
    config.SUNRAYS = false;
}

startGUI();

// Compiled shaders
const {
    baseVertexShader,
    blurVertexShader,
    blurShader,
    copyShader,
    clearShader,
    colorShader,
    checkerboardShader,
    displayShaderSource,
    bloomPrefilterShader,
    bloomBlurShader,
    bloomFinalShader,
    sunraysMaskShader,
    sunraysShader,
    splatShader,
    advectionShader,
    divergenceShader,
    curlShader,
    vorticityShader,
    pressureShader,
    gradientSubtractShader,
    atlasHelperGLSL,
    displayVertexShader,
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
let bloom;
let bloomFramebuffers = [];
let sunrays;
let sunraysTemp;

let ditheringTexture = createTextureAsync('LDR_LLL1_0.png');

// Simulation programs
const blurProgram            = new Program(blurVertexShader, blurShader);
const copyProgram            = new Program(baseVertexShader, copyShader);
const clearProgram           = new Program(baseVertexShader, clearShader);
const colorProgram           = new Program(baseVertexShader, colorShader);
const checkerboardProgram    = new Program(baseVertexShader, checkerboardShader);
const bloomPrefilterProgram  = new Program(baseVertexShader, bloomPrefilterShader);
const bloomBlurProgram       = new Program(baseVertexShader, bloomBlurShader);
const bloomFinalProgram      = new Program(baseVertexShader, bloomFinalShader);
const sunraysMaskProgram     = new Program(baseVertexShader, sunraysMaskShader);
const sunraysProgram         = new Program(baseVertexShader, sunraysShader);
const splatProgram           = new Program(baseVertexShader, splatShader);
const advectionProgram       = new Program(baseVertexShader, advectionShader);
const divergenceProgram      = new Program(baseVertexShader, divergenceShader);
const curlProgram            = new Program(baseVertexShader, curlShader);
const vorticityProgram       = new Program(baseVertexShader, vorticityShader);
const pressureProgram        = new Program(baseVertexShader, pressureShader);
const gradienSubtractProgram = new Program(baseVertexShader, gradientSubtractShader);

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
updateKeywords();
initFramebuffers();
initSmoke();

let lastUpdateTime = Date.now();
update();
