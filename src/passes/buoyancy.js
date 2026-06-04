'use strict';

// ── Buoyancy ──────────────────────────────────────────────────────────────────
// Hot smoke rises (temperature → upward force); dense smoke sinks (weight).

let buoyancyProgram;

function initBuoyancy () {
    const shader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uTemperature;
        uniform sampler2D uDensity;
        uniform float uBuoyancy;
        uniform float uWeight;
        uniform float dt;

        void main () {
            vec3  uvw  = decodeUVW(vUv);
            float temp = sampleVolume(uTemperature, uvw).x;
            float dens = length(sampleVolume(uDensity, uvw).rgb);
            vec3  vel  = sampleVolume(uVelocity, uvw).xyz;

            vel.y += dt * (uBuoyancy * temp - uWeight * dens);
            vel    = clamp(vel, -1.0, 1.0);
            gl_FragColor = vec4(vel, 1.0);
        }
    `);
    buoyancyProgram = new Program(baseVertexShader, shader);
}

function applyBuoyancy (dt) {
    buoyancyProgram.bind();
    gl.uniform1i(buoyancyProgram.uniforms.uVelocity,    velocity3D.read.attach(0));
    gl.uniform1i(buoyancyProgram.uniforms.uTemperature, temperature.read.attach(1));
    gl.uniform1i(buoyancyProgram.uniforms.uDensity,     density.read.attach(2));
    gl.uniform1f(buoyancyProgram.uniforms.uBuoyancy,    config.BUOYANCY);
    gl.uniform1f(buoyancyProgram.uniforms.uWeight,      config.SMOKE_WEIGHT);
    gl.uniform1f(buoyancyProgram.uniforms.dt,           dt);
    blit(velocity3D.write);
    velocity3D.swap();
}
