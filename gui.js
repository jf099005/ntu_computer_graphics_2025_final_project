'use strict';

function updateCameraHUD () {
    const fmt  = v => (v >= 0 ? ' ' : '') + v.toFixed(2);
    const fmtD = v => (v >= 0 ? ' ' : '') + (v * 180 / Math.PI).toFixed(1) + '°';

    const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const sy = Math.sin(camera.yaw),   cy = Math.cos(camera.yaw);
    const fwd = [-sy * cp, sp, -cy * cp];

    document.getElementById('hud-cx').textContent = fmt(camera.x);
    document.getElementById('hud-cy').textContent = fmt(camera.y);
    document.getElementById('hud-cz').textContent = fmt(camera.z);
    document.getElementById('hud-angles').textContent =
        `yaw${fmtD(camera.yaw)}  pitch${fmtD(camera.pitch)}`;
    document.getElementById('hud-fwd').textContent =
        `${fmt(fwd[0])}  ${fmt(fwd[1])}  ${fmt(fwd[2])}`;
}
