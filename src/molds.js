/**
 * molds.js — 雪模具的形状库
 *
 * 像玩沙子一样：挑一个模具，在雪地上按一下，就扣出一个那个形状的雪雕。
 *
 * ---- 为什么不再写进高度场 ----
 *
 * 第一版是把每个模具做成「从上往下看每一点多高」的剖面，直接盖进雪地高度场。
 * 好处是它立刻就是雪，坏处有两个，而且都是根上的：
 *
 *   1. 高度场每个 (x,z) 只有一个高度，任何「上面比下面宽」的形状都做不出来 ——
 *      雪人的脖子、鸭子的头、兔子耳朵、雪屋的门洞，全是悬空结构。
 *   2. 雪场网格是 5.8cm 一格。把竖墙硬写进去，三角形被拉成又细又高的长条，
 *      法线在格与格之间跳，墙面上就是一片棋盘格。东西越高越明显。
 *
 * 所以现在每个模具是一个**三维有向距离场**（SDF），由 sculpt.js 在 CPU 上
 * 用 Surface Nets 抽成网格：顶点沿着表面均匀排布，法线取 SDF 的梯度，
 * 悬空、内凹、门洞都没问题，也就没有棋盘格。
 *
 * 「它是雪」这件事由另外两处保证：
 *   - 材质和雪地是同一套物理（冰的折射率、次表面散射、压实雪偏蓝、朝上的面积新雪）
 *   - 高度场上仍然盖一个**底座**：一圈压实的雪垫 + 往外的凹圆角，把雕塑的脚
 *     埋进周围的雪里。这一部分还在 GPU 上，下面的 padSd 就是它的轮廓。
 *   - 用手推它会塌成一堆真正的高度场雪，按休止角自己摊开（见 interaction.js）
 *
 * ---- 坐标约定（归一化，乘模具尺寸 s 才是米）----
 *
 *   y 向上，y=0 是底面（落在雪面上）
 *   x 沿模具朝向（默认是镜头的水平朝向），脸冲 -x，也就是冲着你
 *   z 是 x 的右手边
 */

import * as THREE from 'three/webgpu';
import { vec2, float, texture, select } from 'three/tsl';
import { U } from './config.js';

// ---------------------------------------------------------------- SDF 小工具（CPU）

const sph = (x, y, z, cx, cy, cz, r) => Math.hypot(x - cx, y - cy, z - cz) - r;

/** 椭球的近似距离（iq），在表面附近足够准 */
const ell = (x, y, z, cx, cy, cz, rx, ry, rz) => {
  const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
  const k0 = Math.hypot(px, py, pz);
  const k1 = Math.hypot(px / rx, py / ry, pz / rz);
  return k1 < 1e-6 ? -Math.min(rx, ry, rz) : k0 * (k0 - 1) / k1;
};

const cap = (x, y, z, ax, ay, az, bx, by, bz, r) => {
  const pax = x - ax, pay = y - ay, paz = z - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const t = Math.min(1, Math.max(0, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz)));
  return Math.hypot(pax - bax * t, pay - bay * t, paz - baz * t) - r;
};

const box = (x, y, z, bx, by, bz) => {
  const qx = Math.abs(x) - bx, qy = Math.abs(y) - by, qz = Math.abs(z) - bz;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0))
    + Math.min(Math.max(qx, qy, qz), 0);
};

/** 竖直圆柱，y 从 y0 到 y1 */
const cylY = (x, y, z, r, y0, y1) => {
  const dx = Math.hypot(x, z) - r;
  const dy = Math.max(y0 - y, y - y1);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
};

/** 沿 x 的圆柱，轴心在 (cy, 0)，x 从 x0 到 x1 */
const cylX = (x, y, z, cy, r, x0, x1) => {
  const dr = Math.hypot(y - cy, z) - r;
  const dx = Math.max(x0 - x, x - x1);
  return Math.hypot(Math.max(dr, 0), Math.max(dx, 0)) + Math.min(Math.max(dr, dx), 0);
};

const torY = (x, y, z, cy, R, r) => Math.hypot(Math.hypot(x, z) - R, y - cy) - r;

/** 多项式软并集：接缝处长一个半径约 k 的圆角 —— 雪捏在一起就是这样 */
const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a, b, k) => -smin(-a, -b, k);

/** 挖一个坑（眼窝、门洞），边缘带一点圆角 */
const carve = (d, hole, k) => smax(d, -hole, k);

