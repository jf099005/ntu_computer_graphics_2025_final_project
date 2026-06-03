# WebGL 烟雾渲染程序 - 初始化与维护管道分析

## 一、概述

这是一个基于WebGL的**3D流体模拟系统**，用于实时渲染写实的烟雾效果。整个系统包括三个主要部分：
- **初始化阶段**：设置WebGL环境、着色器、数据结构
- **模拟管道**：每帧计算流体物理
- **渲染管道**：通过体积光线追踪显示烟雾

---

## 二、初始化阶段详解

### 2.1 启动序列

```
HTML加载 → 脚本加载 → getWebGLContext() → startGUI() → initShaders() 
→ 初始化着色器程序 → initFramebuffers() → initSmoke() → update()循环开始
```

### 2.2 WebGL上下文初始化（webgl-utils.js）

```javascript
getWebGLContext(canvas)
```

**目的**：获取WebGL环境并检测浏览器支持的功能

**关键步骤**：

1. **选择WebGL版本**
   ```
   优先使用WebGL 2.0 → 降级到WebGL 1.0 → 使用experimental-webgl
   ```
   - WebGL 2.0 支持半精度浮点（HALF_FLOAT）和更丰富的纹理格式
   - WebGL 1.0 需要通过扩展（extensions）实现相同功能

2. **纹理格式协商**
   - 检测半精度浮点数支持（OES_texture_half_float）
   - 检测线性过滤支持（OES_texture_half_float_linear）
   - 尝试格式降级：R16F → RG16F → RGBA16F
   
   **为什么用半精度浮点？**
   - 节省显存（16位 vs 32位）
   - 提高性能（更快的纹理读写）
   - 对流体模拟精度足够

### 2.3 着色器编译（shaders.js）

关键着色器类型：

| 着色器 | 用途 | 执行在 |
|--------|-----|--------|
| Base Vertex Shader | 标准顶点处理 | CPU → GPU |
| Display Vertex Shader | 应用摄像机矩阵 | 对最终输出应用轨道摄像机 |
| 各种Fragment Shaders | 流体模拟计算 | GPU着色器单元 |

**示例：基础顶点着色器**
```glsl
precision highp float;

attribute vec2 aPosition;        // 全屏四边形坐标
varying vec2 vUv;               // 归一化纹理坐标 [0,1]²
varying vec2 vL, vR, vT, vB;    // 邻近采样坐标
uniform vec2 texelSize;          // 1/分辨率

void main () {
    vUv = aPosition * 0.5 + 0.5;  // 从 [-1,1] 映射到 [0,1]
    // 预计算邻近像素坐标，供片段着色器使用
    vL = vUv - vec2(texelSize.x, 0.0);  // 左邻近
    vR = vUv + vec2(texelSize.x, 0.0);  // 右邻近
    vT = vUv + vec2(0.0, texelSize.y);  // 上邻近
    vB = vUv - vec2(0.0, texelSize.y);  // 下邻近
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
```

### 2.4 双缓冲区系统（webgl-utils.js）

#### 创建双缓冲FBO
```javascript
function createDoubleFBO(w, h, internalFormat, format, type, param)
```

**结构**：两个FBO（帧缓冲对象）成对使用
```
┌─────────────────────────────────────┐
│         双缓冲区对象                  │
├─────────────────────────────────────┤
│  fbo1 (read)   ←→   fbo2 (write)    │
│                                     │
│  每个包含：                          │
│  - GPU纹理（512×512）              │
│  - 帧缓冲对象                       │
│  - 元数据（宽高、texelSize）        │
└─────────────────────────────────────┘
```

**为什么需要双缓冲？**

在GPU计算中，不能同时从一个纹理读取又写入。双缓冲通过"乒乓"策略解决：
```
第1步：从纹理A读取 → 计算 → 写入纹理B
       swap()交换指针
第2步：从纹理B读取 → 计算 → 写入纹理A
```

### 2.5 3D体积数据存储（AtlasTexture）

本程序用一个512×512的2D纹理表示64³的3D体积：

