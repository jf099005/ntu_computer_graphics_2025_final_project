'use strict';

// ── Volumetric Rendering ──────────────────────────────────────────────────────
// Renders the density volume via front-to-back ray marching with soft shadows
// and temperature-based colour tinting.

let colorProgram;
let rayMarchProgram;
let displayMaterial;
let _dummyModelFBO;   // 1×1 fallback for uModelBuffer when no depth capture exists

let _passthroughProg = null;   // panel 1 & 3: just shows texture RGB
let _depthGrayProg   = null;   // panel 2: depth alpha → grayscale
let _sceneFBO        = null;   // full composited scene (panel 1)
let _rayFBO          = null;   // ray march only (panel 3)
let _panelQuadVAO    = null;
let _panelQuadVB     = null;
let _panelQuadIB     = null;

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

        #define MAX_STEPS     ${config.MAX_STEPS}
        #define SHADOW_STEPS  ${config.SHADOW_STEPS}
        #define SHADOW_STEP   ${config.SHADOW_STEP.toFixed(4)}
        #define BOX_RADIUS    ${config.BOX_RADIUS.toFixed(4)}

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

    // ── Debug panel shaders ───────────────────────────────────────────────────
    const passthroughFrag = compileShader(gl.FRAGMENT_SHADER, /*glsl*/`
        precision mediump float;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        void main () {
            gl_FragColor = vec4(texture2D(uTexture, vUv).rgb, 1.0);
        }
    `);

    const depthGrayFrag = compileShader(gl.FRAGMENT_SHADER, /*glsl*/`
        precision mediump float;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        void main () {
            float d = texture2D(uTexture, vUv).a;
            float g = d > 0.0 ? 1.0 - clamp(d / 20.0, 0.0, 1.0) : 0.0;
            gl_FragColor = vec4(g, g, g, 1.0);
        }
    `);

    _passthroughProg = new Program(baseVertexShader, passthroughFrag);
    _depthGrayProg   = new Program(baseVertexShader, depthGrayFrag);

    // Separate quad geometry for panel blitting (avoids conflicting with the main blit VAO)
    _panelQuadVB = gl.createBuffer();
    const panelVB = _panelQuadVB;
    gl.bindBuffer(gl.ARRAY_BUFFER, panelVB);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, -1,1, 1,1, 1,-1]), gl.STATIC_DRAW);
    _panelQuadIB = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, _panelQuadIB);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2,0,2,3]), gl.STATIC_DRAW);

    if (gl.createVertexArray) {
        _panelQuadVAO = gl.createVertexArray();
        gl.bindVertexArray(_panelQuadVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, panelVB);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, _panelQuadIB);
        gl.bindVertexArray(null);
    }
}

// Recreate a simple color-only panel FBO when canvas dimensions change.
function _ensurePanelFBO (fbo, w, h) {
    if (fbo && fbo.width === w && fbo.height === h) return fbo;
    if (fbo) {
        gl.deleteFramebuffer(fbo.fbo);
        gl.deleteTexture(fbo.texture);
    }
    return createFBO(w, h, ext.formatRGBA.internalFormat, ext.formatRGBA.format,
                     ext.halfFloatTexType, gl.NEAREST);
}

// Recreate an FBO with both color and depth attachments (needed by drawModels).
function _ensureSceneFBO (fbo, w, h) {
    if (fbo && fbo.width === w && fbo.height === h) return fbo;
    if (fbo) {
        gl.deleteFramebuffer(fbo.fbo);
        gl.deleteTexture(fbo.texture);
        if (fbo.depthRB) gl.deleteRenderbuffer(fbo.depthRB);
    }

    const rgba = ext.formatRGBA;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, rgba.internalFormat, w, h, 0, rgba.format,
                  ext.halfFloatTexType, null);

    const depthRB = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRB);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);

    const sceneFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return {
        fbo: sceneFbo, texture, depthRB, width: w, height: h,
        texelSizeX: 1.0 / w, texelSizeY: 1.0 / h,
        attach (id) {
            gl.activeTexture(gl.TEXTURE0 + id);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return id;
        }
    };
}

// Draw an FBO's texture into the sub-rectangle (x, y, w, h) of the canvas.
function _blitToPanel (prog, fbo, x, y, w, h) {
    prog.bind();
    gl.uniform1i(prog.uniforms.uTexture, fbo.attach(0));
    gl.uniform2f(prog.uniforms.texelSize, 1.0 / fbo.width, 1.0 / fbo.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(x, y, w, h);
    if (_panelQuadVAO) {
        gl.bindVertexArray(_panelQuadVAO);
    } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, _panelQuadVB);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, _panelQuadIB);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    if (_panelQuadVAO) gl.bindVertexArray(null);
}

function render (target) {
    const W  = gl.drawingBufferWidth;
    const H  = gl.drawingBufferHeight;
    const pw = Math.floor(W / 3);

    _sceneFBO = _ensureSceneFBO(_sceneFBO, W, H);
    _rayFBO   = _ensurePanelFBO(_rayFBO,   W, H);

    gl.disable(gl.BLEND);

    // ── Panel 1: full composited scene ────────────────────────────────────────
    // FBOs don't auto-clear between frames the way the canvas does, so always clear explicitly.
    if (config.TRANSPARENT) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, _sceneFBO.fbo);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
        drawColor(_sceneFBO, normalizeColor(config.BACK_COLOR));
    }

    if (typeof drawModelDepthCapture === 'function') drawModelDepthCapture();
    if (typeof drawModels === 'function') drawModels(_sceneFBO);

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    drawRayMarch(_sceneFBO);

    // ── Panel 3: ray march only (no model geometry) ───────────────────────────
    gl.disable(gl.BLEND);
    drawColor(_rayFBO, { r: 0, g: 0, b: 0 });
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    drawRayMarch(_rayFBO);

    // ── Composite three panels onto the canvas ────────────────────────────────
    gl.disable(gl.BLEND);

    const depthFBO = (typeof getModelScreenFBO === 'function' && getModelScreenFBO()) || _dummyModelFBO;

    _blitToPanel(_passthroughProg, _sceneFBO, 0,        0, pw,          H);  // left:   full scene
    _blitToPanel(_depthGrayProg,   depthFBO,  pw,       0, pw,          H);  // centre: depth grayscale
    _blitToPanel(_passthroughProg, _rayFBO,   pw * 2,   0, W - pw * 2, H);  // right:  ray march only

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
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

    // const modelFBO = (typeof getModelScreenFBO === 'function' && getModelScreenFBO())
    //                  || _dummyModelFBO;
    const modelFBO = getModelScreenFBO();

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
    blit(target);
}