/** 砌块横缝：y 方向每 period 一道 V 形浅槽 */
const course = (y, period, depth) => {
  const g = Math.abs((y / period) - Math.floor(y / period) - 0.5);
  const t = Math.min(1, Math.max(0, (g - 0.40) / 0.10));
  return t * t * depth;
};

/** iq 的二维五角星有向距离 */
const star5 = (u0, v0, r, rf) => {
  const k1x = 0.809016994375, k1y = -0.587785252292;
  const k2x = -0.809016994375, k2y = -0.587785252292;
  let x = Math.abs(u0), y = v0;
  let d = Math.max(x * k1x + y * k1y, 0) * 2;
  x -= d * k1x; y -= d * k1y;
  d = Math.max(x * k2x + y * k2y, 0) * 2;
  x -= d * k2x; y -= d * k2y;
  x = Math.abs(x); y -= r;
  const bax = 0.587785252292 * rf;
  const bay = 0.809016994375 * rf - 1;
  const bb = bax * bax + bay * bay;
  const h = Math.min(r, Math.max(0, (x * bax + y * bay) / bb));
  const px = x - bax * h, py = y - bay * h;
  return Math.hypot(px, py) * Math.sign(y * bax - x * bay);
};

// ---------------------------------------------------------------- 值噪声（手捏出来的不平整）

function hash3(i, j, k) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, y, z) {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
  const fx = x - i, fy = y - j, fz = z - k;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash3(i, j, k), hash3(i + 1, j, k), ux), l(hash3(i, j + 1, k), hash3(i + 1, j + 1, k), ux), uy),
    l(l(hash3(i, j, k + 1), hash3(i + 1, j, k + 1), ux), l(hash3(i, j + 1, k + 1), hash3(i + 1, j + 1, k + 1), ux), uy),
    uz,
  );
}

/** 表面上两层很浅的起伏：模具是手拍实的，不是车床车出来的 */
export const lumps = (x, y, z) =>
  (vnoise(x * 4.5, y * 4.5, z * 4.5) - 0.5) * 0.012
  + (vnoise(x * 11 + 17.3, y * 11, z * 11) - 0.5) * 0.006;

// ---------------------------------------------------------------- 九个形状
//
// 细节的原则：模具扣出来的东西，所有细节都是雪本身的起伏 —— 眼睛是窝，
// 纽扣是鼓包，围巾是一圈凸棱，没有任何「另一种材质」的零件。
// 软并集的半径决定「捏合处」有多圆：雪人的脖子用 0.08，所以葫芦腰是保住的。

function ball(x, y, z) {
  // 球心压到 0.28：一颗雪球放在雪地上本来就会陷进去一截
  return sph(x, y, z, 0, 0.28, 0, 1.0);
}

function snowman(x, y, z) {
  let d = sph(x, y, z, 0, 0.50, 0, 0.62);
  d = smin(d, sph(x, y, z, 0, 1.28, 0, 0.44), 0.10);
  d = smin(d, sph(x, y, z, 0, 1.88, 0, 0.31), 0.08);
  // 围巾：脖子上一圈凸棱，外加垂下来的一截
  d = smin(d, torY(x, y, z, 1.62, 0.25, 0.075), 0.035);
  d = smin(d, cap(x, y, z, -0.08, 1.60, 0.22, 0.02, 1.30, 0.34, 0.06), 0.04);
  // 鼻子：一截往前伸的短锥（两段胶囊拼出来的收尖）
  d = smin(d, cap(x, y, z, -0.24, 1.88, 0, -0.40, 1.87, 0, 0.055), 0.03);
  d = smin(d, cap(x, y, z, -0.40, 1.87, 0, -0.52, 1.86, 0, 0.030), 0.02);
  // 眼窝
  d = carve(d, sph(x, y, z, -0.27, 1.98, 0.11, 0.048), 0.02);
  d = carve(d, sph(x, y, z, -0.27, 1.98, -0.11, 0.048), 0.02);
  // 纽扣：中间那颗球上两颗、底下那颗球上一颗
  for (const a of [-0.30, 0.10]) {
    d = smin(d, sph(x, y, z, -0.44 * Math.cos(a), 1.28 + 0.44 * Math.sin(a), 0, 0.055), 0.02);
  }
  d = smin(d, sph(x, y, z, -0.62 * Math.cos(0.35), 0.50 + 0.62 * Math.sin(0.35), 0, 0.06), 0.02);
  return d;
}

