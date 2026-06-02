'use strict';

// ── GLB/GLTF Model Loader and Renderer ───────────────────────────────────────
// loadGLBModel(url, x, y, z, targetSize)  – async, load a .glb at world pos
// drawModels()                            – call once per frame from render()

const _models = [];
let _modelProg = null;

const _MODEL_VERT = /*glsl*/`
    precision highp float;
    attribute vec3 aPos;
    attribute vec3 aNorm;
    uniform mat4 uMVP;
    uniform mat4 uMod;
    varying vec3 vN;
    varying vec3 vW;
    void main() {
        vec4 w = uMod * vec4(aPos, 1.0);
        vW = w.xyz;
        vN = normalize(mat3(uMod[0].xyz, uMod[1].xyz, uMod[2].xyz) * aNorm);
        gl_Position = uMVP * vec4(aPos, 1.0);
    }
`;

const _MODEL_FRAG = /*glsl*/`
    precision highp float;
    varying vec3 vN;
    varying vec3 vW;
    uniform vec3 uEye;
    uniform vec3 uColor;
    void main() {
        vec3 N = normalize(vN);
        vec3 L = normalize(vec3(0.4, 0.8, 0.45));
        vec3 V = normalize(uEye - vW);
        vec3 H = normalize(L + V);
        float diff = max(dot(N, L), 0.0) * 0.7 + 0.3;
        float spec = pow(max(dot(N, H), 0.0), 48.0) * 0.4;
        gl_FragColor = vec4(uColor * diff + vec3(spec), 1.0);
    }
`;

function _buildModelProgram () {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, _MODEL_VERT);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
        console.error('[model] vert:', gl.getShaderInfoLog(vs));

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, _MODEL_FRAG);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
        console.error('[model] frag:', gl.getShaderInfoLog(fs));

    const prog = gl.createProgram();
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aNorm');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        console.error('[model] link:', gl.getProgramInfoLog(prog));

    return {
        prog,
        uMVP:   gl.getUniformLocation(prog, 'uMVP'),
        uMod:   gl.getUniformLocation(prog, 'uMod'),
        uEye:   gl.getUniformLocation(prog, 'uEye'),
        uColor: gl.getUniformLocation(prog, 'uColor'),
    };
}

// ── GLB binary parsing ────────────────────────────────────────────────────────

function _readAccessor (gltf, bin, idx) {
    if (idx == null) return null;
    const acc  = gltf.accessors[idx];
    const bv   = gltf.bufferViews[acc.bufferView];
    const base = bin.byteOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const perElem = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT4:16 }[acc.type] || 1;
    const count   = acc.count * perElem;
    const stride  = bv.byteStride || 0;

    if (acc.componentType === 5126) { // FLOAT32
        const bytes = perElem * 4;
        if (!stride || stride === bytes) {
            return new Float32Array(bin.buffer.slice(base, base + count * 4));
        }
        // Interleaved — de-interleave
        const out = new Float32Array(count);
        for (let i = 0; i < acc.count; i++) {
            const src = new Float32Array(bin.buffer.slice(base + i * stride, base + i * stride + bytes));
            out.set(src, i * perElem);
        }
        return out;
    }
    if (acc.componentType === 5123) // UINT16
        return new Uint16Array(bin.buffer.slice(base, base + count * 2));
    if (acc.componentType === 5125) // UINT32
        return new Uint32Array(bin.buffer.slice(base, base + count * 4));
    if (acc.componentType === 5121) // UINT8
        return new Uint8Array(bin.buffer.slice(base, base + count));
    return null;
}

