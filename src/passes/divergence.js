'use strict';

// ── Divergence ────────────────────────────────────────────────────────────────
// Computes ∇·v using 6-neighbor finite differences with no-slip boundary
// conditions. Result is stored in the scalar divergence3D FBO.

let divergence3DProgram;

function initDivergence () {
    const shader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uVelocity;

        void main () {
            vec3 uvw = decodeUVW(vUv);
            vec3 C   = sampleVolume(uVelocity, uvw).xyz;

            float vL = sampleVolume(uVelocity, uvw - STEP_X).x;
            float vR = sampleVolume(uVelocity, uvw + STEP_X).x;
            float vB = sampleVolume(uVelocity, uvw - STEP_Y).y;
            float vT = sampleVolume(uVelocity, uvw + STEP_Y).y;
            float vF = sampleVolume(uVelocity, uvw - STEP_Z).z;
            float vK = sampleVolume(uVelocity, uvw + STEP_Z).z;

            if (uvw.x < STEP_X.x)        vL = -C.x;
            if (uvw.x > 1.0 - STEP_X.x)  vR = -C.x;
            if (uvw.y < STEP_Y.y)        vB = -C.y;
            if (uvw.y > 1.0 - STEP_Y.y)  vT = -C.y;
            if (uvw.z < STEP_Z.z)        vF = -C.z;
            if (uvw.z > 1.0 - STEP_Z.z)  vK = -C.z;

            float div = 0.5 * ((vR - vL) + (vT - vB) + (vK - vF));
            gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
        }
    `);
    divergence3DProgram = new Program(baseVertexShader, shader);
}

function computeDivergence () {
    divergence3DProgram.bind();
    gl.uniform1i(divergence3DProgram.uniforms.uVelocity, velocity3D.read.attach(0));
    blit(divergence3D);
}
