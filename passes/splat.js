'use strict';

// ── Smoke Emitter ─────────────────────────────────────────────────────────────
// Gaussian splat injection for density, temperature, and velocity.
// Emitter positions, intensities, and schedules are defined in config.js.

let splat3DProgram;
let _schedulers = [];

function initSplat () {
    const shader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uTarget;
        uniform vec3 uPoint;    // emitter centre in [0,1]³
        uniform vec3 uColor;    // value to inject (velocity XYZ or density RGB)
        uniform float uRadius;  // Gaussian σ² in [0,1]³ space

        void main () {
            vec3 uvw  = decodeUVW(vUv);
            vec3 p    = uvw - uPoint;
            float d   = exp(-dot(p, p) / uRadius);
            vec4 base = sampleVolume(uTarget, uvw);
            gl_FragColor = vec4(base.rgb + uColor * d, base.a);
        }
    `);
    splat3DProgram = new Program(baseVertexShader, shader);

    // Build one EmitterScheduler per entry in config.EMITTERS
    _schedulers = config.EMITTERS.map(cfg => new EmitterScheduler(cfg));
}

// Inject a 3D Gaussian blob into fbo (density, temperature, or velocity3D).
function splat3D (px, py, pz, cr, cg, cb, radius, fbo) {
    splat3DProgram.bind();
    gl.uniform1i(splat3DProgram.uniforms.uTarget,  fbo.read.attach(0));
    gl.uniform3f(splat3DProgram.uniforms.uPoint,   px, py, pz);
    gl.uniform3f(splat3DProgram.uniforms.uColor,   cr, cg, cb);
    gl.uniform1f(splat3DProgram.uniforms.uRadius,  radius);
    blit(fbo.write);
    fbo.swap();
}

// Called once at start and by the GUI "re-emit smoke" button.
// Resets all scheduler clocks so every emitter restarts its schedule.
function initSmoke () {
    _schedulers.forEach(s => s.reset());
}

// Called every frame (dt in seconds).
// Each scheduler advances its clock and injects smoke when active.
function emitSmoke (dt) {
    _schedulers.forEach(s => {
        s.update(dt);
        s.emit();
    });
}
