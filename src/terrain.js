/**
 * terrain.js — 地形高度场
 *
 * 大场景的第一块地基。以前整个世界是一张平的 26m 雪地，积雪本身就是唯一的起伏；
 * 要做 400m 以上的场景，雪必须变成「铺在地形上的一层」，而不是地形本身。
 *
 * 做法是最朴素也最可靠的一种：CPU 生成一张高度图，同一份数据同时给
 *   - GPU：以 storage buffer 的形式读，顶点/片元/compute 三个阶段都能用
 *   - CPU：放模型、射线拾取、相机贴地
 * 两边用**同一个插值函数**，所以结果逐位一致 —— 交互不会出现「看到的和摸到的不是同一个面」。
 *
 * 高度和**梯度**一起存（vec4 的 xyz），这一点是踩过坑之后改的：
 *
 * 一开始只存高度，法线由插值函数的解析导数给出。但任何「两端导数为零」的插值权重
 * （smoothstep、quintic 都是）都会让梯度在纹素角点归零、在纹素中间达到峰值 ——
 * 于是整个地形被绗缝成一格一格的鼓包，远景铺满 1m 周期的十字纹。
 * 花了一轮 FFT 才把周期量出来是 1 个纹素、而不是 clipmap 的格子。
 *
 * 现在梯度是在 CPU 上用相邻纹素的中心差分直接算好存进去的，着色器只做插值、
 * 不再求导，绗缝就没有了。代价是每个纹素 16 字节而不是 4 字节。
 */

import * as THREE from 'three/webgpu';
import { float, int, mix, vec3, instancedArray } from 'three/tsl';

// ---------------------------------------------------------------- 尺度

export const TERRAIN_TEX = 1024;                      // 高度图边长（纹素）
export const TERRAIN_SPAN = 1024;                     // 覆盖的世界边长（米）
export const TERRAIN_TEXEL = TERRAIN_SPAN / (TERRAIN_TEX - 1);
export const TERRAIN_HALF = TERRAIN_SPAN / 2;

// ---------------------------------------------------------------- CPU 噪声

/** 整数格点哈希，0..1。JS 和 GPU 都不用它 —— 只在生成高度图时跑一次。 */
function h2(ix, iy) {
  let n = (Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = h2(ix, iy), b = h2(ix + 1, iy), c = h2(ix, iy + 1), d = h2(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, y, oct, lac = 2.03, gain = 0.5) {
  let s = 0, a = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, y);
    n += a;
    a *= gain;
    x *= lac; y *= lac;
    x += 37.31; y -= 19.17;      // 每层错开，避免各层格点对齐出十字纹
  }
  return s / n;
}

const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * 地形形状。
 *
 * 中心 ~±60m 压平成一个缓坡浅盆 —— 那里是玩雪区，得保住原来那套交互手感；
 * 往外逐渐放开起伏，西北方向抬起一道山脊，给远景一个天际线。
 */
// 频率上限。高度图是 1 m 一个纹素，而最粗那级 clipmap 的格子是 0.93m ——
// 也就是说地形里任何波长短于 ~8m 的成分，在 L2 上都采不够、会烂成十字摩尔纹
// （第一版整片地都是这种纹路）。所以每一项的最细那层都压在 10m 以上。
// 反正雪本来就会把地形磨平，8m 以下的起伏交给积雪层去表现更合理。
function shape(x, z) {
  const broad = (fbm(x / 240, z / 240, 3) - 0.5) * 44;          // 最细 λ ≈ 58 m

  // 脊状噪声：1-|2n-1| 会在等值线处形成尖脊，是山脉最省事的做法
  const rn = fbm(x / 310 + 11.7, z / 310 - 7.3, 3);
  const ridge = Math.pow(1 - Math.abs(rn * 2 - 1), 2.4);
  const rmask = sstep(70, 300, Math.hypot(x + 150, z + 200));
  const ranges = ridge * 62 * rmask;                            // 最细 λ ≈ 75 m

  const mid = (fbm(x / 62, z / 62, 3) - 0.5) * 8.0;             // 最细 λ ≈ 15 m
  const fine = (fbm(x / 22, z / 22, 2) - 0.5) * 1.6;            // 最细 λ ≈ 11 m

  // 越靠近原点越平。注意是整体乘下去，所以中心自然是个平缓的碗底，不会出现锥尖。
  const open = sstep(11, 105, Math.hypot(x, z));

  // 图的边缘要收回平地。不收的话越界之后高度会被钳制成边缘那一行，
  // 于是地平线上会挂出一道笔直的「挤出」剪影 —— 一眼就穿帮。
  // 用切比雪夫距离，四个角和四条边同时收完。
  const cheb = Math.max(Math.abs(x), Math.abs(z)) / TERRAIN_HALF;
  const rim = 1 - sstep(0.78, 0.98, cheb);

  return (broad + ranges + mid + fine) * open * rim;
}

// ---------------------------------------------------------------- 高度图

/** 行主序，每个纹素 4 个 float：高度, dh/dx, dh/dz, 未用 */
export const terrainData = new Float32Array(TERRAIN_TEX * TERRAIN_TEX * 4);

let _built = false;