```
物理体积：64³ = 262,144个体素
存储方式：512×512 = 262,144个像素（完美适配！）

展开方式：8×8网格，每个64×64格子代表一个z切片
┌────┬────┬────┬────┬────┬────┬────┬────┐
│z=0 │z=1 │z=2 │z=3 │z=4 │z=5 │z=6 │z=7 │
├────┼────┼────┼────┼────┼────┼────┼────┤
│z=8 │z=9 │... │    │    │    │    │    │
├────┴────┴────┴────┴────┴────┴────┴────┤
│         (继续7行)                      │
└─────────────────────────────────────────┘

每个像素坐标(u,v)映射到3D位置(x,y,z)：
  sliceX = floor(u / 64) * 64
  sliceY = floor(v / 64) * 64
  z_slice = (floor(u/64) + floor(v/64)*8)
```

#### 存储的字段

| 字段 | 格式 | 用途 | 大小 |
|-----|------|------|------|
| density | RGBA | RGB=烟雾颜色, A=不用 | 4字节/像素 |
| velocity3D | RGBA | RGB=XYZ速度, A=不用 | 4字节/像素 |
| temperature | R | 温度（驱动浮力） | 2字节/像素 |
| divergence3D | R | 速度散度 | 2字节/像素 |
| curl3D | RGBA | 速度旋度向量 | 4字节/像素 |
| pressure3D | R | 压力场 | 2字节/像素（双缓冲） |

### 2.6 渲染程序初始化（script.js）

创建程序对象管理GPU着色器对：
```javascript
const advection3DProgram = new Program(baseVertexShader, advection3DShader);
const divergence3DProgram = new Program(baseVertexShader, divergence3DShader);
const pressure3DProgram = new Program(baseVertexShader, pressure3DShader);
const rayMarchProgram = new Program(baseVertexShader, rayMarchShader);
// ... 更多程序
```

每个`Program`对象包含：
- 编译的着色器对
- 统一变量（uniform）位置映射
- `bind()` 方法激活程序

### 2.7 初始烟雾注入（simulation.js）

```javascript
function initSmoke() {
    EMITTERS.forEach(e => {
        // 注入密度：RGB各为0.15
        splat3D(e.x, e.y, e.z, 0.15, 0.15, 0.15, 
                EMIT_RADIUS*4.0, density);
        
        // 注入温度：R为0.8（2倍的EMIT_TEMPERATURE）
        splat3D(e.x, e.y, e.z, 0.8, 0.0, 0.0,
                EMIT_RADIUS*4.0, temperature);
        
        // 注入初始速度：向上的Y速度
        splat3D(e.x, e.y, e.z, 0.0, 0.7, 0.0,
                EMIT_RADIUS*4.0, velocity3D);
    });
}
```

**Splat操作**（"涂抹"一个高斯斑点）：
```
GPU操作：
1. 绑定splat3DProgram
2. 设置uniform：位置、颜色、半径σ²
3. 渲染全屏四边形
4. Fragment shader计算每个像素的高斯函数值并累加
5. 交换读/写缓冲
```

---

## 三、每帧模拟管道

### 3.1 主循环流程

```javascript
function update() {
    const dt = calcDeltaTime();      // 计算时间步
    if (resizeCanvas()) 
        initFramebuffers();           // 窗口大小改变时重新分配
    if (!config.PAUSED) {
        emitSmoke();                  // 持续喷烟雾
        step(dt);                     // 物理模拟
    }
    render(null);                     // 光线追踪渲染
    requestAnimationFrame(update);   // 递归调用
}
```

### 3.2 时间步计算

```javascript
function calcDeltaTime() {
    let now = Date.now();
    let dt = (now - lastUpdateTime) / 1000;  // 转换为秒
    dt = Math.min(dt, 0.016666);             // 限制为最多60 FPS的步长
    lastUpdateTime = now;
    return dt;
}
```

**目的**：防止大的时间步造成数值不稳定

### 3.3 物理模拟步骤（step函数）

#### 阶段1：浮力（Buoyancy）

```glsl
// 伪代码
velocity += (buoyancy * temperature - weight * density) * dt
```

**物理意义**：
- 热烟往上升（buoyancy项）
- 密集烟往下沉（weight项）
- 时间步 dt 缩放效果强度

