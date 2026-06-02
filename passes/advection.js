'use strict';

// ── Semi-Lagrangian Advection ─────────────────────────────────────────────────
// Advects velocity, density, and temperature using a single shader via
// back-tracing: sample the source field at (uvw - dt*vel).

let advection3DProgram;

function initAdvection () {
    const shader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uSource;
        uniform float dt;
        uniform float dissipation;

        void main () {
            vec3 uvw  = decodeUVW(vUv);
            vec3 vel  = sampleVolume(uVelocity, uvw).xyz;
            vec3 prev = clamp(uvw - dt * vel, 0.0, 1.0);
            vec4 result = sampleVolume(uSource, prev);
            float decay = 1.0 + dissipation * dt;
            gl_FragColor = result / decay;
        }
    `);
    advection3DProgram = new Program(baseVertexShader, shader);
}

// Advects velocity, density, and temperature in one bound-program sequence.
function advectAll (dt) {
    advection3DProgram.bind();

    // Velocity self-advection
    let velId = velocity3D.read.attach(0);
    gl.uniform1i(advection3DProgram.uniforms.uVelocity,   velId);
    gl.uniform1i(advection3DProgram.uniforms.uSource,     velId);
    gl.uniform1f(advection3DProgram.uniforms.dt,          dt);
    gl.uniform1f(advection3DProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity3D.write);
    velocity3D.swap();

    // Density advection
    gl.uniform1i(advection3DProgram.uniforms.uVelocity,   velocity3D.read.attach(0));
    gl.uniform1i(advection3DProgram.uniforms.uSource,     density.read.attach(1));
    gl.uniform1f(advection3DProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(density.write);
    density.swap();

    // Temperature advection
    gl.uniform1i(advection3DProgram.uniforms.uVelocity,   velocity3D.read.attach(0));
    gl.uniform1i(advection3DProgram.uniforms.uSource,     temperature.read.attach(1));
    gl.uniform1f(advection3DProgram.uniforms.dissipation, config.TEMPERATURE_DISSIPATION);
    blit(temperature.write);
    temperature.swap();
}