function _nodeMatrix (node) {
    if (node.matrix) return new Float32Array(node.matrix);
    const I = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    let T = I.slice(), R = I.slice(), S = I.slice();
    if (node.translation) {
        const [tx, ty, tz] = node.translation;
        T = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, tx,ty,tz,1]);
    }
    if (node.rotation) {
        const [x, y, z, w] = node.rotation;
        R = new Float32Array([
            1-2*y*y-2*z*z, 2*x*y+2*w*z,   2*x*z-2*w*y, 0,
            2*x*y-2*w*z,   1-2*x*x-2*z*z, 2*y*z+2*w*x, 0,
            2*x*z+2*w*y,   2*y*z-2*w*x,   1-2*x*x-2*y*y, 0,
            0, 0, 0, 1
        ]);
    }
    if (node.scale) {
        const [sx, sy, sz] = node.scale;
        S = new Float32Array([sx,0,0,0, 0,sy,0,0, 0,0,sz,0, 0,0,0,1]);
    }
    return mat4Multiply(mat4Multiply(T, R), S);
}

function _uploadMesh (gltf, bin, meshIdx, nodeMatrix, out) {
    const mesh = gltf.meshes[meshIdx];
    for (const prim of (mesh.primitives || [])) {
        const attrs = prim.attributes || {};
        if (attrs.POSITION == null) continue;

        const pos  = _readAccessor(gltf, bin, attrs.POSITION);
        const norm = _readAccessor(gltf, bin, attrs.NORMAL);
        const idx  = _readAccessor(gltf, bin, prim.indices);
        if (!pos) continue;

        const posBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);

        let normBuf = null;
        if (norm) {
            normBuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
            gl.bufferData(gl.ARRAY_BUFFER, norm, gl.STATIC_DRAW);
        }

        let idxBuf = null, idxCount = 0, idxType = gl.UNSIGNED_SHORT;
        if (idx) {
            idxBuf = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
            idxCount = idx.length;
            idxType  = (idx instanceof Uint32Array) ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
        }

        let baseColor = [0.65, 0.70, 0.80];
        if (prim.material != null && gltf.materials) {
            const mat = gltf.materials[prim.material];
            const pbr = mat && mat.pbrMetallicRoughness;
            if (pbr && pbr.baseColorFactor) baseColor = pbr.baseColorFactor.slice(0, 3);
        }

        // Build VAO (WebGL 2)
        let vao = null;
        if (gl.createVertexArray) {
            vao = gl.createVertexArray();
            gl.bindVertexArray(vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
            if (normBuf) {
                gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
                gl.enableVertexAttribArray(1);
                gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
            } else {
                gl.disableVertexAttribArray(1);
                gl.vertexAttrib3f(1, 0, 1, 0);
            }
            if (idxBuf) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
            gl.bindVertexArray(null);
        }

        out.push({ vao, posBuf, normBuf, idxBuf, idxCount, idxType,
                   posCount: pos.length / 3, baseColor, nodeMatrix });
    }
}

function _traverseNode (gltf, bin, nodeIdx, parentMat, out) {
    const node  = gltf.nodes[nodeIdx];
    const local = _nodeMatrix(node);
    const world = mat4Multiply(parentMat, local);
    if (node.mesh != null) _uploadMesh(gltf, bin, node.mesh, world, out);
    for (const c of (node.children || [])) _traverseNode(gltf, bin, c, world, out);
}

// ── Public API ────────────────────────────────────────────────────────────────