```javascript
buoyancyProgram.bind();
gl.uniform1i(buoyancyProgram.uniforms.uVelocity, velocity3D.read.attach(0));
gl.uniform1i(buoyancyProgram.uniforms.uTemperature, temperature.read.attach(1));
gl.uniform1i(buoyancyProgram.uniforms.uDensity, density.read.attach(2));
gl.uniform1f(buoyancyProgram.uniforms.uBuoyancy, config.BUOYANCY);  // ~1.5
gl.uniform1f(buoyancyProgram.uniforms.uWeight, config.SMOKE_WEIGHT);  // ~0.05
gl.uniform1f(buoyancyProgram.uniforms.dt, dt);
blit(velocity3D.write);      // 渲染到输出纹理
velocity3D.swap();           // 交换读/写指针
```

**数据流**：
```
输入：velocity3D.read, temperature.read, density.read
  ↓ (GPU计算)
输出：velocity3D.write
  ↓ swap()
  ↓ velocity3D.read现在指向更新后的数据
```

#### 阶段2：涡度计算（Curl）

```glsl
curl = ∇ × velocity  // 旋度 = 速度的卷曲度
```

**意义**：测量流体的局部旋转

```javascript
curl3DProgram.bind();
gl.uniform1i(curl3DProgram.uniforms.uVelocity, velocity3D.read.attach(0));
blit(curl3D);  // 输出到curl3D（不需要交换，只是临时数据）
```

#### 阶段3：涡度约束（Vorticity Confinement）

```glsl
velocity += curl_force * curl * dt
```

**目的**：增强小涡旋（防止过度耗散）

```javascript
vorticity3DProgram.bind();
gl.uniform1i(vorticity3DProgram.uniforms.uVelocity, velocity3D.read.attach(0));
gl.uniform1i(vorticity3DProgram.uniforms.uCurl, curl3D.attach(1));
gl.uniform1f(vorticity3DProgram.uniforms.curl, config.CURL);  // ~30
blit(velocity3D.write);
velocity3D.swap();
```

#### 阶段4：散度计算（Divergence）

```glsl
divergence = ∇ · velocity  // 速度的散度
```

**意义**：测量体积压缩/膨胀

```javascript
divergence3DProgram.bind();
gl.uniform1i(divergence3DProgram.uniforms.uVelocity, velocity3D.read.attach(0));
blit(divergence3D);
```

#### 阶段5-6：压力求解（Pressure Solve）

流体不可压缩条件：$\nabla \cdot \vec{v} = 0$

使用Poisson方程：$\nabla^2 p = -\frac{\rho}{\Delta t} (\nabla \cdot \vec{v})$

用Jacobi迭代求解（[n iterations]）：

```javascript
// 5. 清空压力并初始化
clearProgram.bind();
gl.uniform1i(clearProgram.uniforms.uTexture, pressure3D.read.attach(0));
gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);  // ~0.8
blit(pressure3D.write);
pressure3D.swap();

// 6. Jacobi迭代（25次）
pressure3DProgram.bind();
gl.uniform1i(pressure3DProgram.uniforms.uDivergence, divergence3D.attach(0));
for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {  // 25
    gl.uniform1i(pressure3DProgram.uniforms.uPressure, pressure3D.read.attach(1));
    blit(pressure3D.write);
    pressure3D.swap();
}
```

**为什么需要迭代？**
- Jacobi方法逐步改进压力估计
- 更多迭代 → 更精确但更慢
- 25次是质量和性能的平衡

#### 阶段7：梯度减法（Gradient Subtraction）

```glsl
velocity -= ∇pressure  // 从速度移除压力梯度
```

使速度场发散度为零（不可压缩）

```javascript
gradientSubtract3DProgram.bind();
gl.uniform1i(gradientSubtract3DProgram.uniforms.uPressure, pressure3D.read.attach(0));
gl.uniform1i(gradientSubtract3DProgram.uniforms.uVelocity, velocity3D.read.attach(1));
blit(velocity3D.write);
velocity3D.swap();
```

#### 阶段8-10：平流（Advection）

沿速度场"吹动"属性：

```glsl
newValue(pos) = oldValue(pos - velocity(pos) * dt)
```

