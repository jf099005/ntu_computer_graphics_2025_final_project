'use strict';

function initFramebuffers () {
    const texType   = ext.halfFloatTexType;
    const rgba      = ext.formatRGBA;
    const r         = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    gl.disable(gl.BLEND);

    // density: RGBA atlas – smoke colour (RGB) + alpha channel
    if (density == null)
        density = createDoubleFBO(ATLAS_SIZE, ATLAS_SIZE, rgba.internalFormat, rgba.format, texType, filtering);
    else
        density = resizeDoubleFBO(density, ATLAS_SIZE, ATLAS_SIZE, rgba.internalFormat, rgba.format, texType, filtering);

    // velocity3D: RGBA atlas – XYZ velocity packed into RGB (A unused for now)
    if (velocity3D == null)
        velocity3D = createDoubleFBO(ATLAS_SIZE, ATLAS_SIZE, rgba.internalFormat, rgba.format, texType, filtering);
    else
        velocity3D = resizeDoubleFBO(velocity3D, ATLAS_SIZE, ATLAS_SIZE, rgba.internalFormat, rgba.format, texType, filtering);

    // temperature: R atlas – scalar temperature field, drives buoyancy in Phase 2
    if (temperature == null)
        temperature = createDoubleFBO(ATLAS_SIZE, ATLAS_SIZE, r.internalFormat, r.format, texType, filtering);
    else
        temperature = resizeDoubleFBO(temperature, ATLAS_SIZE, ATLAS_SIZE, r.internalFormat, r.format, texType, filtering);

    divergence3D = createFBO(ATLAS_SIZE, ATLAS_SIZE, r.internalFormat,    r.format,    texType, gl.NEAREST);
    // curl3D stores a vector field (∇×v) so it needs RGBA
    curl3D       = createFBO(ATLAS_SIZE, ATLAS_SIZE, rgba.internalFormat, rgba.format, texType, gl.NEAREST);
    pressure3D   = createDoubleFBO(ATLAS_SIZE, ATLAS_SIZE, r.internalFormat, r.format, texType, gl.NEAREST);
    // Bloom / sunrays FBOs removed — rendering uses ray marching instead.
}

function update () {
    const dt = calcDeltaTime();
    if (resizeCanvas())
        initFramebuffers();
    if (!config.PAUSED) {
        emitSmoke();
        step(dt);
    }
    render(null);
    // if (typeof updateParticles === 'function') { updateParticles(); drawParticles(); }
    requestAnimationFrame(update);
}

function calcDeltaTime () {
    let now = Date.now();
    let dt  = (now - lastUpdateTime) / 1000;
    dt = Math.min(dt, 0.016666);
    lastUpdateTime = now;
    return dt;
}

function resizeCanvas () {
    let width  = scaleByPixelRatio(canvas.clientWidth);
    let height = scaleByPixelRatio(canvas.clientHeight);
    if (canvas.width != width || canvas.height != height) {
        canvas.width  = width;
        canvas.height = height;
        return true;
    }
    return false;
}

// ── 3D Fluid solver ───────────────────────────────────────────────────────────