async function loadGLBModel (url, x, y, z, targetSize) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`[model] fetch failed ${resp.status}: ${url}`);
    const buf = await resp.arrayBuffer();
    const dv  = new DataView(buf);

    if (dv.getUint32(0, true) !== 0x46546C67)
        throw new Error('[model] Not a valid GLB (bad magic)');

    const jsonLen  = dv.getUint32(12, true);
    const jsonText = new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen));
    const gltf     = JSON.parse(jsonText);

    const binBase = 20 + jsonLen;
    const binLen  = dv.getUint32(binBase, true);
    const bin     = new Uint8Array(buf, binBase + 8, binLen);

    const primitives = [];
    const identity   = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

    const sceneIdx  = gltf.scene != null ? gltf.scene : 0;
    const rootNodes = (gltf.scenes && gltf.scenes[sceneIdx])
                      ? (gltf.scenes[sceneIdx].nodes || []) : [];

    if (rootNodes.length > 0 && gltf.nodes) {
        for (const ni of rootNodes) _traverseNode(gltf, bin, ni, identity, primitives);
    } else if (gltf.nodes) {
        for (let ni = 0; ni < gltf.nodes.length; ni++)
            _traverseNode(gltf, bin, ni, identity, primitives);
    } else if (gltf.meshes) {
        for (let mi = 0; mi < gltf.meshes.length; mi++)
            _uploadMesh(gltf, bin, mi, identity, primitives);
    }

    // Bounding box from accessor min/max (GLTF spec guarantees these for POSITION)
    let minX =  Infinity, minY =  Infinity, minZ =  Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const mesh of (gltf.meshes || [])) {
        for (const prim of (mesh.primitives || [])) {
            const ai = prim.attributes && prim.attributes.POSITION;
            if (ai == null) continue;
            const acc = gltf.accessors[ai];
            if (acc.min && acc.max) {
                minX = Math.min(minX, acc.min[0]); maxX = Math.max(maxX, acc.max[0]);
                minY = Math.min(minY, acc.min[1]); maxY = Math.max(maxY, acc.max[1]);
                minZ = Math.min(minZ, acc.min[2]); maxZ = Math.max(maxZ, acc.max[2]);
            }
        }
    }

    const maxDim = Math.max(maxX-minX, maxY-minY, maxZ-minZ) || 1;
    const center = [(minX+maxX)/2, (minY+maxY)/2, (minZ+maxZ)/2];
    const scale  = (targetSize != null ? targetSize : 1.5) / maxDim;

    _models.push({ primitives, position: [x, y, z], scale, center });
    console.log(`[model] Loaded ${url}: ${primitives.length} primitives, ` +
                `scale=${scale.toFixed(4)}, worldPos=(${x},${y},${z})`);
    console.log('[model] Use arrow keys to orbit and WASD to pan the camera toward the model.');
}

// ── Per-frame draw ────────────────────────────────────────────────────────────

function _mat4T (tx, ty, tz) {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, tx,ty,tz,1]);
}
function _mat4S (s) {
    return new Float32Array([s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1]);
}

function drawModels () {
    if (_models.length === 0) return;
    if (!_modelProg) _modelProg = _buildModelProgram();

    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const aspect = W / H;

    // Build VP using the same camera basis as the ray-march renderer
    const { eye, fwd, up } = getCameraBasis();
    const lookAt = [eye[0]+fwd[0], eye[1]+fwd[1], eye[2]+fwd[2]];
    const view = mat4LookAt(eye, lookAt, up);
    const proj = mat4Perspective(Math.PI / 3.0, aspect, 0.1, 20.0);
    const vp   = mat4Multiply(proj, view);

    gl.viewport(0, 0, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);

    gl.useProgram(_modelProg.prog);
    gl.uniform3fv(_modelProg.uEye, new Float32Array(eye));

    for (const model of _models) {
        // World transform: T(worldPos) * S(scale) * T(-center)
        const worldXform = mat4Multiply(
            _mat4T(...model.position),
            mat4Multiply(_mat4S(model.scale), _mat4T(-model.center[0], -model.center[1], -model.center[2]))
        );

        for (const prim of model.primitives) {
            const modMat = mat4Multiply(worldXform, prim.nodeMatrix);
            const mvp    = mat4Multiply(vp, modMat);

            gl.uniformMatrix4fv(_modelProg.uMVP, false, mvp);
            gl.uniformMatrix4fv(_modelProg.uMod, false, modMat);
            gl.uniform3fv(_modelProg.uColor, new Float32Array(prim.baseColor));

            if (prim.vao) {
                gl.bindVertexArray(prim.vao);
            } else {
                gl.bindBuffer(gl.ARRAY_BUFFER, prim.posBuf);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
                if (prim.normBuf) {
                    gl.bindBuffer(gl.ARRAY_BUFFER, prim.normBuf);
                    gl.enableVertexAttribArray(1);
                    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
                } else {
                    gl.disableVertexAttribArray(1);
                    gl.vertexAttrib3f(1, 0, 1, 0);
                }
                if (prim.idxBuf) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, prim.idxBuf);
            }

            if (prim.idxBuf)
                gl.drawElements(gl.TRIANGLES, prim.idxCount, prim.idxType, 0);
            else
                gl.drawArrays(gl.TRIANGLES, 0, prim.posCount);

            if (prim.vao) gl.bindVertexArray(null);
        }
    }

    // Restore state so subsequent blit/rayMarch draws work
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
}

