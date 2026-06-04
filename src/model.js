'use strict';

// ── Model + scene primitive renderer ─────────────────────────────────────────
// loadGLBModel(url, x, y, z, targetSize)  – async, load a .glb at world pos
// addMesh(positions, normals, indices, baseColor) – add a procedural mesh
// createFloor()                           – add the ground plane to the scene
// drawModels()                            – call once per frame from render()

const _models = [];
const _projectiles = [];
const _colliders = [];

let _modelProg             = null;
let _modelDepthCaptureProg = null;
let _modelScreenFBO        = null;
let _projectileTemplate = null;
let currentProjectileType = 'white';

const PROJECTILE_TYPES = {
    white: {
        modelColor: [1.0, 1.0, 1.0],
        smokeColor: [0.85, 0.85, 0.85],
    },
    red: {
        modelColor: [1.0, 0.0, 0.0],
        smokeColor: [0.95, 0.15, 0.15],
    },
    blue: {
        modelColor: [0.1, 0.3, 1.0],
        smokeColor: [0.2, 0.4, 1.0],
    },
    green: {
        modelColor: [0.1, 0.8, 0.2],
        smokeColor: [0.2, 0.9, 0.3],
    },
};

const PROJECTILE_NAMES = {
    white: 'White smoke grenade',
    red: 'Red smoke grenade',
    blue: 'Blue smoke grenade',
    green: 'Green smoke grenade',
};


// ── Shaders ───────────────────────────────────────────────────────────────────

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

// Same lighting but alpha = eye-distance, used by the depth-capture pre-pass.
const _MODEL_DEPTH_FRAG = /*glsl*/`
    precision highp float;
    varying vec3 vN;
    varying vec3 vW;
    uniform vec3 uEye;
    uniform vec3 uColor;
    void main() {
        // vec3 N = normalize(vN);
        // vec3 L = normalize(vec3(0.4, 0.8, 0.45));
        // vec3 V = normalize(uEye - vW);
        // vec3 H = normalize(L + V);
        // float diff = max(dot(N, L), 0.0) * 0.7 + 0.3;
        // float spec = pow(max(dot(N, H), 0.0), 48.0) * 0.4;
        // vec3  litColor = uColor * diff + vec3(spec);
        float depth    = length(vW - uEye);
        gl_FragColor   = vec4(0.0,0.0,0.0, depth);
    }
`;

// ── Program builder ───────────────────────────────────────────────────────────

function _buildProgram (fragSrc, label) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, _MODEL_VERT);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
        console.error(`[model] ${label} vert:`, gl.getShaderInfoLog(vs));

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fragSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
        console.error(`[model] ${label} frag:`, gl.getShaderInfoLog(fs));

    const prog = gl.createProgram();
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aNorm');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        console.error(`[model] ${label} link:`, gl.getProgramInfoLog(prog));

    return {
        prog,
        uMVP:   gl.getUniformLocation(prog, 'uMVP'),
        uMod:   gl.getUniformLocation(prog, 'uMod'),
        uEye:   gl.getUniformLocation(prog, 'uEye'),
        uColor: gl.getUniformLocation(prog, 'uColor'),
    };
}

function setProjectileType(type) {
    if (!PROJECTILE_TYPES[type]) {
        console.warn('Unknown projectile type:', type);
        return;
    }

    currentProjectileType = type;
    updateProjectileHUD();

    console.log('Projectile type:', type);
}

function updateProjectileHUD() {
    const slots = document.querySelectorAll('#hotbar .slot');

    slots.forEach(slot => {
        const type = slot.dataset.type;
        slot.classList.toggle('selected', type === currentProjectileType);
    });

    const name = document.getElementById('weapon-name');
    if (name) {
        name.textContent = PROJECTILE_NAMES[currentProjectileType] || currentProjectileType;
    }
}

// ── Primitive builder ─────────────────────────────────────────────────────────

function _buildPrimitive (pos, norm, idx, baseColor, nodeMatrix) {
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

    return { vao, posBuf, normBuf, idxBuf, idxCount, idxType,
             posCount: pos.length / 3, baseColor, nodeMatrix };
}

// ── GLB Loader ───────────────────────────────────────────────────────────────
// Basic GLB loader:
// - supports binary .glb
// - supports POSITION / NORMAL / indices
// - supports node translation / rotation / scale / matrix
// - supports material.pbrMetallicRoughness.baseColorFactor
// - does NOT support texture maps, animation, skinning