这是**向后平流**（更稳定）

```javascript
advection3DProgram.bind();

// 8. 平流速度
let velId = velocity3D.read.attach(0);
gl.uniform1i(advection3DProgram.uniforms.uVelocity, velId);
gl.uniform1i(advection3DProgram.uniforms.uSource, velId);
gl.uniform1f(advection3DProgram.uniforms.dt, dt);
gl.uniform1f(advection3DProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);  // 0.2
blit(velocity3D.write);
velocity3D.swap();

// 9. 平流密度（烟雾颜色）
gl.uniform1i(advection3DProgram.uniforms.uVelocity, velocity3D.read.attach(0));
gl.uniform1i(advection3DProgram.uniforms.uSource, density.read.attach(1));
gl.uniform1f(advection3DProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);  // 0.5
blit(density.write);
density.swap();

// 10. 平流温度
gl.uniform1i(advection3DProgram.uniforms.uSource, temperature.read.attach(1));
gl.uniform1f(advection3DProgram.uniforms.dissipation, config.TEMPERATURE_DISSIPATION);  // 1.0
blit(temperature.write);
temperature.swap();
```

**耗散参数意义**：

| 参数 | 值 | 含义 |
|-----|----|----|
| VELOCITY_DISSIPATION | 0.2 | 速度衰减最慢（保持流动） |
| DENSITY_DISSIPATION | 0.5 | 烟雾淡化中等速度 |
| TEMPERATURE_DISSIPATION | 1.0 | 温度快速冷却 |

### 3.4 模拟管道整体架构

```
┌─────────────────────────────────────┐
│     每帧物理模拟 (step函数)           │
└─────────────────────────────────────┘
             ↓
┌──────────┬──────────┬───────────┐
│ 浮力驱动 │ 涡度约束 │ 不可压缩  │
└──────────┴──────────┴───────────┘
             ↓
    ┌──────────────────┐
    │   压力求解       │
    │   (Jacobi迭代)   │
    └──────────────────┘
             ↓
┌─────────────────────────────────┐
│   平流（Advection）             │
│  - 速度                         │
│  - 密度（烟雾颜色）              │
│  - 温度（浮力源）                │
└─────────────────────────────────┘
             ↓
    ┌──────────────────┐
    │   帧完成         │
    │  ready to render │
    └──────────────────┘
```

---

## 四、渲染管道

### 4.1 渲染函数框架

```javascript
function render(target) {
    // target = null表示渲染到屏幕，否则渲染到FBO
    
    if (!config.TRANSPARENT)
        drawColor(target, normalizeColor(config.BACK_COLOR));  // 绘制背景
    
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);  // 启用透明混合
    gl.enable(gl.BLEND);
    drawRayMarch(target);  // 核心：体积光线追踪
}
```

### 4.2 光线追踪渲染（Ray Marching）

#### 摄像机设置

```javascript
const camera = {
    // position
    x: config.CAMERA_CX,
    y: config.CAMERA_CY,
    z: config.CAMERA_CZ + config.CAMERA_RADIUS,

    // view direction
    yaw: config.CAMERA_THETA,
    pitch: config.CAMERA_PHI,

    moveSpeed: 0.08,
    mouseSensitivity: 0.002,
};
```

#### 建立摄像机坐标系

```javascript
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
```

**可视化摄像机球面坐标**：
```
                   +Y (up)
                   |
                  /φ
                 /
        -------+------- +X
       /       |
      /θ       |
     /        -Y
    +Z
    
θ = 水平旋转（绕Y轴）
φ = 竖直旋转（绕X轴）
```

#### Ray Marching核心着色器