function step (dt) {
    gl.disable(gl.BLEND);

    // 1. Buoyancy: temperature drives smoke upward
    buoyancyProgram.bind();
    gl.uniform1i(buoyancyProgram.uniforms.uVelocity,    velocity3D.read.attach(0));
    gl.uniform1i(buoyancyProgram.uniforms.uTemperature, temperature.read.attach(1));
    gl.uniform1i(buoyancyProgram.uniforms.uDensity,     density.read.attach(2));
    gl.uniform1f(buoyancyProgram.uniforms.uBuoyancy,    config.BUOYANCY);
    gl.uniform1f(buoyancyProgram.uniforms.uWeight,      config.SMOKE_WEIGHT);
    gl.uniform1f(buoyancyProgram.uniforms.dt,           dt);
    blit(velocity3D.write);
    velocity3D.swap();

    // 2. Curl  ∇ × v  (vector field → RGBA)
    curl3DProgram.bind();
    gl.uniform1i(curl3DProgram.uniforms.uVelocity, velocity3D.read.attach(0));
    blit(curl3D);

    // 3. Vorticity confinement
    vorticity3DProgram.bind();
    gl.uniform1i(vorticity3DProgram.uniforms.uVelocity, velocity3D.read.attach(0));
    gl.uniform1i(vorticity3DProgram.uniforms.uCurl,     curl3D.attach(1));
    gl.uniform1f(vorticity3DProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticity3DProgram.uniforms.dt,   dt);
    blit(velocity3D.write);
    velocity3D.swap();

    // 4. Divergence
    divergence3DProgram.bind();
    gl.uniform1i(divergence3DProgram.uniforms.uVelocity, velocity3D.read.attach(0));
    blit(divergence3D);

    // 5. Clear pressure then Jacobi solve
    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure3D.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value,    config.PRESSURE);
    blit(pressure3D.write);
    pressure3D.swap();

    pressure3DProgram.bind();
    gl.uniform1i(pressure3DProgram.uniforms.uDivergence, divergence3D.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressure3DProgram.uniforms.uPressure, pressure3D.read.attach(1));
        blit(pressure3D.write);
        pressure3D.swap();
    }

    // 6. Subtract pressure gradient
    gradientSubtract3DProgram.bind();
    gl.uniform1i(gradientSubtract3DProgram.uniforms.uPressure, pressure3D.read.attach(0));
    gl.uniform1i(gradientSubtract3DProgram.uniforms.uVelocity, velocity3D.read.attach(1));
    blit(velocity3D.write);
    velocity3D.swap();

    // 7. Advect velocity
    advection3DProgram.bind();
    let velId = velocity3D.read.attach(0);
    gl.uniform1i(advection3DProgram.uniforms.uVelocity,   velId);
    gl.uniform1i(advection3DProgram.uniforms.uSource,     velId);
    gl.uniform1f(advection3DProgram.uniforms.dt,          dt);
    gl.uniform1f(advection3DProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity3D.write);
    velocity3D.swap();

    // 8. Advect density
    gl.uniform1i(advection3DProgram.uniforms.uVelocity,   velocity3D.read.attach(0));
    gl.uniform1i(advection3DProgram.uniforms.uSource,     density.read.attach(1));
    gl.uniform1f(advection3DProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(density.write);
    density.swap();

    // 9. Advect temperature
    gl.uniform1i(advection3DProgram.uniforms.uVelocity,   velocity3D.read.attach(0));
    gl.uniform1i(advection3DProgram.uniforms.uSource,     temperature.read.attach(1));
    gl.uniform1f(advection3DProgram.uniforms.dissipation, config.TEMPERATURE_DISSIPATION);
    blit(temperature.write);
    temperature.swap();
}

// ── Volumetric 3D rendering ───────────────────────────────────────────────────

function render (target) {
    gl.disable(gl.BLEND);

    if (!config.TRANSPARENT)
        drawColor(target, normalizeColor(config.BACK_COLOR));

    // Draw 3D models (opaque, with depth test) before smoke
    if (typeof drawModels === 'function') drawModels();

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    drawRayMarch(target);
}

function drawColor (target, color) {
    colorProgram.bind();
    gl.uniform4f(colorProgram.uniforms.color, color.r, color.g, color.b, 1);
    blit(target);
}

// Compute orthonormal camera basis from spherical orbit angles.
function getCameraBasis () {
    const th = camera.theta, ph = camera.phi, r = camera.radius;
    const ex = r * Math.sin(th) * Math.cos(ph);
    const ey = r * Math.sin(ph);
    const ez = r * Math.cos(th) * Math.cos(ph);
    const len = Math.sqrt(ex*ex + ey*ey + ez*ez);

    // forward = normalize(origin – eye)
    const fx = -ex/len, fy = -ey/len, fz = -ez/len;

    // right = normalize((-fz, 0, fx))  [forward × worldUp]
    const rLen = Math.sqrt(fz*fz + fx*fx) || 1e-6;
    const rx = -fz/rLen, ry = 0.0, rz = fx/rLen;

    // up = cross(right, forward)
    const ux = ry*fz - rz*fy;
    const uy = rz*fx - rx*fz;
    const uz = rx*fy - ry*fx;

    return {
        eye:   [ex + camera.cx, ey + camera.cy, ez + camera.cz],
        fwd:   [fx, fy, fz],
        right: [rx, ry, rz],
        up:    [ux, uy, uz],
    };
}

