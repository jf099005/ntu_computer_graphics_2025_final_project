'use strict';

// ── Simulation Orchestrator ───────────────────────────────────────────────────
// Owns the FBO lifecycle and the per-frame step sequence.
// Each numbered step delegates to its functional module.

function initFramebuffers () {
    const texType   = ext.halfFloatTexType;
    const rgba      = ext.formatRGBA;
    const r         = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    gl.disable(gl.BLEND);

    if (density == null)
        density = createDoubleFBO(ATLAS_SIZE, ATLAS_SIZE, rgba.internalFormat, rgba.format, texType, filtering);
    else
        density = resizeDoubleFBO(density, ATLAS_SIZE, ATLAS_SIZE, rgba.internalFormat, rgba.format, texType, filtering);

    if (velocity3D == null)
        velocity3D = createDoubleFBO(ATLAS_SIZE, ATLAS_SIZE, rgba.internalFormat, rgba.format, texType, filtering);
    else
        velocity3D = resizeDoubleFBO(velocity3D, ATLAS_SIZE, ATLAS_SIZE, rgba.internalFormat, rgba.format, texType, filtering);

    if (temperature == null)
        temperature = createDoubleFBO(ATLAS_SIZE, ATLAS_SIZE, r.internalFormat, r.format, texType, filtering);
    else
        temperature = resizeDoubleFBO(temperature, ATLAS_SIZE, ATLAS_SIZE, r.internalFormat, r.format, texType, filtering);

    if (modeldepth3D == null)
        modeldepth3D = createFBO(ATLAS_SIZE, ATLAS_SIZE, r.internalFormat, r.format, texType, gl.NEAREST);
    else
        modeldepth3D = resizeFBO(modeldepth3D, ATLAS_SIZE, ATLAS_SIZE, r.internalFormat, r.format, texType, gl.NEAREST);

    if (modelcolor3D == null)
        modelcolor3D = createFBO(ATLAS_SIZE, ATLAS_SIZE, rgba.internalFormat, rgba.format, texType, gl.NEAREST);
    else
        modelcolor3D = resizeFBO(modelcolor3D, ATLAS_SIZE, ATLAS_SIZE, rgba.internalFormat, rgba.format, texType, gl.NEAREST);

    divergence3D = createFBO(ATLAS_SIZE, ATLAS_SIZE, r.internalFormat,    r.format,    texType, gl.NEAREST);
    curl3D       = createFBO(ATLAS_SIZE, ATLAS_SIZE, rgba.internalFormat, rgba.format, texType, gl.NEAREST);
    pressure3D   = createDoubleFBO(ATLAS_SIZE, ATLAS_SIZE, r.internalFormat, r.format, texType, gl.NEAREST);
}

function step (dt) {
    gl.disable(gl.BLEND);
    applyBuoyancy(dt);    // 1. temperature-driven upward force
    computeCurl();        // 2. ∇×v → curl3D
    applyVorticity(dt);   // 3. vorticity confinement
    computeDivergence();  // 4. ∇·v → divergence3D
    clearPressure();      // 5a. attenuate old pressure (warm-start)
    solvePressure();      // 5b. Jacobi iterations
    subtractGradient();   // 6. v ← v - ∇p
    advectAll(dt);        // 7-9. advect velocity, density, temperature
}

function update () {
    const dt = calcDeltaTime();
    if (resizeCanvas())
        initFramebuffers();
    if (!config.PAUSED) {
        emitSmoke(dt);
        step(dt);
    }
    updateProjectiles(dt);
    render(null);
    updateCameraHUD();
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
