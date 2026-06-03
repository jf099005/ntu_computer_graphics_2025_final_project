'use strict';

// ── All simulation parameters ─────────────────────────────────────────────────
// Edit this file to tune the simulation. Reload the page after any change.
// Parameters marked [RELOAD] are baked into shaders at startup and require
// a full page reload; all others take effect on the next frame.

const config = {

    // ── Dissipation ────────────────────────────────────────────────────────────
    DENSITY_DISSIPATION:     10.0,   // how fast smoke colour fades  (per second)
    VELOCITY_DISSIPATION:    1,   // how fast fluid velocity fades
    TEMPERATURE_DISSIPATION: 1.0,   // how fast heat fades

    // ── Fluid Solver ───────────────────────────────────────────────────────────
    PRESSURE:            0.8,       // pressure warm-start factor (0–1)
    PRESSURE_ITERATIONS: 25,        // Jacobi iterations per frame
    CURL:                30,        // vorticity confinement strength (swirl)

    // ── Smoke Physics ──────────────────────────────────────────────────────────
    BUOYANCY:     0.1,              // upward force from heat
    SMOKE_WEIGHT: 0.001,             // downward gravity force on density

    // ── Emitters ───────────────────────────────────────────────────────────────
    EMITTERS: [
        { x: 0.5,  y: 0.08, z: 0.5 }
    ],
    EMIT_RADIUS:      0.003,        // Gaussian splat radius (volume-space units)
    EMIT_VELOCITY_Y:  0.01,         // upward velocity injected each frame
    EMIT_TEMPERATURE: 0.02,          // heat injected each frame
    EMIT_DENSITY:     0.0028,         // density injected each frame

    // ── Ray March  [RELOAD] ────────────────────────────────────────────────────
    BOX_RADIUS:   5.0,              // half-size of the marching volume
    MAX_STEPS:    64,               // ray march samples per pixel
    SHADOW_STEPS: 3,                // shadow ray samples
    SHADOW_STEP:  0.12,             // shadow ray step size

    // ── Rendering ──────────────────────────────────────────────────────────────
    DENSITY_SCALE: 0.7,             // visual density multiplier
    ABSORPTION:    15.0,            // opacity per unit density

    // ── Camera ─────────────────────────────────────────────────────────────────
    CAMERA_THETA:  0.0,              // azimuth angle (radians, horizontal orbit)
    CAMERA_PHI:    0.0,              // elevation angle (radians, vertical orbit)
    CAMERA_RADIUS: 2.0,              // distance from orbit center
    CAMERA_CX:     0.0,              // orbit center X
    CAMERA_CY:     -2.0,              // orbit center Y
    CAMERA_CZ:     12.0,              // orbit center Z
    CAMERA_FOV:    60,               // vertical field of view (degrees)

    // ── Camera Key Speeds ──────────────────────────────────────────────────────
    CAMERA_KEY_SPEED: 0.05,          // radians per arrow-key press
    CAMERA_MOVE_SPEED: 0.05,         // world units per WASD press

    // ── Light ──────────────────────────────────────────────────────────────────
    LIGHT_DIR:   { x: 0.4, y: 0.8, z: 0.45 },   // key-light direction (will be normalised)
    LIGHT_COLOR: { r: 1.0, g: 0.95, b: 0.88 },  // key-light colour

    // ── Display ────────────────────────────────────────────────────────────────
    PAUSED:      false,
    BACK_COLOR:  { r: 8, g: 15, b: 40 },
    TRANSPARENT: false,
};