function _readAccessor(gltf, bin, accessorIndex) {
    if (accessorIndex == null) return null;

    const accessor = gltf.accessors[accessorIndex];
    const bufferView = gltf.bufferViews[accessor.bufferView];

    const componentCount = {
        SCALAR: 1,
        VEC2:   2,
        VEC3:   3,
        VEC4:   4,
        MAT4:   16,
    }[accessor.type];

    const componentSize = {
        5120: 1, // BYTE
        5121: 1, // UNSIGNED_BYTE
        5122: 2, // SHORT
        5123: 2, // UNSIGNED_SHORT
        5125: 4, // UNSIGNED_INT
        5126: 4, // FLOAT
    }[accessor.componentType];

    const TypedArray = {
        5120: Int8Array,
        5121: Uint8Array,
        5122: Int16Array,
        5123: Uint16Array,
        5125: Uint32Array,
        5126: Float32Array,
    }[accessor.componentType];

    const byteOffset =
        (bufferView.byteOffset || 0) +
        (accessor.byteOffset || 0);

    const stride = bufferView.byteStride || componentCount * componentSize;
    const packedStride = componentCount * componentSize;

    const count = accessor.count;
    const totalComponents = count * componentCount;

    // 如果資料是緊密排列，可以直接切出 TypedArray
    if (stride === packedStride) {
        return new TypedArray(
            bin.buffer,
            bin.byteOffset + byteOffset,
            totalComponents
        ).slice();
    }

    // 如果是 interleaved，需要手動拆出來
    const result = new TypedArray(totalComponents);
    const dataView = new DataView(
        bin.buffer,
        bin.byteOffset + byteOffset,
        stride * count
    );

    for (let i = 0; i < count; i++) {
        for (let c = 0; c < componentCount; c++) {
            const offset = i * stride + c * componentSize;
            const dst = i * componentCount + c;

            switch (accessor.componentType) {
                case 5120:
                    result[dst] = dataView.getInt8(offset);
                    break;
                case 5121:
                    result[dst] = dataView.getUint8(offset);
                    break;
                case 5122:
                    result[dst] = dataView.getInt16(offset, true);
                    break;
                case 5123:
                    result[dst] = dataView.getUint16(offset, true);
                    break;
                case 5125:
                    result[dst] = dataView.getUint32(offset, true);
                    break;
                case 5126:
                    result[dst] = dataView.getFloat32(offset, true);
                    break;
            }
        }
    }

    return result;
}

function _mat4Identity() {
    return new Float32Array([
        1,0,0,0,
        0,1,0,0,
        0,0,1,0,
        0,0,0,1,
    ]);
}

function _mat4FromTranslation(tx, ty, tz) {
    return new Float32Array([
        1,0,0,0,
        0,1,0,0,
        0,0,1,0,
        tx,ty,tz,1,
    ]);
}

function _mat4FromScale(sx, sy, sz) {
    return new Float32Array([
        sx,0,0,0,
        0,sy,0,0,
        0,0,sz,0,
        0,0,0,1,
    ]);
}

function _mat4FromQuaternion(x, y, z, w) {
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;

    const xy = x * y;
    const xz = x * z;
    const yz = y * z;

    const wx = w * x;
    const wy = w * y;
    const wz = w * z;

    return new Float32Array([
        1 - 2 * (yy + zz), 2 * (xy + wz),     2 * (xz - wy),     0,
        2 * (xy - wz),     1 - 2 * (xx + zz), 2 * (yz + wx),     0,
        2 * (xz + wy),     2 * (yz - wx),     1 - 2 * (xx + yy), 0,
        0,                 0,                 0,                 1,
    ]);
}

function _nodeLocalMatrix(node) {
    if (node.matrix) {
        return new Float32Array(node.matrix);
    }

    const t = node.translation || [0, 0, 0];
    const r = node.rotation || [0, 0, 0, 1];
    const s = node.scale || [1, 1, 1];

    const T = _mat4FromTranslation(t[0], t[1], t[2]);
    const R = _mat4FromQuaternion(r[0], r[1], r[2], r[3]);
    const S = _mat4FromScale(s[0], s[1], s[2]);

    return mat4Multiply(mat4Multiply(T, R), S);
}

function _getMaterialColor(gltf, materialIndex) {
    if (materialIndex == null || !gltf.materials) {
        return [0.65, 0.70, 0.80];
    }

    const mat = gltf.materials[materialIndex];
    const pbr = mat && mat.pbrMetallicRoughness;

    if (pbr && pbr.baseColorFactor) {
        return pbr.baseColorFactor.slice(0, 3);
    }

    return [0.65, 0.70, 0.80];
}