```glsl
void main() {
    vec2 uv = vUv;  // 屏幕坐标 [0,1]²
    
    // 从摄像机生成射线
    vec3 camPos = uCameraPos;
    vec3 rayDir = getRayDirection(uv);
    
    // 沿射线行进，累积颜色
    vec3 color = vec3(0.0);
    float alpha = 0.0;
    float depth = 0.01;  // 开始距离
    
    for (int step = 0; step < NUM_STEPS; step++) {
        if (alpha >= 0.99) break;  // 已不透明
        
        vec3 samplePos = camPos + rayDir * depth;
        
        // 查询体积数据
        float density = sample3D(uDensity, samplePos);
        float temp = sample3D(uTemperature, samplePos);
        
        // 计算照明（Phong模型）
        vec3 lightColor = computeLight(samplePos, temp);
        
        // 前向积分
        float sampleAlpha = density * uAbsorption;
        color += (1.0 - alpha) * lightColor * sampleAlpha;
        alpha += (1.0 - alpha) * sampleAlpha;
        
        depth += STEP_SIZE;  // 沿射线前进
    }
    
    gl_FragColor = vec4(color, alpha);
}
```

#### 采样3D体积

体积存储在512×512的atlas纹理中，需要将3D坐标映射到2D：

```glsl
vec3 sample3D(sampler2D atlas, vec3 pos) {
    // pos ∈ [0,1]³
    
    int z_slice = int(pos.z * 64.0);  // z切片索引 [0,63]
    
    // 计算该切片在atlas中的位置
    int sliceX = z_slice % 8;      // 列 [0,7]
    int sliceY = z_slice / 8;      // 行 [0,7]
    
    // 在切片内的坐标
    vec2 inSliceUv = fract(pos.xy);
    
    // 映射到atlas坐标
    vec2 atlasUv = vec2(
        (float(sliceX) + inSliceUv.x) / 8.0,
        (float(sliceY) + inSliceUv.y) / 8.0
    );
    
    return texture2D(atlas, atlasUv).rgb;
}
```

#### 照明模型

```glsl
vec3 computeLight(vec3 samplePos, float temperature) {
    // 固定光源方向
    vec3 lightDir = normalize(vec3(0.4, 0.8, 0.45));
    
    // 基础颜色：较暖的白色
    vec3 baseColor = vec3(1.0, 0.95, 0.88);
    
    // 温度贡献：热区域变红
    vec3 heatColor = mix(
        baseColor,
        vec3(1.0, 0.6, 0.2),  // 橙红色
        temperature
    );
    
    // 简单的漫反射（不计算法线，使用温度作为代理）
    float diffuse = mix(0.5, 1.0, temperature);
    
    return heatColor * diffuse;
}
```

### 4.3 渲染参数

```javascript
config {
    DENSITY_SCALE: 0.4,    // 密度乘数（影响烟雾可见度）
    ABSORPTION: 10.0,      // 单位距离的不透明度（影响厚度感）
}
```

**参数作用**：
- `DENSITY_SCALE ↑` → 烟雾更不透明
- `ABSORPTION ↑` → 烟雾吸收更多光线

---

## 五、维护与交互系统

### 5.1 GUI控制（gui.js）

通过dat.GUI库提供实时参数调整：

```javascript
gui.add(config, 'DENSITY_DISSIPATION', 0, 4.0);  // 烟雾淡化速度
gui.add(config, 'BUOYANCY', 0, 5.0);             // 上升强度
gui.add(config, 'CURL', 0, 50);                  // 涡旋强度
gui.add(config, 'PRESSURE', 0.0, 1.0);           // 压力初始化值
gui.add(config, 'PAUSED').listen();              // 暂停按钮
```

### 5.2 输入处理（input.js）

```javascript
键盘控制：
- P          → 暂停/继续
- ← / →      → 摄像机水平旋转（theta ± 0.05弧度）
- ↑ / ↓      → 摄像机竖直旋转（phi ± 0.05弧度，限制±80°）
```

### 5.3 烟雾持续发射（emitSmoke）

```javascript
function emitSmoke() {
    // 每帧在固定位置添加新烟雾
    EMITTERS.forEach(e => {
        splat3D(e.x, e.y, e.z, 
                EMIT_DENSITY, EMIT_DENSITY, EMIT_DENSITY,
                EMIT_RADIUS,                    // 紧密的高斯球
                density);
        // ... 同时注入温度和速度
    });
}
```

---

## 六、性能优化与设计选择

### 6.1 为什么是Atlas纹理？

| 方案 | 优点 | 缺点 |
|-----|------|------|
| 3D纹理 | 原生3D采样 | WebGL支持差（仅WebGL 2.0），显存浪费 |
| **2D Atlas** | WebGL 1.0兼容，高效 | **需手动映射坐标** |
| 多个2D切片 | 兼容但慢 | 大量纹理单元切换 |