function duck(x, y, z) {
  let d = ell(x, y, z, 0.05, 0.44, 0, 0.80, 0.46, 0.56);                // 身子
  d = smin(d, ell(x, y, z, 0.70, 0.66, 0, 0.26, 0.15, 0.20), 0.18);     // 翘起来的尾巴
  d = smin(d, cap(x, y, z, -0.45, 0.62, 0, -0.52, 0.92, 0, 0.20), 0.12); // 脖子
  d = smin(d, sph(x, y, z, -0.55, 1.06, 0, 0.33), 0.10);                // 头
  d = smin(d, ell(x, y, z, -0.90, 1.00, 0, 0.23, 0.075, 0.15), 0.03);   // 扁嘴
  // 两边的翅膀：贴在身侧的扁椭球，捏合半径小，留住一道翅膀的边
  d = smin(d, ell(x, y, z, 0.14, 0.56, 0.44, 0.44, 0.22, 0.13), 0.04);
  d = smin(d, ell(x, y, z, 0.14, 0.56, -0.44, 0.44, 0.22, 0.13), 0.04);
  d = carve(d, sph(x, y, z, -0.78, 1.15, 0.16, 0.045), 0.02);
  d = carve(d, sph(x, y, z, -0.78, 1.15, -0.16, 0.045), 0.02);
  return d;
}

function bunny(x, y, z) {
  let d = ell(x, y, z, 0.12, 0.50, 0, 0.60, 0.52, 0.50);                // 身子
  d = smin(d, sph(x, y, z, -0.38, 1.08, 0, 0.34), 0.16);                // 头
  // 耳朵：向外撇一点的扁椭球
  for (const s of [1, -1]) {
    const py = y - 1.60, pz = z - s * 0.13;
    const a = s * 0.22, c = Math.cos(a), n = Math.sin(a);
    const ry = py * c + pz * n, rz = -py * n + pz * c;
    d = smin(d, ell(x, ry, rz, -0.30, 0, 0, 0.10, 0.34, 0.075), 0.06);
  }
  d = smin(d, sph(x, y, z, 0.72, 0.52, 0, 0.16), 0.05);                 // 尾巴
  d = smin(d, ell(x, y, z, -0.42, 0.10, 0.20, 0.22, 0.11, 0.12), 0.06); // 前爪
  d = smin(d, ell(x, y, z, -0.42, 0.10, -0.20, 0.22, 0.11, 0.12), 0.06);
  d = smin(d, ell(x, y, z, 0.05, 0.09, 0.40, 0.34, 0.10, 0.14), 0.08);  // 后脚
  d = smin(d, ell(x, y, z, 0.05, 0.09, -0.40, 0.34, 0.10, 0.14), 0.08);
  d = smin(d, sph(x, y, z, -0.71, 1.04, 0, 0.045), 0.015);              // 鼻头
  d = carve(d, sph(x, y, z, -0.64, 1.16, 0.15, 0.042), 0.02);
  d = carve(d, sph(x, y, z, -0.64, 1.16, -0.15, 0.042), 0.02);
  return d;
}

function tower(x, y, z) {
  const r = Math.hypot(x, z);
  // 墙身带 5% 的收分 —— 沙模都是上小下大，才脱得了模
  const rb = 1.0 - 0.05 * Math.max(y, 0);
  let d = Math.max(r - rb, y - 2.16);
  // 八个垛口：把点旋进最近的那个扇区，再量一个小方块
  const sec = Math.PI / 4;
  const th = Math.atan2(z, x);
  const c = Math.round((th - sec / 2) / sec) * sec + sec / 2;
  const lx = r * Math.cos(th - c), lz = r * Math.sin(th - c);
  d = Math.min(d, box(lx - 0.80, y - 2.36, lz, 0.14, 0.22, 0.17) - 0.02);
  // 顶上凹下去的平台
  d = carve(d, cylY(x, y, z, 0.64, 1.86, 3.0), 0.03);
  // 基座
  d = smin(d, cylY(x, y, z, 1.15, -1, 0.30), 0.06);
  // 正面的拱门（真的凹进去）+ 一道窗缝
  const door = Math.min(box(x + 1.0, y - 0.28, z, 0.34, 0.36, 0.20),
    cylX(x, y, z, 0.64, 0.20, -1.34, -0.66));
  d = carve(d, door, 0.02);
  d = carve(d, box(x + 0.97, y - 1.45, z, 0.14, 0.16, 0.05), 0.015);
  // 砌块横缝，只刻在墙身外圈
  if (r > 0.80) d += course(y, 0.36, 0.014);
  return d;
}