// Draw the density volume using ray marching.
function drawRayMarch (target) {
    const width  = target == null ? gl.drawingBufferWidth  : target.width;
    const height = target == null ? gl.drawingBufferHeight : target.height;
    const aspect = width / height;

    const { eye, fwd, right, up } = getCameraBasis();
    const tanHalfFov = Math.tan(Math.PI / 6.0); // 60° FoV

    // Fixed key-light from upper-left-front
    const lx = 0.4, ly = 0.8, lz = 0.45;
    const lLen = Math.sqrt(lx*lx + ly*ly + lz*lz);

    rayMarchProgram.bind();
    gl.uniform3fv(rayMarchProgram.uniforms.uCameraPos,     eye);
    gl.uniform3fv(rayMarchProgram.uniforms.uCameraForward, fwd);
    gl.uniform3fv(rayMarchProgram.uniforms.uCameraRight,   right);
    gl.uniform3fv(rayMarchProgram.uniforms.uCameraUp,      up);
    gl.uniform1f(rayMarchProgram.uniforms.uTanHalfFov,     tanHalfFov);
    gl.uniform1f(rayMarchProgram.uniforms.uAspect,         aspect);
    gl.uniform1i(rayMarchProgram.uniforms.uDensity,        density.read.attach(0));
    gl.uniform1i(rayMarchProgram.uniforms.uTemperature,    temperature.read.attach(1));
    gl.uniform3f(rayMarchProgram.uniforms.uLightDir,       lx/lLen, ly/lLen, lz/lLen);
    gl.uniform3f(rayMarchProgram.uniforms.uLightColor,     1.0, 0.95, 0.88);
    gl.uniform1f(rayMarchProgram.uniforms.uDensityScale,   config.DENSITY_SCALE);
    gl.uniform1f(rayMarchProgram.uniforms.uAbsorption,     config.ABSORPTION);
    blit(target);
}

// ── 3D Smoke emitter ──────────────────────────────────────────────────────────

// Fixed emitter definitions: {x, y, z} in [0,1]³ volume coordinates.
const EMITTERS = [
    { x: 0.5, y: 0.08, z: 0.5 },   // single source at the bottom-centre
    { x: -0.5, y: 0.08, z: 0.5 },   // another source at the bottom-centre
];

const EMIT_RADIUS      = 0.003;  // Gaussian σ² (tight point source)
const EMIT_VELOCITY_Y  = 0.35;   // initial upward speed (domain units / second)
const EMIT_TEMPERATURE = 0.4;    // injected heat per frame
const EMIT_DENSITY     = 0.28;   // injected brightness per frame (low to avoid saturation)

// Called once at start and by the "re-emit smoke" GUI button.
function initSmoke () {
    EMITTERS.forEach(e => {
        // Inject a burst of density and temperature to seed the volume.
        splat3D(e.x, e.y, e.z, EMIT_DENSITY, EMIT_DENSITY, EMIT_DENSITY,
                EMIT_RADIUS * 4.0, density);
        splat3D(e.x, e.y, e.z, EMIT_TEMPERATURE * 2.0, 0.0, 0.0,
                EMIT_RADIUS * 4.0, temperature);
        splat3D(e.x, e.y, e.z, 0.0, EMIT_VELOCITY_Y, 0.0,
                EMIT_RADIUS * 4.0, velocity3D);
    });
}

// Called every frame to continuously emit smoke.
function emitSmoke () {
    EMITTERS.forEach(e => {
        splat3D(e.x, e.y, e.z, EMIT_DENSITY, EMIT_DENSITY, EMIT_DENSITY,
                EMIT_RADIUS, density);
        splat3D(e.x, e.y, e.z, EMIT_TEMPERATURE, 0.0, 0.0,
                EMIT_RADIUS, temperature);
        splat3D(e.x, e.y, e.z, 0.0, EMIT_VELOCITY_Y, 0.0,
                EMIT_RADIUS, velocity3D);
    });
}

// Inject a 3D Gaussian blob into `fbo` (density, temperature, or velocity3D).
// point – [0,1]³ position;  color – RGB values to add;  radius – σ² in [0,1]³
function splat3D (px, py, pz, cr, cg, cb, radius, fbo) {
    splat3DProgram.bind();
    gl.uniform1i(splat3DProgram.uniforms.uTarget,  fbo.read.attach(0));
    gl.uniform3f(splat3DProgram.uniforms.uPoint,   px, py, pz);
    gl.uniform3f(splat3DProgram.uniforms.uColor,   cr, cg, cb);
    gl.uniform1f(splat3DProgram.uniforms.uRadius,  radius);
    blit(fbo.write);
    fbo.swap();
}
