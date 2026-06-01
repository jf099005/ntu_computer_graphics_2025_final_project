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

    divergence3D = createFBO(ATLAS_SIZE, ATLAS_SIZE, r.internalFormat, r.format, texType, gl.NEAREST);
    curl3D       = createFBO(ATLAS_SIZE, ATLAS_SIZE, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure3D   = createDoubleFBO(ATLAS_SIZE, ATLAS_SIZE, r.internalFormat, r.format, texType, gl.NEAREST);

    initBloomFramebuffers();
    initSunraysFramebuffers();
}

function initBloomFramebuffers () {
    let res = getResolution(config.BLOOM_RESOLUTION);

    const texType   = ext.halfFloatTexType;
    const rgba      = ext.formatRGBA;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    bloom = createFBO(res.width, res.height, rgba.internalFormat, rgba.format, texType, filtering);

    bloomFramebuffers.length = 0;
    for (let i = 0; i < config.BLOOM_ITERATIONS; i++) {
        let width  = res.width  >> (i + 1);
        let height = res.height >> (i + 1);
        if (width < 2 || height < 2) break;
        let fbo = createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering);
        bloomFramebuffers.push(fbo);
    }
}

function initSunraysFramebuffers () {
    let res = getResolution(config.SUNRAYS_RESOLUTION);

    const texType   = ext.halfFloatTexType;
    const r         = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    sunrays     = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
    sunraysTemp = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
}

function updateKeywords () {
    let displayKeywords = [];
    if (config.BLOOM)    displayKeywords.push('BLOOM');
    if (config.SUNRAYS)  displayKeywords.push('SUNRAYS');
    displayMaterial.setKeywords(displayKeywords);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

function update () {
    const dt = calcDeltaTime();
    if (resizeCanvas())
        initFramebuffers();
    if (!config.PAUSED)
        step(dt);
    render(null);
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

// ── Fluid solver step (2D shaders running on atlas as placeholder) ─────────────
// Phase 2 will replace these with proper 3D atlas-aware shaders.

function step (dt) {
    gl.disable(gl.BLEND);

    // Vorticity (curl)
    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, velocity3D.texelSizeX, velocity3D.texelSizeY);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity3D.read.attach(0));
    blit(curl3D);

    // Vorticity confinement
    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity3D.texelSizeX, velocity3D.texelSizeY);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity3D.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl,     curl3D.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt,   dt);
    blit(velocity3D.write);
    velocity3D.swap();

    // Divergence
    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity3D.texelSizeX, velocity3D.texelSizeY);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity3D.read.attach(0));
    blit(divergence3D);

    // Clear & solve pressure (Jacobi iterations)
    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure3D.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
    blit(pressure3D.write);
    pressure3D.swap();

    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, velocity3D.texelSizeX, velocity3D.texelSizeY);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence3D.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureProgram.uniforms.uPressure, pressure3D.read.attach(1));
        blit(pressure3D.write);
        pressure3D.swap();
    }

    // Subtract pressure gradient
    gradienSubtractProgram.bind();
    gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, velocity3D.texelSizeX, velocity3D.texelSizeY);
    gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure3D.read.attach(0));
    gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity3D.read.attach(1));
    blit(velocity3D.write);
    velocity3D.swap();

    // Advect velocity
    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, velocity3D.texelSizeX, velocity3D.texelSizeY);
    if (!ext.supportLinearFiltering)
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity3D.texelSizeX, velocity3D.texelSizeY);
    let velId = velocity3D.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velId);
    gl.uniform1i(advectionProgram.uniforms.uSource,   velId);
    gl.uniform1f(advectionProgram.uniforms.dt,          dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity3D.write);
    velocity3D.swap();

    // Advect density
    if (!ext.supportLinearFiltering)
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, density.texelSizeX, density.texelSizeY);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity3D.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource,   density.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(density.write);
    density.swap();
}

// ── Rendering (2D atlas display – placeholder until Phase 3 ray marching) ─────

function render (target) {
    if (config.BLOOM)
        applyBloom(density.read, bloom);
    if (config.SUNRAYS) {
        applySunrays(density.read, density.write, sunrays);
        blur(sunrays, sunraysTemp, 1);
    }

    if (target == null || !config.TRANSPARENT) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.BLEND);
    } else {
        gl.disable(gl.BLEND);
    }

    if (!config.TRANSPARENT)
        drawColor(target, normalizeColor(config.BACK_COLOR));
    drawDisplay(target);
}

function drawColor (target, color) {
    colorProgram.bind();
    gl.uniform4f(colorProgram.uniforms.color, color.r, color.g, color.b, 1);
    blit(target);
}

