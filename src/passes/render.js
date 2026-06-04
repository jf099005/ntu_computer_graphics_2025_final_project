'use strict';

// ── Volumetric Rendering ──────────────────────────────────────────────────────
// Renders the density volume via front-to-back ray marching with soft shadows
// and temperature-based colour tinting.

let colorProgram;
let rayMarchProgram;
let depthVizProgram;
let displayMaterial;
let _dummyModelFBO;   // 1×1 fallback for uModelBuffer when no depth capture exists

function initRender () {
    // Vertex shader for full-screen display quads
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
        uniform vec3 uVolumeCenter;

        #define MAX_STEPS     ${config.MAX_STEPS}
        #define SHADOW_STEPS  ${config.SHADOW_STEPS}
        #define SHADOW_STEP   ${config.SHADOW_STEP.toFixed(4)}
        #define BOX_RADIUS    ${config.BOX_RADIUS.toFixed(4)}

        vec2 intersectBox (vec3 ro, vec3 rd) {
            vec3 boxMin = uVolumeCenter - vec3(BOX_RADIUS);
            vec3 boxMax = uVolumeCenter + vec3(BOX_RADIUS);

            vec3 tMin = (boxMin - ro) / rd;
            vec3 tMax = (boxMax - ro) / rd;
            vec3 t1   = min(tMin, tMax);
            vec3 t2   = max(tMin, tMax);

            return vec2(
                max(max(t1.x, t1.y), t1.z),
                min(min(t2.x, t2.y), t2.z)
            );
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
                
                vec3 uvw = (pos - uVolumeCenter) / (2.0 * BOX_RADIUS) + 0.5;
                vec4 d = sampleVolume(uDensity, uvw);

                // 用 RGB 長度當濃度
                float density = length(d.rgb) * uDensityScale;
                if (density < 0.001) continue;

                // 取得煙霧顏色
                vec3 smokeColor = d.rgb / max(max(d.r, max(d.g, d.b)), 0.001);

                float shadow = 0.0;
                for (int s = 0; s < SHADOW_STEPS; s++) {
                    vec3 sp = pos + uLightDir * (float(s) + 0.5) * SHADOW_STEP;
                    vec3 suv = (sp - uVolumeCenter) / (2.0 * BOX_RADIUS) + 0.5;
                    shadow += length(sampleVolume(uDensity, suv).rgb);
                }

                float lightAtten = exp(-shadow * uDensityScale * uAbsorption * SHADOW_STEP);

                float temp = sampleVolume(uTemperature, uvw).x;

                // 保留煙霧原色，只加一點熱量橘色
                vec3 heatTint = mix(
                    smokeColor,
                    vec3(1.00, 0.55, 0.10),
                    clamp(temp * 0.25, 0.0, 0.35)
                );

                vec3 litCol = heatTint * (uLightColor * lightAtten + vec3(0.35));
                float alpha = 1.0 - exp(-density * stepSize * uAbsorption);

                accum.rgb  += transmit * alpha * litCol;
                accum.a    += transmit * alpha;
                transmit   *= 1.0 - alpha;

                if (transmit < 0.01) break;
            }

            gl_FragColor = vec4(accum.rgb, accum.a);
        }
    `);

    const depthVizShader = compileShader(gl.FRAGMENT_SHADER, /*glsl*/`
        precision highp float;
        precision highp sampler2D;

        varying vec2 vUv;
        uniform sampler2D uModelBuffer;
        uniform vec3 uBackColor;

        vec3 falseColor (float t) {
            t = clamp(t, 0.0, 1.0);
            if (t < 0.25) { return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), t * 4.0); }
            if (t < 0.5)  { return mix(vec3(1.0, 1.0, 0.0), vec3(0.0, 1.0, 0.0), (t - 0.25) * 4.0); }
            if (t < 0.75) { return mix(vec3(0.0, 1.0, 0.0), vec3(0.0, 1.0, 1.0), (t - 0.5)  * 4.0); }
                            return mix(vec3(0.0, 1.0, 1.0), vec3(0.0, 0.0, 1.0), (t - 0.75) * 4.0);
        }

        void main () {
            float depth = texture2D(uModelBuffer, vUv).a;
            // if (depth <= 0.0) {
            //     gl_FragColor = vec4(uBackColor, 1.0);
            //     return;
            // }
            // depth = depth / 5.0;
            depth = 1.0 - depth / 20.0;
            // float t = clamp(depth / 20.0, 0.0, 1.0);
            // gl_FragColor = vec4(depth/20, depth/20, depth/20,1.0);
            gl_FragColor = vec4(depth, depth, depth,1.0);
        }
    `);

    colorProgram    = new Program(baseVertexShader, colorShader);
    rayMarchProgram = new Program(baseVertexShader, rayMarchShader);
    depthVizProgram = new Program(baseVertexShader, depthVizShader);
    displayMaterial = new Material(displayVertexShader, displayShaderSource);

    // 1×1 RGBA float FBO cleared to 0 — used as uModelBuffer when no depth capture is ready.
    _dummyModelFBO = createFBO(1, 1, ext.formatRGBA.internalFormat, ext.formatRGBA.format,
                                ext.halfFloatTexType, gl.NEAREST);
}

function drawDepthViz () {
    const modelFBO = (typeof getModelScreenFBO === 'function' && getModelScreenFBO())
                     || _dummyModelFBO;
    const bg = normalizeColor(config.BACK_COLOR);

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    depthVizProgram.bind();
    gl.uniform1i(depthVizProgram.uniforms.uModelBuffer, modelFBO.attach(0));
    gl.uniform3f(depthVizProgram.uniforms.uBackColor, bg.r, bg.g, bg.b);
    blit(null);
}

function render (target) {
    gl.disable(gl.BLEND);

    // Build per-pixel model depth+colour buffer before ray marching.
    if (typeof drawModelDepthCapture === 'function') drawModelDepthCapture();

    if (config.SHOW_DEPTH_VIZ) {
        drawDepthViz();
        return;
    }

    if (!config.TRANSPARENT)
        drawColor(target, normalizeColor(config.BACK_COLOR));

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

// Build orthonormal FPS camera basis from yaw/pitch angles.
function normalize3(v) {
    const len = Math.hypot(v[0], v[1], v[2]) || 1.0;
    return [v[0] / len, v[1] / len, v[2] / len];
}

function cross3(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function getCameraBasis() {
    const yaw = camera.yaw;
    const pitch = camera.pitch;

    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);

    // yaw = 0, pitch = 0 時，看向 -Z
    const fwd = normalize3([
        -sy * cp,
         sp,
        -cy * cp,
    ]);

    const worldUp = [0, 1, 0];

    const right = normalize3(cross3(fwd, worldUp));
    const up = normalize3(cross3(right, fwd));

    const eye = [camera.x, camera.y, camera.z];

    return { eye, fwd, right, up };
}

function drawRayMarch (target) {
    const width  = target == null ? gl.drawingBufferWidth  : target.width;
    const height = target == null ? gl.drawingBufferHeight : target.height;
    const aspect = width / height;

    const { eye, fwd, right, up } = getCameraBasis();
    const tanHalfFov = Math.tan((config.CAMERA_FOV * Math.PI / 180) / 2);

    const lx = config.LIGHT_DIR.x, ly = config.LIGHT_DIR.y, lz = config.LIGHT_DIR.z;
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
    gl.uniform3f(rayMarchProgram.uniforms.uLightColor,     config.LIGHT_COLOR.r, config.LIGHT_COLOR.g, config.LIGHT_COLOR.b);
    gl.uniform1f(rayMarchProgram.uniforms.uDensityScale,   config.DENSITY_SCALE);
    gl.uniform1f(rayMarchProgram.uniforms.uAbsorption,     config.ABSORPTION);
    gl.uniform3f(
        rayMarchProgram.uniforms.uVolumeCenter,
        0.0, -2.0, 12.0
    );
    blit(target);
}
