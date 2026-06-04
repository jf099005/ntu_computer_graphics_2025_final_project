'use strict';

// ── Curl & Vorticity Confinement ──────────────────────────────────────────────
// curl3DProgram:     computes ∇×v (vector curl field → RGBA FBO)
// vorticity3DProgram: amplifies curl energy lost to numerical diffusion

let curl3DProgram;
let vorticity3DProgram;

function initCurl () {
    const curlShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uVelocity;

        void main () {
            vec3 uvw = decodeUVW(vUv);

            vec3 vL = sampleVolume(uVelocity, uvw - STEP_X).xyz;
            vec3 vR = sampleVolume(uVelocity, uvw + STEP_X).xyz;
            vec3 vB = sampleVolume(uVelocity, uvw - STEP_Y).xyz;
            vec3 vT = sampleVolume(uVelocity, uvw + STEP_Y).xyz;
            vec3 vF = sampleVolume(uVelocity, uvw - STEP_Z).xyz;
            vec3 vK = sampleVolume(uVelocity, uvw + STEP_Z).xyz;

            // (∂w/∂y - ∂v/∂z,  ∂u/∂z - ∂w/∂x,  ∂v/∂x - ∂u/∂y)
            float cx = 0.5 * ((vT.z - vB.z) - (vK.y - vF.y));
            float cy = 0.5 * ((vK.x - vF.x) - (vR.z - vL.z));
            float cz = 0.5 * ((vR.y - vL.y) - (vT.x - vB.x));
            gl_FragColor = vec4(cx, cy, cz, 0.0);
        }
    `);

    const vorticityShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uCurl;
        uniform float curl;
        uniform float dt;

        void main () {
            vec3 uvw = decodeUVW(vUv);

            float cL = length(sampleVolume(uCurl, uvw - STEP_X).xyz);
            float cR = length(sampleVolume(uCurl, uvw + STEP_X).xyz);
            float cB = length(sampleVolume(uCurl, uvw - STEP_Y).xyz);
            float cT = length(sampleVolume(uCurl, uvw + STEP_Y).xyz);
            float cF = length(sampleVolume(uCurl, uvw - STEP_Z).xyz);
            float cK = length(sampleVolume(uCurl, uvw + STEP_Z).xyz);

            vec3 eta   = normalize(vec3(cR - cL, cT - cB, cK - cF) + 0.0001);
            vec3 omega = sampleVolume(uCurl, uvw).xyz;
            vec3 force = curl * cross(eta, omega);

            vec3 vel = sampleVolume(uVelocity, uvw).xyz;
            vel += force * dt;
            vel  = clamp(vel, -1.0, 1.0);
            gl_FragColor = vec4(vel, 1.0);
        }
    `);

    curl3DProgram      = new Program(baseVertexShader, curlShader);
    vorticity3DProgram = new Program(baseVertexShader, vorticityShader);
}

function computeCurl () {
    curl3DProgram.bind();
    gl.uniform1i(curl3DProgram.uniforms.uVelocity, velocity3D.read.attach(0));
    blit(curl3D);
}

function applyVorticity (dt) {
    vorticity3DProgram.bind();
    gl.uniform1i(vorticity3DProgram.uniforms.uVelocity, velocity3D.read.attach(0));
    gl.uniform1i(vorticity3DProgram.uniforms.uCurl,     curl3D.attach(1));
    gl.uniform1f(vorticity3DProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticity3DProgram.uniforms.dt,   dt);
    blit(velocity3D.write);
    velocity3D.swap();
}