function drawDisplay (target) {
    let width  = target == null ? gl.drawingBufferWidth  : target.width;
    let height = target == null ? gl.drawingBufferHeight : target.height;

    let mvp = getCameraViewProjection(camera.theta, camera.phi, camera.radius, width / height);

    displayMaterial.bind();
    gl.uniformMatrix4fv(displayMaterial.uniforms.uMVP, false, mvp);
    gl.uniform2f(displayMaterial.uniforms.texelSize, 1.0 / width, 1.0 / height);
    gl.uniform1i(displayMaterial.uniforms.uTexture, density.read.attach(0));
    if (config.BLOOM) {
        gl.uniform1i(displayMaterial.uniforms.uBloom,     bloom.attach(1));
        gl.uniform1i(displayMaterial.uniforms.uDithering, ditheringTexture.attach(2));
        let scale = getTextureScale(ditheringTexture, width, height);
        gl.uniform2f(displayMaterial.uniforms.ditherScale, scale.x, scale.y);
    }
    if (config.SUNRAYS)
        gl.uniform1i(displayMaterial.uniforms.uSunrays, sunrays.attach(3));
    blit(target);
}

function applyBloom (source, destination) {
    if (bloomFramebuffers.length < 2) return;

    let last = destination;

    gl.disable(gl.BLEND);
    bloomPrefilterProgram.bind();
    let knee   = config.BLOOM_THRESHOLD * config.BLOOM_SOFT_KNEE + 0.0001;
    let curve0 = config.BLOOM_THRESHOLD - knee;
    let curve1 = knee * 2;
    let curve2 = 0.25 / knee;
    gl.uniform3f(bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
    gl.uniform1f(bloomPrefilterProgram.uniforms.threshold, config.BLOOM_THRESHOLD);
    gl.uniform1i(bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
    blit(last);

    bloomBlurProgram.bind();
    for (let i = 0; i < bloomFramebuffers.length; i++) {
        let dest = bloomFramebuffers[i];
        gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
        gl.uniform1i(bloomBlurProgram.uniforms.uTexture,  last.attach(0));
        blit(dest);
        last = dest;
    }

    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);
    for (let i = bloomFramebuffers.length - 2; i >= 0; i--) {
        let baseTex = bloomFramebuffers[i];
        gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
        gl.uniform1i(bloomBlurProgram.uniforms.uTexture,  last.attach(0));
        gl.viewport(0, 0, baseTex.width, baseTex.height);
        blit(baseTex);
        last = baseTex;
    }

    gl.disable(gl.BLEND);
    bloomFinalProgram.bind();
    gl.uniform2f(bloomFinalProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(bloomFinalProgram.uniforms.uTexture,  last.attach(0));
    gl.uniform1f(bloomFinalProgram.uniforms.intensity, config.BLOOM_INTENSITY);
    blit(destination);
}

function applySunrays (source, mask, destination) {
    gl.disable(gl.BLEND);
    sunraysMaskProgram.bind();
    gl.uniform1i(sunraysMaskProgram.uniforms.uTexture, source.attach(0));
    blit(mask);

    sunraysProgram.bind();
    gl.uniform1f(sunraysProgram.uniforms.weight,   config.SUNRAYS_WEIGHT);
    gl.uniform1i(sunraysProgram.uniforms.uTexture, mask.attach(0));
    blit(destination);
}

function blur (target, temp, iterations) {
    blurProgram.bind();
    for (let i = 0; i < iterations; i++) {
        gl.uniform2f(blurProgram.uniforms.texelSize, target.texelSizeX, 0.0);
        gl.uniform1i(blurProgram.uniforms.uTexture,  target.attach(0));
        blit(temp);

        gl.uniform2f(blurProgram.uniforms.texelSize, 0.0, target.texelSizeY);
        gl.uniform1i(blurProgram.uniforms.uTexture,  temp.attach(0));
        blit(target);
    }
}

// ── Smoke seeding ─────────────────────────────────────────────────────────────
// Phase 1 placeholder: random splats seed the density atlas so there is visible
// output while the 2D shaders are still running on the atlas texture.
// Phase 2 will replace this with a fixed 3D emitter using atlas coordinates.

function initSmoke () {
    for (let i = 0; i < 5; i++) {
        const color = generateColor();
        color.r *= 10.0;
        color.g *= 10.0;
        color.b *= 10.0;
        splat(
            Math.random(),
            Math.random(),
            500 * (Math.random() - 0.5),
            500 * (Math.random() - 0.5),
            color
        );
    }
}

function splat (x, y, dx, dy, color) {
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget,     velocity3D.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point,       x, y);
    gl.uniform3f(splatProgram.uniforms.color,       dx, dy, 0.0);
    gl.uniform1f(splatProgram.uniforms.radius,      correctRadius(config.SPLAT_RADIUS / 100.0));
    blit(velocity3D.write);
    velocity3D.swap();

    gl.uniform1i(splatProgram.uniforms.uTarget, density.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color,   color.r, color.g, color.b);
    blit(density.write);
    density.swap();
}

function correctRadius (radius) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio > 1) radius *= aspectRatio;
    return radius;
}
