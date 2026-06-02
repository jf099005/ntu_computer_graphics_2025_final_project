'use strict';

// CPU tracer particles that outline smoke flow trajectories.
// Rendered on a 2D canvas overlay projected with the same camera as the ray march.

const PARTICLE_COUNT = 40;
const PARTICLE_LIFE  = 5.0;   // seconds
// Emitter world position: volume [0,1]³ emitter (0.5, 0.08, 0.5) → world (-0.5+…) = (0, -0.42, 0)
const EMIT_X = 0.0, EMIT_Y = -0.42, EMIT_Z = 0.0;

const pCanvas = document.createElement('canvas');
pCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;';
document.body.appendChild(pCanvas);
const pCtx = pCanvas.getContext('2d');

function makeParticle (preloadAge) {
    const angle = Math.random() * Math.PI * 2;
    const r     = Math.random() * 0.05;
    return {
        x:   EMIT_X + Math.cos(angle) * r,
        y:   EMIT_Y,
        z:   EMIT_Z + Math.sin(angle) * r,
        vx:  (Math.random() - 0.5) * 0.06,
        vy:  0.10 + Math.random() * 0.14,
        vz:  (Math.random() - 0.5) * 0.06,
        age: preloadAge !== undefined ? preloadAge : 0,
    };
}

// Pre-seed particles at random lifecycle stages so there are no empty frames on load.
const pList = Array.from({ length: PARTICLE_COUNT }, (_, i) =>
    makeParticle(Math.random() * PARTICLE_LIFE));

let pLastTime = Date.now();

function updateParticles () {
    const now = Date.now();
    const dt  = Math.min((now - pLastTime) / 1000, 0.033);
    pLastTime = now;
    if (config.PAUSED) return;

    for (const p of pList) {
        // Gentle turbulence + sustained buoyancy lift
        p.vx += (Math.random() - 0.5) * 0.014;
        p.vy += 0.004;
        p.vz += (Math.random() - 0.5) * 0.014;
        p.vx *= 0.97;
        p.vy  = Math.min(p.vy, 0.38);
        p.vz *= 0.97;

        p.x  += p.vx * dt;
        p.y  += p.vy * dt;
        p.z  += p.vz * dt;
        p.age += dt;

        // Reset when lifetime expires or particle exits top of volume
        if (p.age >= PARTICLE_LIFE || p.y > 0.52) {
            Object.assign(p, makeParticle(0));
        }
    }
}

function drawParticles () {
    pCanvas.width  = canvas.width;
    pCanvas.height = canvas.height;
    pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);

    const { eye, fwd, right, up } = getCameraBasis();
    const tanHalfFov = Math.tan(Math.PI / 6.0);
    const aspect     = pCanvas.width / pCanvas.height;
    const W = pCanvas.width, H = pCanvas.height;

    for (const p of pList) {
        const dx = p.x - eye[0];
        const dy = p.y - eye[1];
        const dz = p.z - eye[2];

        // Project to camera space
        const camZ = dx * fwd[0]   + dy * fwd[1]   + dz * fwd[2];
        if (camZ <= 0.05) continue;

        const camX = dx * right[0] + dy * right[1] + dz * right[2];
        const camY = dx * up[0]    + dy * up[1]    + dz * up[2];

        const ndcX =  camX / (camZ * tanHalfFov * aspect);
        const ndcY =  camY / (camZ * tanHalfFov);
        if (Math.abs(ndcX) > 1.15 || Math.abs(ndcY) > 1.15) continue;

        const sx = (ndcX * 0.5 + 0.5) * W;
        const sy = (1.0 - (ndcY * 0.5 + 0.5)) * H;

        // Fade: sin envelope so particles fade in and out over their life
        const t     = p.age / PARTICLE_LIFE;
        const alpha = Math.sin(t * Math.PI) * 0.70;
        const rad   = (1.8 + t * 3.0);  // particles grow slightly as they rise

        // Soft radial glow
        const grd = pCtx.createRadialGradient(sx, sy, 0, sx, sy, rad * 2.2);
        grd.addColorStop(0,   `rgba(210, 230, 255, ${alpha.toFixed(3)})`);
        grd.addColorStop(0.4, `rgba(160, 200, 255, ${(alpha * 0.5).toFixed(3)})`);
        grd.addColorStop(1,   `rgba(120, 170, 255, 0)`);

        pCtx.beginPath();
        pCtx.arc(sx, sy, rad * 2.2, 0, Math.PI * 2);
        pCtx.fillStyle = grd;
        pCtx.fill();
    }
}
