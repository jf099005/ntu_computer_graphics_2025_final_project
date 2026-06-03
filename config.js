'use strict';

// ── All simulation parameters ─────────────────────────────────────────────────
// Edit this file to tune the simulation. Reload the page after any change.
// Parameters marked [RELOAD] are baked into shaders at startup and require
// a full page reload; all others take effect on the next frame.

const config = {

    // ── Dissipation ────────────────────────────────────────────────────────────
    DENSITY_DISSIPATION:     1.0,   // how fast smoke colour fades  (per second)
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
    // Each entry is managed by EmitterScheduler (passes/emitter.js).
    //
    // Static fields  : x, y, z, vx, vy, vz, density, temperature
    //                  (initial / fallback values)
    // Schedule fields: startTime, endTime  (seconds since last reset)
    // trajectory(t)  : optional function — called every frame with elapsed
    //                  seconds; returned fields override the current values.
    //                  Return only the fields you want to change.
    EMITTERS: [
        {
            // ── initial / fallback values ─────────────────────────────────
            x: 0.5,  y: 0.08, z: 0.5,
            vx: 0.0, vy: 0.01, vz: 0.0,
            density:     0.0028,
            temperature: 0.02,

            // ── schedule ──────────────────────────────────────────────────
            startTime: 1,   // start at t = 1 s
            endTime:   5,   // stop  at t = 5 s

            // ── trajectory (time-varying overrides) ───────────────────────
            // t = seconds elapsed since reset().
            // Example: position drifts in X, intensity ramps up then down.
            trajectory (t) {
                const localT = t - 1;                       // time within active window
                return {
                    x:       0.5 + 0.1 * Math.sin(localT * Math.PI),
                    density: 0.0028 * (1 + localT),         // ramp up over 4 s
                };
            },
        },
    ],

    // Global defaults (used when per-emitter values are omitted)
    EMIT_RADIUS:      0.003,        // Gaussian splat radius (volume-space units)
    EMIT_VELOCITY_Y:  0.01,         // default upward velocity
    EMIT_TEMPERATURE: 0.02,         // default heat per frame
    EMIT_DENSITY:     0.0028,       // default density per frame

    // ── Ray March  [RELOAD] ────────────────────────────────────────────────────
    BOX_RADIUS:   5.0,              // half-size of the marching volume
    MAX_STEPS:    64,               // ray march samples per pixel
    SHADOW_STEPS: 3,                // shadow ray samples
    SHADOW_STEP:  0.12,             // shadow ray step size

    // ── Rendering ──────────────────────────────────────────────────────────────
    DENSITY_SCALE: 0.7,             // visual density multiplier
    ABSORPTION:    15.0,            // opacity per unit density

   // ── Camera ─────────────────────────────────────────────────────────────────
    CAMERA_X:      0.0,
    CAMERA_Y:     -2.0,
    CAMERA_Z:     14.0,

    CAMERA_YAW:    0.0,   // 0 = look toward -Z
    CAMERA_PITCH:  0.0,

    CAMERA_FOV:    60,

    // ── FPS Camera Controls ────────────────────────────────────────────────────
    CAMERA_MOVE_SPEED:        0.05,   // world units per WASD press
    CAMERA_MOUSE_SENSITIVITY: 0.001,

    // ── Light ──────────────────────────────────────────────────────────────────
    LIGHT_DIR:   { x: 0.4, y: 0.8, z: 0.45 },   // key-light direction (will be normalised)
    LIGHT_COLOR: { r: 1.0, g: 0.95, b: 0.88 },  // key-light colour

    // ── Display ────────────────────────────────────────────────────────────────
    PAUSED:      false,
    BACK_COLOR:  { r: 8, g: 15, b: 40 },
    TRANSPARENT: true,
};
