'use strict';

// ── Pressure Solve ────────────────────────────────────────────────────────────
// Implements the incompressibility projection step:
//   1. clearPressure   – attenuate old pressure (warm-start for Jacobi)
//   2. solvePressure   – Jacobi iterations: p ← (Σneighbors - divergence) / 6
//   3. subtractGradient – v ← v - ∇p  (enforce ∇·v = 0)

let clearProgram;
let pressure3DProgram;
let gradientSubtract3DProgram;

function initPressure () {
    const clearShader = compileShader(gl.FRAGMENT_SHADER, /*glsl*/`
        precision mediump float;
        precision mediump sampler2D;

        varying highp vec2 vUv;
        uniform sampler2D uTexture;
        uniform float value;

        void main () {
            gl_FragColor = value * texture2D(uTexture, vUv);
        }
    `);

    const pressureShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uPressure;
        uniform sampler2D uDivergence;

        void main () {
            vec3 uvw = decodeUVW(vUv);

            float pL = sampleVolume(uPressure, uvw - STEP_X).x;
            float pR = sampleVolume(uPressure, uvw + STEP_X).x;
            float pB = sampleVolume(uPressure, uvw - STEP_Y).x;
            float pT = sampleVolume(uPressure, uvw + STEP_Y).x;
            float pF = sampleVolume(uPressure, uvw - STEP_Z).x;
            float pK = sampleVolume(uPressure, uvw + STEP_Z).x;

            float divergence = sampleVolume(uDivergence, uvw).x;
            float pressure   = (pL + pR + pB + pT + pF + pK - divergence) / 6.0;
            gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
        }
    `);

    const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uPressure;
        uniform sampler2D uVelocity;

        void main () {
            vec3 uvw = decodeUVW(vUv);

            float pL = sampleVolume(uPressure, uvw - STEP_X).x;
            float pR = sampleVolume(uPressure, uvw + STEP_X).x;
            float pB = sampleVolume(uPressure, uvw - STEP_Y).x;
            float pT = sampleVolume(uPressure, uvw + STEP_Y).x;
            float pF = sampleVolume(uPressure, uvw - STEP_Z).x;
            float pK = sampleVolume(uPressure, uvw + STEP_Z).x;

            vec3 vel = sampleVolume(uVelocity, uvw).xyz;
            vel -= 0.5 * vec3(pR - pL, pT - pB, pK - pF);
            gl_FragColor = vec4(vel, 1.0);
        }
    `);

    clearProgram                = new Program(baseVertexShader, clearShader);
    pressure3DProgram           = new Program(baseVertexShader, pressureShader);
    gradientSubtract3DProgram   = new Program(baseVertexShader, gradientSubtractShader);
}

function clearPressure () {
    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure3D.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value,    config.PRESSURE);
    blit(pressure3D.write);
    pressure3D.swap();
}

function solvePressure () {
    pressure3DProgram.bind();
    gl.uniform1i(pressure3DProgram.uniforms.uDivergence, divergence3D.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressure3DProgram.uniforms.uPressure, pressure3D.read.attach(1));
        blit(pressure3D.write);
        pressure3D.swap();
    }
}

function subtractGradient () {
    gradientSubtract3DProgram.bind();
    gl.uniform1i(gradientSubtract3DProgram.uniforms.uPressure, pressure3D.read.attach(0));
    gl.uniform1i(gradientSubtract3DProgram.uniforms.uVelocity, velocity3D.read.attach(1));
    blit(velocity3D.write);
    velocity3D.swap();
}