function _computeAccessorBounds(gltf) {
    let minX =  Infinity;
    let minY =  Infinity;
    let minZ =  Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    if (!gltf.meshes) {
        return {
            min: [-0.5, -0.5, -0.5],
            max: [ 0.5,  0.5,  0.5],
        };
    }

    for (const mesh of gltf.meshes) {
        for (const prim of mesh.primitives || []) {
            const posIndex = prim.attributes && prim.attributes.POSITION;
            if (posIndex == null) continue;

            const accessor = gltf.accessors[posIndex];

            if (!accessor.min || !accessor.max) continue;

            minX = Math.min(minX, accessor.min[0]);
            minY = Math.min(minY, accessor.min[1]);
            minZ = Math.min(minZ, accessor.min[2]);

            maxX = Math.max(maxX, accessor.max[0]);
            maxY = Math.max(maxY, accessor.max[1]);
            maxZ = Math.max(maxZ, accessor.max[2]);
        }
    }

    if (!isFinite(minX)) {
        return {
            min: [-0.5, -0.5, -0.5],
            max: [ 0.5,  0.5,  0.5],
        };
    }

    return {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
    };
}

function _uploadGLBMesh(gltf, bin, meshIndex, nodeMatrix, primitivesOut) {
    const mesh = gltf.meshes[meshIndex];
    if (!mesh) return;

    for (const prim of mesh.primitives || []) {
        const attrs = prim.attributes || {};

        if (attrs.POSITION == null) {
            continue;
        }

        const positions = _readAccessor(gltf, bin, attrs.POSITION);
        let normals = _readAccessor(gltf, bin, attrs.NORMAL);
        const indices = _readAccessor(gltf, bin, prim.indices);

        // 沒有 normal 的話給一個預設 normal，避免 shader attribute 壞掉
        if (!normals) {
            normals = new Float32Array(positions.length);
            for (let i = 0; i < normals.length; i += 3) {
                normals[i + 0] = 0;
                normals[i + 1] = 1;
                normals[i + 2] = 0;
            }
        }

        const baseColor = _getMaterialColor(gltf, prim.material);

        primitivesOut.push(
            _buildPrimitive(
                positions,
                normals,
                indices,
                baseColor,
                nodeMatrix
            )
        );
    }
}

function _traverseGLBNode(gltf, bin, nodeIndex, parentMatrix, primitivesOut) {
    const node = gltf.nodes[nodeIndex];
    if (!node) return;

    const localMatrix = _nodeLocalMatrix(node);
    const worldMatrix = mat4Multiply(parentMatrix, localMatrix);

    if (node.mesh != null) {
        _uploadGLBMesh(gltf, bin, node.mesh, worldMatrix, primitivesOut);
    }

    for (const child of node.children || []) {
        _traverseGLBNode(gltf, bin, child, worldMatrix, primitivesOut);
    }
}

