'use strict';

// ── Volumetric Rendering ──────────────────────────────────────────────────────
// Renders the density volume via front-to-back ray marching with soft shadows
// and temperature-based colour tinting.

let colorProgram;
let rayMarchProgram;
let displayMaterial;
let _dummyModelFBO;   // 1×1 fallback for uModelBuffer when no depth capture exists

function initRender () {
    // Vertex shader with MVP matrix for orbitable display quads
    const displayVertexShader = compileShader(gl.VERTEX_SHADER, /*glsl*/`
        precision highp float;

        attribute vec2 aPosition;
        varying vec2 vUv;
        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform vec2 texelSize;
        uniform mat4 uMVP;

        void main () {
            vUv = aPosition * 0.5 + 0.5;
            vL = vUv - vec2(texelSize.x, 0.0);
            vR = vUv + vec2(texelSize.x, 0.0);
            vT = vUv + vec2(0.0, texelSize.y);
            vB = vUv - vec2(0.0, texelSize.y);
            gl_Position = uMVP * vec4(aPosition, 0.0, 1.0);
        }
    `);

    const colorShader = compileShader(gl.FRAGMENT_SHADER, /*glsl*/`
        precision mediump float;

        uniform vec4 color;

        void main () {
            gl_FragColor = color;
        }
    `);

    const displayShaderSource = /*glsl*/`
        precision highp float;
        precision highp sampler2D;

        varying vec2 vUv;
        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform sampler2D uTexture;
        uniform sampler2D uBloom;
        uniform sampler2D uSunrays;
        uniform sampler2D uDithering;
        uniform vec2 ditherScale;
        uniform vec2 texelSize;

        vec3 linearToGamma (vec3 color) {
            color = max(color, vec3(0));
            return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0));
        }

        void main () {
            vec3 c = texture2D(uTexture, vUv).rgb;

        #ifdef SHADING
            vec3 lc = texture2D(uTexture, vL).rgb;
            vec3 rc = texture2D(uTexture, vR).rgb;
            vec3 tc = texture2D(uTexture, vT).rgb;
            vec3 bc = texture2D(uTexture, vB).rgb;

            float dx = length(rc) - length(lc);
            float dy = length(tc) - length(bc);

            vec3 n = normalize(vec3(dx, dy, length(texelSize)));
            vec3 l = vec3(0.0, 0.0, 1.0);

            float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
            c *= diffuse;
        #endif

        #ifdef BLOOM
            vec3 bloom = texture2D(uBloom, vUv).rgb;
        #endif

        #ifdef SUNRAYS
            float sunrays = texture2D(uSunrays, vUv).r;
            c *= sunrays;
        #ifdef BLOOM
            bloom *= sunrays;
        #endif
        #endif

        #ifdef BLOOM
            float noise = texture2D(uDithering, vUv * ditherScale).r;
            noise = noise * 2.0 - 1.0;
            bloom += noise / 255.0;
            bloom = linearToGamma(bloom);
            c += bloom;
        #endif

            float a = max(c.r, max(c.g, c.b));
            gl_FragColor = vec4(c, a);
        }
    `;

    const rayMarchShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;

        uniform sampler2D uDensity;
        uniform sampler2D uTemperature;
        uniform sampler2D uModelBuffer;  // RGB=lit colour, A=eye-distance (0 = no model)

        uniform vec3  uCameraPos;
        uniform vec3  uCameraForward;
        uniform vec3  uCameraRight;
        uniform vec3  uCameraUp;
        uniform float uTanHalfFov;
        uniform float uAspect;

        uniform vec3  uLightDir;
        uniform vec3  uLightColor;
        uniform float uDensityScale;
        uniform float uAbsorption;

        #define MAX_STEPS     64
        #define SHADOW_STEPS   3
        #define SHADOW_STEP  0.12
        #define BOX_RADIUS 5.0

        vec2 intersectBox (vec3 ro, vec3 rd) {
            vec3 tMin = (-BOX_RADIUS - ro) / rd;
            vec3 tMax = ( BOX_RADIUS - ro) / rd;
            vec3 t1   = min(tMin, tMax);
            vec3 t2   = max(tMin, tMax);
            return vec2(max(max(t1.x, t1.y), t1.z),
                        min(min(t2.x, t2.y), t2.z));
        }

        void main () {
            vec2 ndc    = vUv * 2.0 - 1.0;
            vec3 rayDir = normalize(
                uCameraForward +
                ndc.x * uAspect * uTanHalfFov * uCameraRight +
                ndc.y * uTanHalfFov * uCameraUp
            );

            // Read pre-rendered model depth (A=0 → no model at this pixel).
            vec4  modelBuf   = texture2D(uModelBuffer, vUv);
            float modelDepth = (modelBuf.a > 0.0) ? modelBuf.a : 1.0e9;

            vec2 t = intersectBox(uCameraPos, rayDir);
            if (t.y <= t.x) {
                gl_FragColor = vec4(0.0);
                return;
            }

            float tStart   = max(t.x, 0.0);
            float tEnd     = min(t.y, modelDepth);  // stop ray at model surface

            // Model is entirely in front of the volume segment — skip marching.
            if (tEnd <= tStart) {
                gl_FragColor = vec4(0.0);
                return;
            }

            float stepSize = (tEnd - tStart) / float(MAX_STEPS);

            vec4  accum    = vec4(0.0);
            float transmit = 1.0;

            for (int i = 0; i < MAX_STEPS; i++) {
                float tSample = tStart + (float(i) + 0.5) * stepSize;
                vec3  pos     = uCameraPos + tSample * rayDir;

                // vec3 uvw      = pos + BOX_RADIUS;
                
                vec3 uvw = (pos + BOX_RADIUS) / (2.0 * BOX_RADIUS);
                vec4 d        = sampleVolume(uDensity, uvw);
                float density = length(d.rgb) * uDensityScale;
                if (density < 0.001) continue;

                float shadow = 0.0;
                for (int s = 0; s < SHADOW_STEPS; s++) {
                    vec3 sp = pos + uLightDir * (float(s) + 0.5) * SHADOW_STEP;
                    // shadow += length(sampleVolume(uDensity, sp + BOX_RADIUS).rgb);
                    shadow += length(sampleVolume(uDensity, (sp + BOX_RADIUS) / (2.0 * BOX_RADIUS)).rgb);
                }
                float lightAtten = exp(-shadow * uDensityScale * uAbsorption * SHADOW_STEP);

                float temp = sampleVolume(uTemperature, uvw).x;
                vec3  tint = mix(vec3(0.85, 0.90, 1.00),
                                 vec3(1.00, 0.55, 0.10),
                                 clamp(temp * 0.5, 0.0, 1.0));

                vec3  litCol = tint * (uLightColor * lightAtten + vec3(0.35));
                float alpha  = 1.0 - exp(-density * stepSize * uAbsorption);

                accum.rgb  += transmit * alpha * litCol;
                accum.a    += transmit * alpha;
                transmit   *= 1.0 - alpha;

                if (transmit < 0.01) break;
            }

            gl_FragColor = vec4(accum.rgb, accum.a);
        }
    `);

    colorProgram    = new Program(baseVertexShader, colorShader);
    rayMarchProgram = new Program(baseVertexShader, rayMarchShader);
    displayMaterial = new Material(displayVertexShader, displayShaderSource);

    // 1×1 RGBA float FBO cleared to 0 — used as uModelBuffer when no depth capture is ready.
    _dummyModelFBO = createFBO(1, 1, ext.formatRGBA.internalFormat, ext.formatRGBA.format,
                                ext.halfFloatTexType, gl.NEAREST);
}

function render (target) {
    gl.disable(gl.BLEND);

    if (!config.TRANSPARENT)
        drawColor(target, normalizeColor(config.BACK_COLOR));

    // Build per-pixel model depth+colour buffer before ray marching.
    if (typeof drawModelDepthCapture === 'function') drawModelDepthCapture();

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

// Build orthonormal camera basis from spherical orbit angles.
function getCameraBasis () {
    const th = camera.theta, ph = camera.phi, r = camera.radius;
    const ex = r * Math.sin(th) * Math.cos(ph);
    const ey = r * Math.sin(ph);
    const ez = r * Math.cos(th) * Math.cos(ph);
    const len = Math.sqrt(ex*ex + ey*ey + ez*ez);

    const fx = -ex/len, fy = -ey/len, fz = -ez/len;

    const rLen = Math.sqrt(fz*fz + fx*fx) || 1e-6;
    const rx = -fz/rLen, ry = 0.0, rz = fx/rLen;

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

function drawRayMarch (target) {
    const width  = target == null ? gl.drawingBufferWidth  : target.width;
    const height = target == null ? gl.drawingBufferHeight : target.height;
    const aspect = width / height;

    const { eye, fwd, right, up } = getCameraBasis();
    const tanHalfFov = Math.tan(Math.PI / 6.0); // 60° FoV

    // Fixed key-light from upper-left-front
    const lx = 0.4, ly = 0.8, lz = 0.45;
    const lLen = Math.sqrt(lx*lx + ly*ly + lz*lz);

    const modelFBO = (typeof getModelScreenFBO === 'function' && getModelScreenFBO())
                     || _dummyModelFBO;

    rayMarchProgram.bind();
    gl.uniform3fv(rayMarchProgram.uniforms.uCameraPos,     eye);
    gl.uniform3fv(rayMarchProgram.uniforms.uCameraForward, fwd);
    gl.uniform3fv(rayMarchProgram.uniforms.uCameraRight,   right);
    gl.uniform3fv(rayMarchProgram.uniforms.uCameraUp,      up);
    gl.uniform1f(rayMarchProgram.uniforms.uTanHalfFov,     tanHalfFov);
    gl.uniform1f(rayMarchProgram.uniforms.uAspect,         aspect);
    gl.uniform1i(rayMarchProgram.uniforms.uDensity,        density.read.attach(0));
    gl.uniform1i(rayMarchProgram.uniforms.uTemperature,    temperature.read.attach(1));
    gl.uniform1i(rayMarchProgram.uniforms.uModelBuffer,    modelFBO.attach(2));
    gl.uniform3f(rayMarchProgram.uniforms.uLightDir,       lx/lLen, ly/lLen, lz/lLen);
    gl.uniform3f(rayMarchProgram.uniforms.uLightColor,     1.0, 0.95, 0.88);
    gl.uniform1f(rayMarchProgram.uniforms.uDensityScale,   config.DENSITY_SCALE);
    gl.uniform1f(rayMarchProgram.uniforms.uAbsorption,     config.ABSORPTION);
    blit(target);
}
