'use strict';

function initShaders (gl, ext) {

    const baseVertexShader = compileShader(gl.VERTEX_SHADER, /*glsl*/`
        precision highp float;

        attribute vec2 aPosition;
        varying vec2 vUv;
        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform vec2 texelSize;

        void main () {
            vUv = aPosition * 0.5 + 0.5;
            vL = vUv - vec2(texelSize.x, 0.0);
            vR = vUv + vec2(texelSize.x, 0.0);
            vT = vUv + vec2(0.0, texelSize.y);
            vB = vUv - vec2(0.0, texelSize.y);
            gl_Position = vec4(aPosition, 0.0, 1.0);
        }
    `);

    // Display vertex shader: same as base but applies an MVP matrix so the
    // rendered quad can be orbited via the camera controls.
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



    const clearShader = compileShader(gl.FRAGMENT_SHADER, /*glsl*/`
        precision mediump float;
        precision mediump sampler2D;

        varying highp vec2 vUv;
        uniform sampler2D uTexture;
        uniform float value;

        void main () {
            gl_FragColor = value * texture2D(uTexture, vUv);
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

    // ── 3D Atlas GLSL helpers (prepended to every 3D shader) ─────────────────
    // decodeUVW  – atlas UV → [0,1]³
    // encodeUVW  – [0,1]³  → atlas UV
    // sampleVolume – trilinear sample with Z-slice interpolation
    // STEP_X/Y/Z – one-voxel offsets in [0,1]³ space
    const atlasHelperGLSL = /*glsl*/`
        precision highp float;
        precision highp sampler2D;

        #define VOLUME_SIZE    64.0
        #define SLICES_PER_ROW  8.0

        vec3 decodeUVW (vec2 atlasUV) {
            vec2  sc    = atlasUV * SLICES_PER_ROW;
            float col   = floor(sc.x);
            float row   = floor(sc.y);
            float slice = row * SLICES_PER_ROW + col;
            return vec3(fract(sc), slice / (VOLUME_SIZE - 1.0));
        }

        vec2 encodeUVW (vec3 uvw) {
            uvw = clamp(uvw, 0.0, 1.0);
            float slice = uvw.z * (VOLUME_SIZE - 1.0);
            float col   = mod(floor(slice), SLICES_PER_ROW);
            float row   = floor(slice / SLICES_PER_ROW);
            return (vec2(col, row) + uvw.xy) / SLICES_PER_ROW;
        }

        vec4 sampleVolume (sampler2D tex, vec3 uvw) {
            uvw = clamp(uvw, 0.0, 1.0);
            float z  = uvw.z * (VOLUME_SIZE - 1.0);
            float z0 = floor(z);
            float z1 = min(z0 + 1.0, VOLUME_SIZE - 1.0);
            float t  = fract(z);
            vec4 s0  = texture2D(tex, encodeUVW(vec3(uvw.xy, z0 / (VOLUME_SIZE - 1.0))));
            vec4 s1  = texture2D(tex, encodeUVW(vec3(uvw.xy, z1 / (VOLUME_SIZE - 1.0))));
            return mix(s0, s1, t);
        }

        const vec3 STEP_X = vec3(1.0 / (VOLUME_SIZE - 1.0), 0.0, 0.0);
        const vec3 STEP_Y = vec3(0.0, 1.0 / (VOLUME_SIZE - 1.0), 0.0);
        const vec3 STEP_Z = vec3(0.0, 0.0, 1.0 / (VOLUME_SIZE - 1.0));
    `;

    // ── 3D simulation shaders ─────────────────────────────────────────────────

    // Semi-Lagrangian advection.
    // Velocity is stored in [0,1]³ domain units / second.
    const advection3DShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uSource;
        uniform float dt;
        uniform float dissipation;

        void main () {
            vec3 uvw  = decodeUVW(vUv);
            vec3 vel  = sampleVolume(uVelocity, uvw).xyz;
            vec3 prev = clamp(uvw - dt * vel, 0.0, 1.0);
            vec4 result = sampleVolume(uSource, prev);
            float decay = 1.0 + dissipation * dt;
            gl_FragColor = result / decay;
        }
    `);

    // 6-neighbor divergence with no-slip boundary conditions.
    const divergence3DShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uVelocity;

        void main () {
            vec3 uvw = decodeUVW(vUv);
            vec3 C   = sampleVolume(uVelocity, uvw).xyz;

            float vL = sampleVolume(uVelocity, uvw - STEP_X).x;
            float vR = sampleVolume(uVelocity, uvw + STEP_X).x;
            float vB = sampleVolume(uVelocity, uvw - STEP_Y).y;
            float vT = sampleVolume(uVelocity, uvw + STEP_Y).y;
            float vF = sampleVolume(uVelocity, uvw - STEP_Z).z;
            float vK = sampleVolume(uVelocity, uvw + STEP_Z).z;

            if (uvw.x < STEP_X.x)        vL = -C.x;
            if (uvw.x > 1.0 - STEP_X.x)  vR = -C.x;
            if (uvw.y < STEP_Y.y)        vB = -C.y;
            if (uvw.y > 1.0 - STEP_Y.y)  vT = -C.y;
            if (uvw.z < STEP_Z.z)        vF = -C.z;
            if (uvw.z > 1.0 - STEP_Z.z)  vK = -C.z;

            float div = 0.5 * ((vR - vL) + (vT - vB) + (vK - vF));
            gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
        }
    `);

    // Jacobi pressure iteration: 6-neighbor average minus divergence.
    const pressure3DShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uPressure;
        uniform sampler2D uDivergence;

        void main () {
            vec3 uvw = decodeUVW(vUv);

            float pL = sampleVolume(uPressure, uvw - STEP_X).x;
            float pR = sampleVolume(uPressure, uvw + STEP_X).x;
            float pB = sampleVolume(uPressure, uvw - STEP_Y).x;
            float pT = sampleVolume(uPressure, uvw + STEP_Y).x;
            float pF = sampleVolume(uPressure, uvw - STEP_Z).x;
            float pK = sampleVolume(uPressure, uvw + STEP_Z).x;

            float divergence = sampleVolume(uDivergence, uvw).x;
            float pressure   = (pL + pR + pB + pT + pF + pK - divergence) / 6.0;
            gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
        }
    `);

    // Subtract pressure gradient to enforce ∇·v = 0.
    const gradientSubtract3DShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uPressure;
        uniform sampler2D uVelocity;

        void main () {
            vec3 uvw = decodeUVW(vUv);

            float pL = sampleVolume(uPressure, uvw - STEP_X).x;
            float pR = sampleVolume(uPressure, uvw + STEP_X).x;
            float pB = sampleVolume(uPressure, uvw - STEP_Y).x;
            float pT = sampleVolume(uPressure, uvw + STEP_Y).x;
            float pF = sampleVolume(uPressure, uvw - STEP_Z).x;
            float pK = sampleVolume(uPressure, uvw + STEP_Z).x;

            vec3 vel = sampleVolume(uVelocity, uvw).xyz;
            vel -= 0.5 * vec3(pR - pL, pT - pB, pK - pF);
            gl_FragColor = vec4(vel, 1.0);
        }
    `);

    // 3D curl  ∇ × v  — vector field stored in RGB.
    const curl3DShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uVelocity;

        void main () {
            vec3 uvw = decodeUVW(vUv);

            vec3 vL = sampleVolume(uVelocity, uvw - STEP_X).xyz;
            vec3 vR = sampleVolume(uVelocity, uvw + STEP_X).xyz;
            vec3 vB = sampleVolume(uVelocity, uvw - STEP_Y).xyz;
            vec3 vT = sampleVolume(uVelocity, uvw + STEP_Y).xyz;
            vec3 vF = sampleVolume(uVelocity, uvw - STEP_Z).xyz;
            vec3 vK = sampleVolume(uVelocity, uvw + STEP_Z).xyz;

            // (∂w/∂y - ∂v/∂z,  ∂u/∂z - ∂w/∂x,  ∂v/∂x - ∂u/∂y)
            float cx = 0.5 * ((vT.z - vB.z) - (vK.y - vF.y));
            float cy = 0.5 * ((vK.x - vF.x) - (vR.z - vL.z));
            float cz = 0.5 * ((vR.y - vL.y) - (vT.x - vB.x));
            gl_FragColor = vec4(cx, cy, cz, 0.0);
        }
    `);

    // 3D vorticity confinement — restores curl energy lost to numerical diffusion.
    const vorticity3DShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uCurl;
        uniform float curl;
        uniform float dt;

        void main () {
            vec3 uvw = decodeUVW(vUv);

            float cL = length(sampleVolume(uCurl, uvw - STEP_X).xyz);
            float cR = length(sampleVolume(uCurl, uvw + STEP_X).xyz);
            float cB = length(sampleVolume(uCurl, uvw - STEP_Y).xyz);
            float cT = length(sampleVolume(uCurl, uvw + STEP_Y).xyz);
            float cF = length(sampleVolume(uCurl, uvw - STEP_Z).xyz);
            float cK = length(sampleVolume(uCurl, uvw + STEP_Z).xyz);

            vec3 eta   = normalize(vec3(cR - cL, cT - cB, cK - cF) + 0.0001);
            vec3 omega = sampleVolume(uCurl, uvw).xyz;
            vec3 force = curl * cross(eta, omega);

            vec3 vel = sampleVolume(uVelocity, uvw).xyz;
            vel += force * dt;
            vel  = clamp(vel, -1.0, 1.0);
            gl_FragColor = vec4(vel, 1.0);
        }
    `);

    // 3D Gaussian splat — injects density / velocity / temperature at a point.
    const splat3DShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
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

    // Buoyancy force: hot smoke rises, dense smoke sinks.
    const buoyancyShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uTemperature;
        uniform sampler2D uDensity;
        uniform float uBuoyancy;
        uniform float uWeight;
        uniform float dt;

        void main () {
            vec3  uvw  = decodeUVW(vUv);
            float temp = sampleVolume(uTemperature, uvw).x;
            float dens = length(sampleVolume(uDensity, uvw).rgb);
            vec3  vel  = sampleVolume(uVelocity, uvw).xyz;

            vel.y += dt * (uBuoyancy * temp - uWeight * dens);
            vel    = clamp(vel, -1.0, 1.0);
            gl_FragColor = vec4(vel, 1.0);
        }
    `);

    // ── Volumetric ray marching display ──────────────────────────────────────
    // Renders the density volume as 3D smoke using front-to-back compositing.
    // Camera basis vectors are passed as uniforms from drawRayMarch() in JS.
    const rayMarchShader = compileShader(gl.FRAGMENT_SHADER, atlasHelperGLSL + /*glsl*/`
        varying highp vec2 vUv;

        uniform sampler2D uDensity;
        uniform sampler2D uTemperature;

        // Camera
        uniform vec3  uCameraPos;
        uniform vec3  uCameraForward;
        uniform vec3  uCameraRight;
        uniform vec3  uCameraUp;
        uniform float uTanHalfFov;
        uniform float uAspect;

        // Lighting & rendering
        uniform vec3  uLightDir;
        uniform vec3  uLightColor;
        uniform float uDensityScale;
        uniform float uAbsorption;

        #define MAX_STEPS     64
        #define SHADOW_STEPS   3
        #define SHADOW_STEP  0.12

        // Slab intersection with the unit smoke cube [-0.5, 0.5]³.
        vec2 intersectBox (vec3 ro, vec3 rd) {
            vec3 tMin = (-0.5 - ro) / rd;
            vec3 tMax = ( 0.5 - ro) / rd;
            vec3 t1   = min(tMin, tMax);
            vec3 t2   = max(tMin, tMax);
            return vec2(max(max(t1.x, t1.y), t1.z),
                        min(min(t2.x, t2.y), t2.z));
        }

        void main () {
            // ── Per-pixel ray ────────────────────────────────────────────────
            vec2 ndc    = vUv * 2.0 - 1.0;
            vec3 rayDir = normalize(
                uCameraForward +
                ndc.x * uAspect * uTanHalfFov * uCameraRight +
                ndc.y * uTanHalfFov * uCameraUp
            );

            // ── Volume intersection ─────────────────────────────────────────
            vec2 t = intersectBox(uCameraPos, rayDir);
            if (t.y <= t.x) {
                gl_FragColor = vec4(0.0);
                return;
            }

            float tStart   = max(t.x, 0.0);
            float tEnd     = t.y;
            float stepSize = (tEnd - tStart) / float(MAX_STEPS);

            // ── Front-to-back compositing ───────────────────────────────────
            vec4  accum   = vec4(0.0);
            float transmit = 1.0;

            for (int i = 0; i < MAX_STEPS; i++) {
                float tSample = tStart + (float(i) + 0.5) * stepSize;
                vec3  pos     = uCameraPos + tSample * rayDir;

                // World [-0.5,0.5]³ → atlas uvw [0,1]³
                vec3 uvw     = pos + 0.5;
                vec4 d       = sampleVolume(uDensity, uvw);
                float density = length(d.rgb) * uDensityScale;
                if (density < 0.001) continue;

                // Soft shadow: march toward the light
                float shadow = 0.0;
                for (int s = 0; s < SHADOW_STEPS; s++) {
                    vec3 sp = pos + uLightDir * (float(s) + 0.5) * SHADOW_STEP;
                    shadow += length(sampleVolume(uDensity, sp + 0.5).rgb);
                }
                float lightAtten = exp(-shadow * uDensityScale * uAbsorption * SHADOW_STEP);

                // Temperature tint: cool white → hot orange near the source
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

    return {
        baseVertexShader,
        clearShader,
        colorShader,
        displayShaderSource,
        displayVertexShader,
        atlasHelperGLSL,
        // 3D shaders
        advection3DShader,
        divergence3DShader,
        pressure3DShader,
        gradientSubtract3DShader,
        curl3DShader,
        vorticity3DShader,
        splat3DShader,
        buoyancyShader,
        rayMarchShader,
    };
}