export function buildTerrain() {
  if (_built) return terrainData;
  const t0 = performance.now();
  const N = TERRAIN_TEX;

  const h = new Float32Array(N * N);
  for (let iy = 0; iy < N; iy++) {
    const z = iy * TERRAIN_TEXEL - TERRAIN_HALF;
    for (let ix = 0; ix < N; ix++) h[iy * N + ix] = shape(ix * TERRAIN_TEXEL - TERRAIN_HALF, z);
  }

  // 梯度用相邻纹素的中心差分。跨度两个纹素，正好把 shape() 里贴着奈奎斯特的
  // 那点残余高频也一并滤掉，法线因此比「解析导数」还干净。
  const inv = 1 / (2 * TERRAIN_TEXEL);
  const cl = (v) => (v < 0 ? 0 : v > N - 1 ? N - 1 : v);
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const o = (iy * N + ix) * 4;
      terrainData[o] = h[iy * N + ix];
      terrainData[o + 1] = (h[iy * N + cl(ix + 1)] - h[iy * N + cl(ix - 1)]) * inv;
      terrainData[o + 2] = (h[cl(iy + 1) * N + ix] - h[cl(iy - 1) * N + ix]) * inv;
    }
  }

  _built = true;
  console.info(`[snow] terrain ${N}² / ${TERRAIN_SPAN}m `
    + `(${TERRAIN_TEXEL.toFixed(2)} m/texel, ${(terrainData.byteLength / 1e6).toFixed(1)}MB) `
    + `built in ${(performance.now() - t0).toFixed(0)}ms`);
  return terrainData;
}

// ---------------------------------------------------------------- GPU 侧

export const terrainBuf = instancedArray(TERRAIN_TEX * TERRAIN_TEX, 'vec4');

/** 把 CPU 高度图灌进 storage buffer。必须在第一次渲染之前调用。 */
export function uploadTerrain() {
  buildTerrain();
  terrainBuf.value.array.set(terrainData);
  terrainBuf.value.needsUpdate = true;
}

const TI = int(TERRAIN_TEX);
const tc = (v) => v.max(int(0)).min(int(TERRAIN_TEX - 1));
const tAt = (ix, iy) => terrainBuf.element(tc(iy).mul(TI).add(tc(ix)).toUint());

/**
 * 一次采样同时拿到高度和两个偏导：vec3(h, dh/dx, dh/dz)。
 * 三个分量都只是**插值**，没有求导 —— 见文件头那段。
 * 图外自动钳制成边缘值，远处被雾吃掉，看不出边界。
 */
export const terrainSample = (xz) => {
  const f = xz.add(TERRAIN_HALF).div(TERRAIN_TEXEL);
  const i = f.floor();
  const fr = f.sub(i);
  const ix = i.x.toInt();
  const iy = i.y.toInt();

  // 权重用**线性**，不用 smoothstep。
  // smoothstep 对线性变化的场不是精确的：它在每个纹素里 S 形地慢-快-慢，
  // 于是插出来的梯度带着 ~6% 的周期性摆动，一个纹素一个周期。地形是 1m 一格，
  // 90m 外正好是十来个像素 —— 那就是远景那片菱形斜纹，用「只留地形法线」
  // 的探针量出来是 2.45，「只留积雪法线」只有 0.94。
  // 双线性对线性变化是精确的，误差退到二阶，小一个数量级。
  const u = fr;

  const a = tAt(ix, iy).xyz;
  const b = tAt(ix.add(1), iy).xyz;
  const c = tAt(ix, iy.add(1)).xyz;
  const d = tAt(ix.add(1), iy.add(1)).xyz;

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
};

/** 只要高度时省掉导数那两行 */
export const terrainHeight = (xz) => terrainSample(xz).x;

// ---------------------------------------------------------------- CPU 侧（必须和上面逐位一致）

const _r = { h: 0, gx: 0, gz: 0 };

/** 返回复用的对象 {h, gx, gz}，别持有它 */
export function terrainAt(x, z) {
  const fx = (x + TERRAIN_HALF) / TERRAIN_TEXEL;
  const fz = (z + TERRAIN_HALF) / TERRAIN_TEXEL;
  const i0 = Math.floor(fx), j0 = Math.floor(fz);
  const sx = fx - i0, sz = fz - j0;

  const cl = (v) => (v < 0 ? 0 : v > TERRAIN_TEX - 1 ? TERRAIN_TEX - 1 : v);
  const at = (i, j, c) => terrainData[(cl(j) * TERRAIN_TEX + cl(i)) * 4 + c];

  const ux = sx;                 // 和 GPU 端一致：双线性，不是 smoothstep
  const uz = sz;
  const lerp = (a, b, t) => a + (b - a) * t;
  const bi = (c) => lerp(
    lerp(at(i0, j0, c), at(i0 + 1, j0, c), ux),
    lerp(at(i0, j0 + 1, c), at(i0 + 1, j0 + 1, c), ux),
    uz,
  );

  _r.h = bi(0);
  _r.gx = bi(1);
  _r.gz = bi(2);
  return _r;
}

export const terrainY = (x, z) => terrainAt(x, z).h;

/** 世界法线，给 CPU 侧放模型用 */
export function terrainNormal(x, z, out = new THREE.Vector3()) {
  const t = terrainAt(x, z);
  return out.set(-t.gx, 1, -t.gz).normalize();
}
