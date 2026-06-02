'use strict';

// Shared GLSL helpers prepended to every 3D atlas shader.
// Pure string constant — no GL calls needed.
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

// Full-screen quad vertex shader shared by all simulation passes.
let baseVertexShader;

function initBaseShaders () {
    baseVertexShader = compileShader(gl.VERTEX_SHADER, /*glsl*/`
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
}