function wall(x, y, z) {
  const hz = 0.40 - 0.04 * Math.max(y, 0);
  let d = Math.max(Math.abs(x) - 1.60, Math.abs(z) - hz, y - 1.46);
  // 垛口：沿 x 每 0.8 一个
  const mx = x - 0.8 * Math.round(x / 0.8);
  if (Math.abs(x) < 1.62) d = Math.min(d, box(mx, y - 1.62, z, 0.20, 0.18, hz) - 0.015);
  d = smin(d, box(x, y + 0.36, z, 1.74, 0.64, 0.54), 0.05);             // 墙基
  d += course(y, 0.30, 0.012);
  return d;
}

function igloo(x, y, z) {
  let d = ell(x, y, z, 0, 0, 0, 1.0, 1.05, 1.0);
  d = Math.max(d, -ell(x, y, z, 0, 0, 0, 0.82, 0.87, 0.82));            // 掏空
  d = smin(d, cylX(x, y, z, 0, 0.44, -1.45, -0.50), 0.06);              // 门廊
  d = carve(d, cylX(x, y, z, 0, 0.29, -1.8, -0.30), 0.03);              // 门洞（真的是洞）
  // 雪砖：按仰角一圈一圈，竖缝逐层错开
  const rr = Math.hypot(x, z);
  const el = Math.atan2(y, rr);
  const row = Math.floor(el / 0.26);
  const t1 = Math.abs(el / 0.26 - row - 0.5);
  const az = Math.atan2(z, x) / (Math.PI * 2) * 12 + (row % 2) * 0.5;
  const t2 = Math.abs(az - Math.floor(az) - 0.5);
  const seam = Math.max(Math.min(1, Math.max(0, (t1 - 0.42) / 0.08)),
    Math.min(1, Math.max(0, (t2 - 0.46) / 0.04)));
  if (rr + y > 0.3) d += seam * seam * 0.016;
  return d;
}

function spire(x, y, z) {
  const q = Math.hypot(x, z);
  const rr = 0.92 * (1 - (y - 0.22) / 2.30);
  let d = Math.max((q - rr) * 0.928, y - 2.52);
  d = smin(d, cylY(x, y, z, 1.05, -1, 0.22), 0.05);
  // 小桶扣出来的环脊
  d += course(y + 0.1, 0.42, 0.02);
  return d;
}

function star(x, y, z) {
  // 星形的一个尖冲着你
  const d2 = star5(z, -x, 1.0, 0.44);
  const top = 0.46 + 0.20 * Math.min(1, Math.max(0, -d2 * 3.0));
  return smax(d2, y - top, 0.10);
}

// ---------------------------------------------------------------- 模具表
//
// foot   底座的半长宽（x, z）+ 圆角 —— 拖着连放时的间距、挨着放时判断合不合并
// top    最高点（归一化）—— 合并时新部分从下往上「露」出来，升到这个高度
// bounds 抽网格的包围盒 [x0, x1, y1, z0, z1]（y0 固定在底面以下一点）

export const MOLDS = [
  { id: 'ball',    key: 'mold.ball',    sdf: ball,    foot: [0.96, 0.96, 0.96], top: 1.28, bounds: [-1.05, 1.05, 1.33, -1.05, 1.05] },
  { id: 'snowman', key: 'mold.snowman', sdf: snowman, foot: [0.60, 0.60, 0.60], top: 2.19, bounds: [-0.62, 0.68, 2.25, -0.68, 0.68] },
  { id: 'duck',    key: 'mold.duck',    sdf: duck,    foot: [0.86, 0.58, 0.50], top: 1.39, bounds: [-1.18, 1.00, 1.45, -0.66, 0.66] },
  { id: 'bunny',   key: 'mold.bunny',   sdf: bunny,   foot: [0.72, 0.56, 0.45], top: 1.95, bounds: [-0.82, 0.92, 2.04, -0.62, 0.62] },
  { id: 'tower',   key: 'mold.tower',   sdf: tower,   foot: [1.15, 1.15, 1.15], top: 2.58, bounds: [-1.20, 1.20, 2.64, -1.20, 1.20] },
  { id: 'wall',    key: 'mold.wall',    sdf: wall,    foot: [1.74, 0.54, 0.10], top: 1.80, bounds: [-1.80, 1.80, 1.86, -0.60, 0.60] },
  { id: 'igloo',   key: 'mold.igloo',   sdf: igloo,   foot: [1.20, 1.00, 0.90], top: 1.05, bounds: [-1.50, 1.05, 1.10, -1.05, 1.05] },
  { id: 'spire',   key: 'mold.spire',   sdf: spire,   foot: [1.05, 1.05, 1.05], top: 2.52, bounds: [-1.10, 1.10, 2.58, -1.10, 1.10] },
  { id: 'star',    key: 'mold.star',    sdf: star,    foot: [0.90, 0.90, 0.60], top: 0.66, bounds: [-1.05, 1.05, 0.72, -1.05, 1.05] },
];

