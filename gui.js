'use strict';

function startGUI () {
    var gui = new dat.GUI({ width: 300 });

    // Smoke behaviour
    gui.add(config, 'DENSITY_DISSIPATION',     0, 4.0).name('density diffusion');
    gui.add(config, 'VELOCITY_DISSIPATION',    0, 4.0).name('velocity diffusion');
    gui.add(config, 'TEMPERATURE_DISSIPATION', 0, 4.0).name('temperature diffusion');
    gui.add(config, 'BUOYANCY',                0, 5.0).name('buoyancy (rise)');
    gui.add(config, 'SMOKE_WEIGHT',            0, 1.0).name('smoke weight (fall)');
    gui.add(config, 'CURL',  0, 50).name('vorticity').step(1);
    gui.add(config, 'PRESSURE', 0.0, 1.0).name('pressure');
    gui.add(config, 'PAUSED').name('paused').listen();
    gui.add({ fun: initSmoke }, 'fun').name('re-emit smoke');

    // Rendering
    let renderFolder = gui.addFolder('Rendering');
    renderFolder.add(config, 'DENSITY_SCALE',  0.01, 2.0).name('density scale');
    renderFolder.add(config, 'ABSORPTION',      1.0, 50.0).name('absorption');
    renderFolder.open();

    // Capture
    let captureFolder = gui.addFolder('Capture');
    captureFolder.addColor(config, 'BACK_COLOR').name('background color');
    captureFolder.add(config, 'TRANSPARENT').name('transparent');
    captureFolder.add({ fun: captureScreenshot }, 'fun').name('take screenshot');

    if (isMobile()) gui.close();
}

function captureScreenshot () {
    let target = createFBO(
        ATLAS_SIZE, ATLAS_SIZE,
        ext.formatRGBA.internalFormat, ext.formatRGBA.format,
        ext.halfFloatTexType, gl.NEAREST
    );
    render(target);

    let texture = framebufferToTexture(target);
    texture = normalizeTexture(texture, target.width, target.height);

    let captureCanvas = textureToCanvas(texture, target.width, target.height);
    let datauri = captureCanvas.toDataURL();
    downloadURI('smoke.png', datauri);
    URL.revokeObjectURL(datauri);
}

function framebufferToTexture (target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    let length  = target.width * target.height * 4;
    let texture = new Float32Array(length);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, texture);
    return texture;
}

function normalizeTexture (texture, width, height) {
    let result = new Uint8Array(texture.length);
    let id = 0;
    for (let i = height - 1; i >= 0; i--) {
        for (let j = 0; j < width; j++) {
            let nid = i * width * 4 + j * 4;
            result[nid + 0] = clamp01(texture[id + 0]) * 255;
            result[nid + 1] = clamp01(texture[id + 1]) * 255;
            result[nid + 2] = clamp01(texture[id + 2]) * 255;
            result[nid + 3] = clamp01(texture[id + 3]) * 255;
            id += 4;
        }
    }
    return result;
}

function textureToCanvas (texture, width, height) {
    let captureCanvas = document.createElement('canvas');
    let ctx = captureCanvas.getContext('2d');
    captureCanvas.width  = width;
    captureCanvas.height = height;
    let imageData = ctx.createImageData(width, height);
    imageData.data.set(texture);
    ctx.putImageData(imageData, 0, 0);
    return captureCanvas;
}

function updateCameraHUD () {
    const th = camera.theta, ph = camera.phi, r = camera.radius;
    const ex = r * Math.sin(th) * Math.cos(ph) + camera.cx;
    const ey = r * Math.sin(ph)                + camera.cy;
    const ez = r * Math.cos(th) * Math.cos(ph) + camera.cz;

    const fmt  = v => (v >= 0 ? ' ' : '') + v.toFixed(2);
    const fmtD = v => (v >= 0 ? ' ' : '') + (v * 180 / Math.PI).toFixed(1) + '°';

    document.getElementById('hud-eye').textContent =
        `${fmt(ex)}  ${fmt(ey)}  ${fmt(ez)}`;
    document.getElementById('hud-ctr').textContent =
        `${fmt(camera.cx)}  ${fmt(camera.cy)}  ${fmt(camera.cz)}`;
    document.getElementById('hud-angles').textContent =
        `θ${fmtD(th)}  φ${fmtD(ph)}  r ${r.toFixed(2)}`;
}