async function loadGLBModel(url, x = 0, y = 0, z = 0, targetSize = 1.0, addToScene = true) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`[loadGLBModel] Failed to fetch ${url}: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const dataView = new DataView(arrayBuffer);

    const magic = dataView.getUint32(0, true);
    const version = dataView.getUint32(4, true);

    if (magic !== 0x46546C67) {
        throw new Error('[loadGLBModel] Invalid GLB: bad magic');
    }

    if (version !== 2) {
        throw new Error(`[loadGLBModel] Unsupported GLB version: ${version}`);
    }

    let offset = 12;

    let json = null;
    let bin = null;

    while (offset < arrayBuffer.byteLength) {
        const chunkLength = dataView.getUint32(offset, true);
        const chunkType = dataView.getUint32(offset + 4, true);
        offset += 8;

        const chunkData = new Uint8Array(arrayBuffer, offset, chunkLength);

        // JSON chunk: 0x4E4F534A = "JSON"
        if (chunkType === 0x4E4F534A) {
            const jsonText = new TextDecoder().decode(chunkData);
            json = JSON.parse(jsonText);
        }

        // BIN chunk: 0x004E4942 = "BIN"
        if (chunkType === 0x004E4942) {
            bin = chunkData;
        }

        offset += chunkLength;
    }

    if (!json) {
        throw new Error('[loadGLBModel] GLB has no JSON chunk');
    }

    if (!bin) {
        throw new Error('[loadGLBModel] GLB has no BIN chunk');
    }

    const primitives = [];
    const identity = _mat4Identity();

    const sceneIndex = json.scene != null ? json.scene : 0;
    const scene = json.scenes && json.scenes[sceneIndex];

    if (scene && scene.nodes) {
        for (const nodeIndex of scene.nodes) {
            _traverseGLBNode(json, bin, nodeIndex, identity, primitives);
        }
    } else if (json.nodes) {
        for (let i = 0; i < json.nodes.length; i++) {
            _traverseGLBNode(json, bin, i, identity, primitives);
        }
    } else if (json.meshes) {
        for (let i = 0; i < json.meshes.length; i++) {
            _uploadGLBMesh(json, bin, i, identity, primitives);
        }
    }

    const bounds = _computeAccessorBounds(json);

    const sizeX = bounds.max[0] - bounds.min[0];
    const sizeY = bounds.max[1] - bounds.min[1];
    const sizeZ = bounds.max[2] - bounds.min[2];

    const maxDim = Math.max(sizeX, sizeY, sizeZ) || 1.0;

    const center = [
        (bounds.min[0] + bounds.max[0]) * 0.5,
        (bounds.min[1] + bounds.max[1]) * 0.5,
        (bounds.min[2] + bounds.max[2]) * 0.5,
    ];

    const scale = targetSize / maxDim;

    const model = {
        primitives,
        position: [x, y, z],
        scale,
        center,
    };

    if (addToScene) {
        _models.push(model);
    }

    console.log(
        `[loadGLBModel] Loaded ${url}: ` +
        `${primitives.length} primitives, ` +
        `scale=${scale.toFixed(4)}, ` +
        `position=(${x}, ${y}, ${z})`
    );

    return model;
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
    if (acc.componentType === 5123) return new Uint16Array(bin.buffer.slice(base, base + count * 2));
    if (acc.componentType === 5125) return new Uint32Array(bin.buffer.slice(base, base + count * 4));
    if (acc.componentType === 5121) return new Uint8Array(bin.buffer.slice(base, base + count));
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

        let baseColor = [0.65, 0.70, 0.80];
        if (prim.material != null && gltf.materials) {
            const mat = gltf.materials[prim.material];
            const pbr = mat && mat.pbrMetallicRoughness;
            if (pbr && pbr.baseColorFactor) baseColor = pbr.baseColorFactor.slice(0, 3);
        }

        out.push(_buildPrimitive(pos, norm, idx, baseColor, nodeMatrix));
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

// async function loadGLBModel (url, x, y, z, targetSize) {
//     const resp = await fetch(url);
//     if (!resp.ok) throw new Error(`[model] fetch failed ${resp.status}: ${url}`);
//     const buf = await resp.arrayBuffer();
//     const dv  = new DataView(buf);

//     if (dv.getUint32(0, true) !== 0x46546C67)
//         throw new Error('[model] Not a valid GLB (bad magic)');

//     const jsonLen  = dv.getUint32(12, true);
//     const jsonText = new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen));
//     const gltf     = JSON.parse(jsonText);

//     const binBase = 20 + jsonLen;
//     const binLen  = dv.getUint32(binBase, true);
//     const bin     = new Uint8Array(buf, binBase + 8, binLen);

//     const primitives = [];
//     const identity   = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

//     const sceneIdx  = gltf.scene != null ? gltf.scene : 0;
//     const rootNodes = (gltf.scenes && gltf.scenes[sceneIdx])
//                       ? (gltf.scenes[sceneIdx].nodes || []) : [];

//     if (rootNodes.length > 0 && gltf.nodes) {
//         for (const ni of rootNodes) _traverseNode(gltf, bin, ni, identity, primitives);
//     } else if (gltf.nodes) {
//         for (let ni = 0; ni < gltf.nodes.length; ni++)
//             _traverseNode(gltf, bin, ni, identity, primitives);
//     } else if (gltf.meshes) {
//         for (let mi = 0; mi < gltf.meshes.length; mi++)
//             _uploadMesh(gltf, bin, mi, identity, primitives);
//     }

//     // Bounding box from accessor min/max (GLTF spec guarantees these for POSITION)
//     let minX =  Infinity, minY =  Infinity, minZ =  Infinity;
//     let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
//     for (const mesh of (gltf.meshes || [])) {
//         for (const prim of (mesh.primitives || [])) {
//             const ai = prim.attributes && prim.attributes.POSITION;
//             if (ai == null) continue;
//             const acc = gltf.accessors[ai];
//             if (acc.min && acc.max) {
//                 minX = Math.min(minX, acc.min[0]); maxX = Math.max(maxX, acc.max[0]);
//                 minY = Math.min(minY, acc.min[1]); maxY = Math.max(maxY, acc.max[1]);
//                 minZ = Math.min(minZ, acc.min[2]); maxZ = Math.max(maxZ, acc.max[2]);
//             }
//         }
//     }

//     const maxDim = Math.max(maxX-minX, maxY-minY, maxZ-minZ) || 1;
//     const center = [(minX+maxX)/2, (minY+maxY)/2, (minZ+maxZ)/2];
//     const scale  = (targetSize != null ? targetSize : 1.5) / maxDim;

//     _models.push({ primitives, position: [x, y, z], scale, center });
//     console.log(`[model] Loaded ${url}: ${primitives.length} primitives, ` +
//                 `scale=${scale.toFixed(4)}, worldPos=(${x},${y},${z})`);
// }

// Add a procedural mesh directly to the scene (geometry in world space).
// positions: Float32Array (3 floats/vertex), normals: Float32Array or null,
// indices: Uint16Array/Uint32Array or null, baseColor: [r, g, b].
function addMesh (positions, normals, indices, baseColor) {
    const identity = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    const prim = _buildPrimitive(positions, normals, indices, baseColor, identity);
    _models.push({ primitives: [prim], position: [0, 0, 0], scale: 1, center: [0, 0, 0] });
}

function _createBoxMesh (cx, cy, cz, width, height, depth, color) {
    const hx = width  * 0.5;
    const hy = height * 0.5;
    const hz = depth  * 0.5;

    const positions = new Float32Array([
        -hx, -hy,  hz,   hx, -hy,  hz,   hx,  hy,  hz,  -hx,  hy,  hz,
         hx, -hy, -hz,  -hx, -hy, -hz,  -hx,  hy, -hz,   hx,  hy, -hz,
         hx, -hy,  hz,   hx, -hy, -hz,   hx,  hy, -hz,   hx,  hy,  hz,
        -hx, -hy, -hz,  -hx, -hy,  hz,  -hx,  hy,  hz,  -hx,  hy, -hz,
        -hx,  hy,  hz,   hx,  hy,  hz,   hx,  hy, -hz,  -hx,  hy, -hz,
        -hx, -hy, -hz,   hx, -hy, -hz,   hx, -hy,  hz,  -hx, -hy,  hz
    ]);

    for (let i = 0; i < positions.length; i += 3) {
        positions[i]   += cx;
        positions[i+1] += cy;
        positions[i+2] += cz;
    }

    const normals = new Float32Array([
        0, 0, 1,   0, 0, 1,   0, 0, 1,   0, 0, 1,
        0, 0,-1,   0, 0,-1,   0, 0,-1,   0, 0,-1,
        1, 0, 0,   1, 0, 0,   1, 0, 0,   1, 0, 0,
       -1, 0, 0,  -1, 0, 0,  -1, 0, 0,  -1, 0, 0,
        0, 1, 0,   0, 1, 0,   0, 1, 0,   0, 1, 0,
        0,-1, 0,   0,-1, 0,   0,-1, 0,   0,-1, 0
    ]);

    const indices = new Uint16Array([
         0,  1,  2,   0,  2,  3,
         4,  5,  6,   4,  6,  7,
         8,  9, 10,   8, 10, 11,
        12, 13, 14,  12, 14, 15,
        16, 17, 18,  16, 18, 19,
        20, 21, 22,  20, 22, 23
    ]);

    addMesh(positions, normals, indices, color);
}

function createFloor () {
    _createBoxMesh(0, -3.0, 12, 16.0, 0.1, 16.0, [0.18, 0.20, 0.24]);
}

function createBox (x, y, z, width, height, depth, color, isCollider = true) {
    _createBoxMesh(x, y, z, width, height, depth, color);

    if (isCollider) {
        _colliders.push({
            type: 'box',
            min: [
                x - width  * 0.5,
                y - height * 0.5,
                z - depth  * 0.5,
            ],
            max: [
                x + width  * 0.5,
                y + height * 0.5,
                z + depth  * 0.5,
            ],
            center: [x, y, z],
            size: [width, height, depth],
        });
    }
}
function segmentAABBIntersection(p0, p1, box) {
    let tMin = 0.0;
    let tMax = 1.0;

    const d = [
        p1[0] - p0[0],
        p1[1] - p0[1],
        p1[2] - p0[2],
    ];

    for (let i = 0; i < 3; i++) {
        if (Math.abs(d[i]) < 1e-8) {
            // 線段幾乎平行於這個軸
            if (p0[i] < box.min[i] || p0[i] > box.max[i]) {
                return null;
            }
        } else {
            const invD = 1.0 / d[i];
            let t1 = (box.min[i] - p0[i]) * invD;
            let t2 = (box.max[i] - p0[i]) * invD;

            if (t1 > t2) {
                const tmp = t1;
                t1 = t2;
                t2 = tmp;
            }

            tMin = Math.max(tMin, t1);
            tMax = Math.min(tMax, t2);

            if (tMin > tMax) {
                return null;
            }
        }
    }

    return {
        t: tMin,
        position: [
            p0[0] + d[0] * tMin,
            p0[1] + d[1] * tMin,
            p0[2] + d[2] * tMin,
        ],
    };
}
const VOLUME_CENTER = [0.0, -2.0, 12.0];

function worldToVolumeUVW(pos) {
    const r = config.BOX_RADIUS;

    return [
        (pos[0] - VOLUME_CENTER[0]) / (2.0 * r) + 0.5,
        (pos[1] - VOLUME_CENTER[1]) / (2.0 * r) + 0.5,
        (pos[2] - VOLUME_CENTER[2]) / (2.0 * r) + 0.5,
    ];
}

function onProjectileHit(position, collider, projectile) {
    console.log('Projectile hit at:', position, collider);

    const uvw = worldToVolumeUVW(position);

    if (
        uvw[0] < 0 || uvw[0] > 1 ||
        uvw[1] < 0 || uvw[1] > 1 ||
        uvw[2] < 0 || uvw[2] > 1
    ) {
        console.warn('Hit outside smoke volume:', uvw);
        return;
    }

    const smoke = projectile.smokeColor || [0.85, 0.85, 0.85];
    console.log('Projectile smoke color:', smoke);
    const velocity = projectile.velocity || [0, 0, 0];

    const len = Math.hypot(velocity[0], velocity[1], velocity[2]) || 1.0;
    const vx = velocity[0] / len;
    const vy = velocity[1] / len;
    const vz = velocity[2] / len;

    // 彩色煙霧
    splat3D(
        uvw[0], uvw[1], uvw[2],
        smoke[0], smoke[1], smoke[2],
        0.006,
        density
    );

    // 熱量，讓煙往上飄；這個不用跟顏色一樣
    splat3D(
        uvw[0], uvw[1], uvw[2],
        0.35, 0.35, 0.35,
        0.006,
        temperature
    );

    // 撞擊衝擊速度
    splat3D(
        uvw[0], uvw[1], uvw[2],
        vx * 0.4, vy * 0.4, vz * 0.4,
        0.006,
        velocity3D
    );
}

function createSceneGeometry () {
    createFloor();
    createBox( 2.0, -2.0, 12.0, 2.0, 2.0, 2.0, [0.84, 0.35, 0.22]);
    createBox(-3.0, -2.25, 14.0, 1.5, 1.5, 1.5, [0.28, 0.78, 0.82]);
    createBox( 0.0, -2.5,  8.0, 1.0, 1.0, 1.0, [0.75, 0.72, 0.36]);
    createBox( 0.0, -1.0,  8.0, 8.0, 4.0, 0.2, [0.32, 0.35, 0.38]);
    createBox( 0.0, -1.0, 16.0, 8.0, 4.0, 0.2, [0.32, 0.35, 0.38]);
    createBox(-8.0, -1.0, 12.0, 0.2, 4.0, 16.0, [0.32, 0.35, 0.38]);
    createBox( 8.0, -1.0, 12.0, 0.2, 4.0, 16.0, [0.32, 0.35, 0.38]);
}

// ── Per-frame helpers ─────────────────────────────────────────────────────────

function _mat4T (tx, ty, tz) {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, tx,ty,tz,1]);
}
function _mat4S (s) {
    return new Float32Array([s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1]);
}
function createProjectileBox(x, y, z, vx, vy, vz, type = 'white') {
    const cfg = PROJECTILE_TYPES[type] || PROJECTILE_TYPES.white;

    const size = 0.25;
    const hx = size * 0.5;
    const hy = size * 0.5;
    const hz = size * 0.5;

    const positions = new Float32Array([
        -hx, -hy,  hz,   hx, -hy,  hz,   hx,  hy,  hz,  -hx,  hy,  hz,
         hx, -hy, -hz,  -hx, -hy, -hz,  -hx,  hy, -hz,   hx,  hy, -hz,
         hx, -hy,  hz,   hx, -hy, -hz,   hx,  hy, -hz,   hx,  hy,  hz,
        -hx, -hy, -hz,  -hx, -hy,  hz,  -hx,  hy,  hz,  -hx,  hy, -hz,
        -hx,  hy,  hz,   hx,  hy,  hz,   hx,  hy, -hz,  -hx,  hy, -hz,
        -hx, -hy, -hz,   hx, -hy, -hz,   hx, -hy,  hz,  -hx, -hy,  hz
    ]);

    const normals = new Float32Array([
        0, 0, 1,   0, 0, 1,   0, 0, 1,   0, 0, 1,
        0, 0,-1,   0, 0,-1,   0, 0,-1,   0, 0,-1,
        1, 0, 0,   1, 0, 0,   1, 0, 0,   1, 0, 0,
       -1, 0, 0,  -1, 0, 0,  -1, 0, 0,  -1, 0, 0,
        0, 1, 0,   0, 1, 0,   0, 1, 0,   0, 1, 0,
        0,-1, 0,   0,-1, 0,   0,-1, 0,   0,-1, 0
    ]);

    const indices = new Uint16Array([
         0,  1,  2,   0,  2,  3,
         4,  5,  6,   4,  6,  7,
         8,  9, 10,   8, 10, 11,
        12, 13, 14,  12, 14, 15,
        16, 17, 18,  16, 18, 19,
        20, 21, 22,  20, 22, 23
    ]);

    const identity = new Float32Array([
        1,0,0,0,
        0,1,0,0,
        0,0,1,0,
        0,0,0,1
    ]);

    const prim = _buildPrimitive(
        positions,
        normals,
        indices,
        cfg.modelColor,
        identity
    );

    const projectile = {
        primitives: [prim],
        position: [x, y, z],
        scale: 1,
        center: [0, 0, 0],

        velocity: [vx, vy, vz],
        life: 5.0,
        age: 0.0,
        trailTimer: 0.0,

        type: type,
        smokeColor: cfg.smokeColor,
    };

    _models.push(projectile);
    _projectiles.push(projectile);
}

function updateProjectiles(dt) {
    const gravity = -3.0;

    for (let i = _projectiles.length - 1; i >= 0; i--) {
        const p = _projectiles[i];

        const oldPos = [
            p.position[0],
            p.position[1],
            p.position[2],
        ];

        // 更新速度
        p.velocity[1] += gravity * dt;

        const newPos = [
            p.position[0] + p.velocity[0] * dt,
            p.position[1] + p.velocity[1] * dt,
            p.position[2] + p.velocity[2] * dt,
        ];

        // 找最近的碰撞點
        let nearestHit = null;
        let nearestCollider = null;

        for (const collider of _colliders) {
            const hit = segmentAABBIntersection(oldPos, newPos, collider);

            if (hit && (!nearestHit || hit.t < nearestHit.t)) {
                nearestHit = hit;
                nearestCollider = collider;
            }
        }

        if (nearestHit) {
            // 回傳接觸位置
            onProjectileHit(nearestHit.position, nearestCollider, p);

            // 從 _models 移除
            const modelIndex = _models.indexOf(p);
            if (modelIndex >= 0) {
                _models.splice(modelIndex, 1);
            }

            // 從 _projectiles 移除
            _projectiles.splice(i, 1);

            continue;
        }

        // 沒撞到才更新位置
        p.position[0] = newPos[0];
        p.position[1] = newPos[1];
        p.position[2] = newPos[2];
        
        p.age += dt;
        //emitProjectileTrail(p, dt);

        p.life -= dt;

        if (p.life <= 0) {
            const modelIndex = _models.indexOf(p);
            if (modelIndex >= 0) {
                _models.splice(modelIndex, 1);
            }

            _projectiles.splice(i, 1);
        }
    }
}
// Render every primitive in _models with the supplied program + VP matrix.
// The program's uEye uniform must already be set before calling this.
function _drawAllPrimitives (prog, vp) {
    for (const model of _models) {
        const worldXform = mat4Multiply(
            _mat4T(...model.position),
            mat4Multiply(_mat4S(model.scale), _mat4T(-model.center[0], -model.center[1], -model.center[2]))
        );
        for (const prim of model.primitives) {
            const modMat = mat4Multiply(worldXform, prim.nodeMatrix);
            const mvp    = mat4Multiply(vp, modMat);

            gl.uniformMatrix4fv(prog.uMVP, false, mvp);
            gl.uniformMatrix4fv(prog.uMod, false, modMat);
            gl.uniform3fv(prog.uColor, new Float32Array(prim.baseColor));

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
}

// ── Per-frame draw ────────────────────────────────────────────────────────────

function drawModels () {
    if (_models.length === 0) return;
    if (!_modelProg) _modelProg = _buildProgram(_MODEL_FRAG, 'model');

    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const { eye, fwd, right, up } = getCameraBasis();
    const lookAt = [eye[0]+fwd[0], eye[1]+fwd[1], eye[2]+fwd[2]];
    const view   = mat4LookAt(eye, lookAt, up);
    const proj   = mat4Perspective(config.CAMERA_FOV * Math.PI / 180, W / H, 0.1, 20.0);
    const vp     = mat4Multiply(proj, view);
    // const vp = proj;
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
    _drawAllPrimitives(_modelProg, vp);

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
}

// ── Model depth capture ───────────────────────────────────────────────────────
// Renders all primitives into _modelScreenFBO: RGB = lit colour, A = eye-distance.
// A cleared pixel (alpha = 0) means no solid surface — ray marching passes freely.

function initModelDepthBuffer () {
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    // if (_modelScreenFBO && _modelScreenFBO.width === W && _modelScreenFBO.height === H) return;

    if (!_modelDepthCaptureProg)
        _modelDepthCaptureProg = _buildProgram(_MODEL_DEPTH_FRAG, 'depth');

// initModelDepthBuffer() 裡加：
    const depthRB = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRB);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, W, H);

    if (_modelScreenFBO) {
        gl.deleteFramebuffer(_modelScreenFBO.fbo);
        gl.deleteTexture(_modelScreenFBO.texture);
        // gl.deleteRenderbuffer(_modelScreenFBO.depthRB);
    }

    const rgba = ext.formatRGBA, texType = ext.halfFloatTexType;
    gl.activeTexture(gl.TEXTURE0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,  gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER,  gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, rgba.internalFormat, W, H, 0, rgba.format, texType, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRB);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) console.error('[depth FBO] incomplete:', status.toString(16));

    _modelScreenFBO = {
        fbo, texture, width: W, height: H,
        attach (id) {
            gl.activeTexture(gl.TEXTURE0 + id);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return id;
        }
    };
}


// function drawModelDepthCapture () {
//     initModelDepthBuffer();

//     const { eye, fwd, right, up } = getCameraBasis();
//     const W = _modelScreenFBO.width, H = _modelScreenFBO.height;
//     const lookAt = [eye[0]+fwd[0], eye[1]+fwd[1], eye[2]+fwd[2]];
//     const view   = mat4LookAt(eye, lookAt, up);
//     const proj   = mat4Perspective(config.CAMERA_FOV * Math.PI / 180, W / H, 0.1, 20.0);
//     const vp     = mat4Multiply(proj, view);

//     gl.bindFramebuffer(gl.FRAMEBUFFER, _modelScreenFBO.fbo);
//     gl.viewport(0, 0, W, H);
//     gl.clearColor(0.0, 0.0, 0.0, 0.0);  // A=0 → no solid surface
//     gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
//     gl.enable(gl.DEPTH_TEST);
//     gl.depthFunc(gl.LEQUAL);
//     gl.depthMask(true);
//     // gl.enable(gl.CULL_FACE);
//     // gl.cullFace(gl.BACK);
//     gl.disable(gl.BLEND);

//     if (_models.length > 0) {
//         gl.useProgram(_modelDepthCaptureProg.prog);
//         gl.uniform3fv(_modelDepthCaptureProg.uEye, new Float32Array(eye));
//         _drawAllPrimitives(_modelDepthCaptureProg, vp);
//     }

//     gl.bindFramebuffer(gl.FRAMEBUFFER, null);
//     gl.disable(gl.DEPTH_TEST);
//     gl.depthMask(false);
//     gl.disable(gl.CULL_FACE);
//     gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
//     gl.enable(gl.BLEND);
// }



function drawModelDepthCapture () {
    initModelDepthBuffer();

    const { eye, fwd, right, up } = getCameraBasis();
    const W = _modelScreenFBO.width, H = _modelScreenFBO.height;
    const lookAt = [eye[0]+fwd[0], eye[1]+fwd[1], eye[2]+fwd[2]];
    const view   = mat4LookAt(eye, lookAt, up);
    const proj   = mat4Perspective(config.CAMERA_FOV * Math.PI / 180, W / H, 0.1, 20.0);
    const vp     = mat4Multiply(proj, view);

    gl.bindFramebuffer(gl.FRAMEBUFFER, _modelScreenFBO.fbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);  // A=0 → no solid surface
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);

    if (_models.length > 0) {
        gl.useProgram(_modelDepthCaptureProg.prog);
        gl.uniform3fv(_modelDepthCaptureProg.uEye, new Float32Array(eye));
        _drawAllPrimitives(_modelDepthCaptureProg, vp);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
}

async function loadProjectileTemplate(url) {
    _projectileTemplate = await loadGLBModel(
        url,
        0, 0, 0,
        0.35,
        false
    );

    console.log('Projectile template loaded:', url);
}

function createProjectileModel(x, y, z, vx, vy, vz, type = 'white') {
    if (!_projectileTemplate) {
        console.warn('Projectile template not loaded yet.');
        return;
    }

    const cfg = PROJECTILE_TYPES[type] || PROJECTILE_TYPES.white;

    const projectilePrimitives = _projectileTemplate.primitives.map(prim => ({
        ...prim,
        baseColor: cfg.modelColor,
    }));

    const projectile = {
        primitives: projectilePrimitives,
        position: [x, y, z],
        scale: _projectileTemplate.scale,
        center: _projectileTemplate.center,

        velocity: [vx, vy, vz],
        life: 5.0,
        age: 0.0,
        trailTimer: 0.0,

        type: type,
        smokeColor: cfg.smokeColor,
    };

    _models.push(projectile);
    _projectiles.push(projectile);
}
function emitProjectileTrail(p, dt) {
    p.trailTimer += dt;

    // 太靠近相機 / 剛發射時，不噴煙
    if (p.age < 0.15) return;

    // 不要每幀都噴，否則太濃
    if (p.trailTimer < 0.04) return;
    p.trailTimer = 0.0;

    const { eye } = getCameraBasis();

    const dx = p.position[0] - eye[0];
    const dy = p.position[1] - eye[1];
    const dz = p.position[2] - eye[2];
    const distToCamera = Math.hypot(dx, dy, dz);

    // 距離相機太近，不噴煙
    if (distToCamera < 1.2) return;

    const uvw = worldToVolumeUVW(p.position);

    if (
        uvw[0] < 0 || uvw[0] > 1 ||
        uvw[1] < 0 || uvw[1] > 1 ||
        uvw[2] < 0 || uvw[2] > 1
    ) {
        return;
    }

    // 尾煙要很淡，不然會擋視線
    splat3D(
        uvw[0], uvw[1], uvw[2],
        0.06, 0.06, 0.06,
        0.0008,
        density
    );
}
function getModelScreenFBO () { return _modelScreenFBO; }