// ---------------------------------------------------------------- 贴地截面（给 GPU 的底座用）
//
// 雪地上那圈压实的雪要**贴着雕塑的脚**长出来，才看得出雕塑是从雪里长出来的，
// 而不是摆在上面。圆角矩形近似不行 —— 兔子的四只爪、鸭子的肚子、雪屋的门廊，
// 和矩形差得远，雪要么离墙根一截，要么埋进身子里。
//
// 所以每个模具在 CPU 上把「贴地那一层」（y 从 0 到 0.16）的截面算成一张二维距离场：
// 每个 (x,z) 取这几层里 SDF 的最小值。竖墙处这就是水平距离；圆底（球）处偏大一点，
// 正好让雪在球底下多堆一点。九张拼成一张图集，GPU 双线性采样。

const FP_N = 96;          // 每张的边长（纹素）
const FP_HALF = 1.9;      // 覆盖 [-1.9, 1.9]²（归一化）—— 够装下最长的城墙
const FP_LEVELS = [0, 0.04, 0.08, 0.12, 0.16];

function buildFootAtlas() {
  const data = new Uint16Array(FP_N * FP_N * MOLDS.length);
  for (let t = 0; t < MOLDS.length; t++) {
    const f = MOLDS[t].sdf;
    for (let j = 0; j < FP_N; j++) {
      const z = -FP_HALF + (j + 0.5) / FP_N * FP_HALF * 2;
      for (let i = 0; i < FP_N; i++) {
        const x = -FP_HALF + (i + 0.5) / FP_N * FP_HALF * 2;
        let d = 1e9;
        for (const y of FP_LEVELS) d = Math.min(d, f(x, y, z) + lumps(x, y, z));
        data[(t * FP_N + j) * FP_N + i] = THREE.DataUtils.toHalfFloat(Math.max(-1, Math.min(2, d)));
      }
    }
  }
  const tex = new THREE.DataTexture(data, FP_N, FP_N * MOLDS.length, THREE.RedFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export const FOOT_REACH = FP_HALF;
const footAtlas = buildFootAtlas();

// ---------------------------------------------------------------- GPU 侧

/**
 * 世界 xz -> 模具局部坐标（归一化）。u 沿 moldAxis，v 是它右手边的法向。
 * 注意 v 和网格局部的 z 差一个符号（v = -z）。
 */
export const moldLocal = (xz) => {
  const d = xz.sub(U.moldPos.xz);
  const a = U.moldAxis;
  const rt = vec2(a.y, a.x.negate());
  return vec2(d.dot(a), d.dot(rt)).div(U.moldScale.max(1e-3));
};

/** 底座轮廓的有向距离（归一化单位，负 = 在里面）：查雕塑真实的贴地截面 */
export const padSd = (p) => {
  // 每张图在图集里占一行，行内的 v 要钳在半个纹素以内，别采到隔壁那张
  const e = 0.5 / FP_N;
  const lu = p.x.add(FP_HALF).div(FP_HALF * 2).clamp(e, 1 - e);
  const lv = p.y.negate().add(FP_HALF).div(FP_HALF * 2).clamp(e, 1 - e);
  const uv = vec2(lu, U.moldType.add(lv).div(MOLDS.length));
  const inBox = p.x.abs().max(p.y.abs()).lessThan(FP_HALF);
  return select(inBox, texture(footAtlas, uv).level(0).x, float(2));
};