### 6.2 双缓冲策略

解决"read-after-write"冲突：
```
错误：temp = read(pos)     // 读旧值
      write(pos, temp+1)   // 写新值
      下一帧仍用旧数据，跳过更新

正确：temp = read_buffer[pos]
      write_buffer[pos] = temp+1
      swap()
      现在read_buffer指向新值
```

### 6.3 Jacobi迭代 vs 直接求解

| 方法 | 优点 | 缺点 |
|-----|------|------|
| 直接求解(消元法) | 精确 | 复杂，难GPU化，慢 |
| **Jacobi迭代** | **简单，天然并行化** | **需25迭代收敛** |

### 6.4 向后平流（Back-advection）

```glsl
// 向后平流（稳定）
newDensity(pos) = oldDensity(pos - velocity(pos)*dt)

vs

// 向前平流（容易发散）
newDensity(pos + velocity(pos)*dt) = oldDensity(pos)
```

向后平流保证每个像素来自某处（无虚数值）

---

## 七、完整数据流图

```
┌─────────────────────────────────────────────────────┐
│         初始化阶段（加载时执行一次）                  │
├─────────────────────────────────────────────────────┤
│  Canvas → WebGL Context → 检测扩展 → 编译着色器      │
│  ↓                                                  │
│  创建512×512 Atlas FBO × 6个                         │
│  ↓                                                  │
│  初始化烟雾源（底部中心）                            │
│  ↓                                                  │
│  启动GUI和输入系统                                  │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│         每帧循环（requestAnimationFrame）            │
├─────────────────────────────────────────────────────┤
│  1. 计算时间步 dt                                   │
│                                                    │
│  2. 持续喷烟：emitSmoke()                          │
│     splat3D() → 注入密度、温度、速度                 │
│                                                    │
│  3. 物理步骤 step(dt)：                             │
│     a) 浮力      : velocity ← buoyancy + temp       │
│     b) 涡度计算  : curl ← ∇×velocity               │
│     c) 涡度约束  : velocity ← vorticity force       │
│     d) 散度计算  : divergence ← ∇·velocity         │
│     e) 压力求解  : 25次Jacobi迭代                   │
│     f) 梯度减法  : velocity ← ∇pressure            │
│     g) 平流      : advect(velocity, density, temp) │
│                                                    │
│  4. 渲染 render()：                                 │
│     Ray march体积 → 采样密度和温度 → 照明计算        │
│     → 混合输出到屏幕                                │
│                                                    │
│  5. 申请下一帧                                      │
└─────────────────────────────────────────────────────┘
```

---

## 八、关键参数解释

| 参数 | 范围 | 推荐值 | 影响 |
|-----|------|--------|------|
| DENSITY_DISSIPATION | [0,4] | 0.5 | 烟雾消散速度（低=留存久） |
| VELOCITY_DISSIPATION | [0,4] | 0.2 | 流动衰减（低=保持流动） |
| BUOYANCY | [0,5] | 1.5 | 热烟上升强度 |
| SMOKE_WEIGHT | [0,1] | 0.05 | 烟雾重力（对抗浮力） |
| CURL | [0,50] | 30 | 涡旋保留强度 |
| PRESSURE_ITERATIONS | N/A | 25 | 压力求解精度 |
| DENSITY_SCALE | [0.01,2] | 0.4 | 渲染时烟雾不透明度 |
| ABSORPTION | [1,50] | 10 | 烟雾厚度感 |

---

## 九、总结

这个程序实现了**完整的3D流体模拟管道**：

1. **数据结构创意**：用2D纹理atlas模拟3D体积（省显存）
2. **物理准确性**：包含浮力、涡度约束、Jacobi压力求解
3. **性能优化**：半精度浮点、双缓冲、并行GPU计算
4. **实时交互**：摄像机旋转、GUI参数调整、暂停/继续
5. **逼真渲染**：体积光线追踪 + 温度相关照明

对于基础WebGL学习者：这是从"渲染三角形"升级到"实时3D模拟"的完美案例。