// ── 3D Floor Plane ────────────────────────────────────────────────────────────
// Flat checkerboard quad at y = -0.5, covering x/z ∈ [-2, 2].

let _floorProg = null;
let _floorGeo  = null;

const _FLOOR_VERT = /*glsl*/`
    precision highp float;
    attribute vec3 aPos;
    uniform mat4 uMVP;
    varying vec3 vWorldPos;
    void main() {
        vWorldPos = aPos;
        gl_Position = uMVP * vec4(aPos, 1.0);
    }
`;

const _FLOOR_FRAG = /*glsl*/`
    precision highp float;
    varying vec3 vWorldPos;
    uniform vec3 uLightDir;
    void main() {
        float cx    = floor(vWorldPos.x * 4.0 + 8.5);
        float cz    = floor(vWorldPos.z * 4.0 + 8.5);
        float check = mod(cx + cz, 2.0);
        vec3  fc    = mix(vec3(0.44, 0.32, 0.17), vec3(0.64, 0.48, 0.28), check);
        float diff  = max(dot(vec3(0.0, 1.0, 0.0), uLightDir), 0.0) * 0.75 + 0.25;
        float fade  = 1.0 - smoothstep(0.9, 2.0, length(vWorldPos.xz));
        gl_FragColor = vec4(fc * diff * fade, 1.0);
    }
`;

function _buildFloorProgram () {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, _FLOOR_VERT);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
        console.error('[floor] vert:', gl.getShaderInfoLog(vs));
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, _FLOOR_FRAG);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
        console.error('[floor] frag:', gl.getShaderInfoLog(fs));
    const prog = gl.createProgram();
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        console.error('[floor] link:', gl.getProgramInfoLog(prog));
    return {
        prog,
        uMVP:      gl.getUniformLocation(prog, 'uMVP'),
        uLightDir: gl.getUniformLocation(prog, 'uLightDir'),
    };
}

function _buildFloorGeometry () {
    const verts = new Float32Array([
        -2, -0.5, -2,
         2, -0.5, -2,
         2, -0.5,  2,
        -2, -0.5,  2,
    ]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    let vao = null;
    if (gl.createVertexArray) {
        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bindVertexArray(null);
    }
    return { vao, vbo, ibo };
}

function drawFloor () {
    if (!_floorProg) _floorProg = _buildFloorProgram();
    if (!_floorGeo)  _floorGeo  = _buildFloorGeometry();

    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const aspect = W / H;

    const { eye, fwd, up } = getCameraBasis();
    const lookAt = [eye[0]+fwd[0], eye[1]+fwd[1], eye[2]+fwd[2]];
    const view = mat4LookAt(eye, lookAt, up);
    const proj = mat4Perspective(Math.PI / 3.0, aspect, 0.1, 20.0);
    const mvp  = mat4Multiply(proj, view);

    gl.viewport(0, 0, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    gl.useProgram(_floorProg.prog);

    const lx = 0.4, ly = 0.8, lz = 0.45;
    const lLen = Math.sqrt(lx*lx + ly*ly + lz*lz);
    gl.uniform3f(_floorProg.uLightDir, lx/lLen, ly/lLen, lz/lLen);
    gl.uniformMatrix4fv(_floorProg.uMVP, false, mvp);

    if (_floorGeo.vao) {
        gl.bindVertexArray(_floorGeo.vao);
    } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, _floorGeo.vbo);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, _floorGeo.ibo);
    }

    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

    if (_floorGeo.vao) gl.bindVertexArray(null);

    // Restore state
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
}
