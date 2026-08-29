/**
 * snowfield.js — 积雪高度场（相机跟随 clipmap）
 *
 * 以前这是一张固定的 448² 网格，铺满 26m。想把场景做到 400m 以上，
 * 那条路是走不通的：同样 5.8cm 的精度覆盖 400m 需要 7172² ≈ 5100 万格。
 *
 * 所以改成 clipmap —— 三级同样大小的窗口跟着相机滑动，格子逐级放大 4 倍：
 *
 *   L0  5.8cm/格   26 m   全网格，可交互
 *   L1  23cm/格   104 m   环形（中间挖空给 L0）
 *   L2  93cm/格   416 m   环形
 *   再外面是不做模拟的裙边，高度直接由「地形 + 平衡雪深」解析给出
 *
 * 三件事让它成立：
 *
 *   1. 环形寻址。窗口滑动时不搬数据，只把世界格子坐标对 GRID 取模映射到缓冲区。
 *      相机走一步，只有新露出来的那几行是「脏」的。
 *   2. 脏格识别。每格存着自己当前代表的世界格子坐标（tag），对不上就重填。
 *      重填的值是**当前的平衡雪深**而不是 0 —— 否则往前走会一路露出裸地。
 *   3. 各级共用一个平衡雪深函数 snowBaseAt(世界坐标)。它只跟世界坐标有关，
 *      跟格子大小无关，所以三级在接缝处收敛到同一个高度，缝是对得上的。
 *
 * 每帧每级的 GPU 流水线：
 *   refresh (补脏格) → relax (休止角塌落) → accumulate (堆积) → [deform] → lighting
 */

import * as THREE from 'three/webgpu';
import {
  Fn, If, float, int, uint, vec2, vec3, vec4,
  instancedArray, instanceIndex, vertexIndex, uniform,
  positionLocal, positionWorld, cameraPosition,
  varying, smoothstep, mix, select, hash, mx_noise_float, mx_fractal_noise_float,
  transformNormalToView, fwidth,
} from 'three/tsl';

import {
  GRID, CELLS, LEVELS, CELL0, GROUND, HOLE_LO, HOLE_HI, SNAP, FAR_SPAN,
  cellOf, spanOf, U,
} from './config.js';
import { terrainSample } from './terrain.js';

// ---------------------------------------------------------------- 通用小工具

/**
 * 大尺度的风吹雪起伏，返回 -1..1。按到窗口中心的距离分三档。
 *
 * 判据不是「别混叠」，是「Gouraud 着色下别看出面」—— 这两件事差得很远。
 * 高度场本身有 4 个采样点就能表示一个波长，但网格是逐顶点插值的，
 * 一个波长只跨 4 个顶点时，法线在每个格子里是常数、格与格之间跳变，
 * 远景就会铺满一格一格的菱形斜纹（用纯 Lambert 探针量出来它占了全部瑕疵）。
 * 一个波长至少要跨十几个顶点才看不出来。于是：
 *
 *   λ ≳ 10 m   全场都有        L2 一格 0.93m → 11 个顶点/波长
 *   λ ≈ 4.5 m  50m 内淡出      L1 一格 0.23m → 19 个顶点/波长
 *   λ ≈ 1.2 m  14m 内淡出      L0 一格 0.058m → 20 个顶点/波长
 *
 * 淡出只跟世界坐标和窗口中心有关，跟层号无关 —— 所以相邻两级在重叠带上
 * 算出来的值是同一个，接缝不会错开。
 */
export const driftNoise = (p) => {
  const d = p.sub(U.fieldCenter.xz).length();
  const kMid = float(1).sub(smoothstep(30.0, 50.0, d));
  const kFine = float(1).sub(smoothstep(9.0, 14.0, d));

  const a = mx_fractal_noise_float(vec3(p.mul(0.045), 11.3), 2, 2.1, 0.55, 1.0);
  const b = mx_noise_float(vec3(p.mul(0.22), 4.1), 1.0, 0.0);
  const c = mx_noise_float(vec3(p.mul(0.85), 7.7), 1.0, 0.0);

  return a.mul(0.70).add(b.mul(0.30).mul(kMid)).add(c.mul(0.22).mul(kFine));
};

/**
 * 2D 值噪声，同时返回值和两个偏导：vec3(v, dv/dx, dv/dy)，值域 [0,1]。
 * 用它代替「三次 fbm 取有限差分」求法线：省掉三分之二的噪声计算，
 * 而且导数是精确的，不会有差分带来的台阶感。
 */
export const noised = (p) => {
  const i = p.floor();
  const f = p.fract();
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const du = float(6).mul(f).mul(float(1).sub(f));

  const key = (ox, oy) => hash(
    i.x.add(ox).add(4096.0).toUint().mul(uint(1619))
      .add(i.y.add(oy).add(4096.0).toUint().mul(uint(31337))),
  );
  const a = key(0, 0);
  const b = key(1, 0);
  const c = key(0, 1);
  const d = key(1, 1);
  const k1 = b.sub(a);
  const k2 = c.sub(a);
  const k3 = a.sub(b).sub(c).add(d);

  return vec3(
    a.add(k1.mul(u.x)).add(k2.mul(u.y)).add(k3.mul(u.x).mul(u.y)),
    du.x.mul(k1.add(k3.mul(u.y))),
    du.y.mul(k2.add(k3.mul(u.x))),
  );
};

/** 1 = 完全在里面, 0 = 在半径外（feather 是过渡宽度） */
const insideOf = (d, r, feather) => float(1).sub(smoothstep(float(r).sub(feather), float(r), d));

/** 点到线段的距离（vec2） */
const segDist = (p, a, b) => {
  const pa = p.sub(a);
  const ba = b.sub(a);
  const t = pa.dot(ba).div(ba.dot(ba).max(1e-5)).clamp(0, 1);
  return pa.sub(ba.mul(t)).length();
};

/**
 * 手印轮廓：掌心椭圆 + 四指 + 拇指，输入是以手掌半径归一化的局部坐标
 * u 沿手指方向，v 沿手掌横向。返回 0..1。
 */
const FINGERS = [
  [-0.47, 0.40, 1.00, 0.140],  // 小指
  [-0.17, 0.44, 1.21, 0.150],  // 无名指
  [ 0.15, 0.44, 1.19, 0.152],  // 中指
  [ 0.44, 0.40, 0.99, 0.142],  // 食指
];

const handPrint = (u, v) => {
  const p = vec2(u, v);
  let s = insideOf(vec2(u.sub(0.04), v.mul(1.14)).length(), 0.58, 0.30);
  for (const [vv, u0, u1, r] of FINGERS) {
    s = s.max(insideOf(segDist(p, vec2(u0, vv * 0.88), vec2(u1, vv)), r, 0.085));
  }
  s = s.max(insideOf(segDist(p, vec2(0.00, 0.50), vec2(0.58, 1.00)), 0.170, 0.10));
  return s.clamp(0, 1);
};

// ---------------------------------------------------------------- 平衡雪深
//
// 这是整套 clipmap 的黏合剂：**只跟世界坐标有关**的目标雪深。
// 三级模拟都朝它收敛，裙边直接用它，所以接缝处高度自然一致。
//
// 物理上就两条：陡坡挂不住雪；迎风坡被吹光、背风坡堆成雪檐。

export const snowBaseFrom = (xz, t) => {
  const g = vec2(t.y, t.z);                      // 地形梯度，指向上坡
  const slope = g.length();

  // 太陡的地方雪自己就滑走了
  const keep = float(1).sub(smoothstep(0.62, 1.60, slope));

  // 风：坡朝着风来的方向就是迎风面，被吹光；背风面堆积
  const wv = U.wind.xz;
  const wd = wv.div(wv.length().max(1e-4));
  const lee = g.div(slope.max(1e-4)).dot(wd).negate().mul(smoothstep(0.06, 0.55, slope));

  const n = driftNoise(xz.add(vec2(U.elapsed.mul(0.05), U.elapsed.mul(0.035))));

  return U.targetDepth
    .mul(float(1).add(n.mul(U.driftAmount).mul(0.85)))
    .mul(float(1).add(lee.mul(U.driftAmount).mul(0.60)))
    .mul(keep)
    .max(0);
};

export const snowBaseAt = (xz) => snowBaseFrom(xz, terrainSample(xz));

// ---------------------------------------------------------------- 一级 clipmap

// ---------------------------------------------------------------- 形变留存
//
// clipmap 的代价：窗口滑走的格子会被「当前平衡雪深」重填，你踩的脚印就没了。
// 走出去十几米再回头，一条推痕齐刷刷断在身后 —— 这个场景最核心的那件事
// （在雪上留下痕迹）等于白做。
//
// 解法是一张**独立的、也跟着相机走的形变图**：只存「相对平衡雪深的偏差」，
// 分辨率 12.5cm、覆盖 256m。L0 每帧把自己的形变写进去，L1/L2 和
// 「L0 补脏格」都从它读回来。于是：
//
//   - 走开再回来，痕迹还在（±128m 之内）
//   - 痕迹跨过 L0 的 13m 边界进入 L1 时不会断掉 —— 这一条其实更重要，
//     只让 L0 读留存的话，痕迹会齐着一个以你为中心的圆被切掉
//
// 只记录**手真正碰过**的格子（L0 多存一个 touch 通道），否则风吹雪的自然起伏
// 也会被记下来再原样贴回去，drift 就冻住不动了。

export const STASH_N = 2048;                       // 形变图边长
export const STASH_SPAN = 256;                     // 覆盖的世界边长（米）
export const STASH_CELL = STASH_SPAN / STASH_N;    // 0.125 m —— 约 L0 的两格
const STASH_SNAP = 16;                             // 窗口对齐步长（= 128 格）
const STASH_WIN = Math.ceil(GROUND / STASH_CELL) + 4;

const SN = int(STASH_N);
const stashBuf = instancedArray(STASH_N * STASH_N, 'vec2');   // x 形变量  y 压实度  (33.5 MB)
// tag 存的是世界格子坐标压成的一个数，不是 vec2 —— 2048² 下这就是 16.8 MB 和 33.5 MB 的差别。
// 坐标范围 ±4096 格（±512m），按 x*16384+y 打包后最大 6.7e7 …… 超出 float32 的
// 精确整数范围（1.67e7）了，所以先除以 128 只存**块号**：窗口是按 128 格整块对齐滑动的，
// 同一块里的格子必然同生共死，块号就够了。打包后最大 1.0e6，精确。
const stashTag = instancedArray(STASH_N * STASH_N, 'float');   // (16.8 MB)
const stashOC = uniform(new THREE.Vector2());                 // 窗口起点的世界格子坐标

const socx = stashOC.x.toInt();
const socy = stashOC.y.toInt();
const sfmod = (a) => a.mod(SN).add(SN).mod(SN);
const sIdx = (gx, gy) => sfmod(socy.add(gy)).mul(SN).add(sfmod(socx.add(gx))).toUint();
const scl = (v) => v.max(int(0)).min(int(STASH_N - 1));
const sAt = (buf, gx, gy) => buf.element(sIdx(scl(gx), scl(gy)));

/** 世界 xz -> 留存的形变（双线性）。窗口外一律返回 0。 */
const stashAt = (xz) => {
  const fx = xz.x.div(STASH_CELL).sub(socx.toFloat());
  const fz = xz.y.div(STASH_CELL).sub(socy.toFloat());
  const ix = fx.floor().toInt();
  const iy = fz.floor().toInt();
  const rx = fx.sub(fx.floor());
  const rz = fz.sub(fz.floor());

  const a = sAt(stashBuf, ix, iy);
  const b = sAt(stashBuf, ix.add(1), iy);
  const c = sAt(stashBuf, ix, iy.add(1));
  const d = sAt(stashBuf, ix.add(1), iy.add(1));
  const v = mix(mix(a, b, rx), mix(c, d, rx), rz);

  // 边缘不能钳制 —— 那会把最外圈的形变一路涂到窗口外面去
  const inside = ix.greaterThan(int(0)).and(ix.lessThan(int(STASH_N - 2)))
    .and(iy.greaterThan(int(0))).and(iy.lessThan(int(STASH_N - 2)));
  return select(inside, v, vec2(0));
};

const G = int(GRID);
const AO_DIRS = 6;
const AO_RAD = [0.09, 0.24, 0.55, 1.15];
const SUN_STEPS = 14;
const CRUMBLE_F = 26.0;
const crumbleAt = (xz) => noised(xz.mul(CRUMBLE_F));

/**
 * @param {number} k       级号，0 最细
 * @param {object} coarse  最粗那一级（k = LEVELS-1 时为 null）。
 *                         细层借它的远距离太阳遮蔽，各级的影子才对得上。
 */
function createLevel(k, coarse) {
  const cell = cellOf(k);
  const rel = cell / CELL0;                 // 相对 L0 的尺度倍数
  const isFine = k === 0;

  // ---- 缓冲区 ----
  const height = instancedArray(CELLS, 'float');   // 雪深
  const height2 = instancedArray(CELLS, 'float');  // 松弛中转
  const packed = instancedArray(CELLS, 'float');   // 压实度 0..1
  const crust = instancedArray(CELLS, 'float');    // 风壳 0..1
  const surf = instancedArray(CELLS, 'float');     // 绝对表面高度 = 地形 + 雪
  const lightB = instancedArray(CELLS, 'vec4');    // x 太阳可见度 y 天空遮蔽 z 凹陷度
  const tag = instancedArray(CELLS, 'vec2');       // 这一格当前代表的世界格子坐标
  // 只有 L0 需要：这一格被手碰过没有。形变留存只记录碰过的格子，
  // 否则风吹雪的自然起伏也会被存下来再贴回去，drift 就冻住了。
  const touchBuf = isFine ? instancedArray(CELLS, 'float') : null;

  // ---- 窗口 ----
  const oc = uniform(new THREE.Vector2());  // 窗口起点的世界格子坐标（整数值）
  const ocx = oc.x.toInt();
  const ocy = oc.y.toInt();

  // 环形寻址：世界格子坐标 -> 缓冲区下标。取模要用「向下取整的模」，
  // 直接用 % 在负数上会翻车。
  const fmod = (a) => a.mod(G).add(G).mod(G);
  const bufOf = (gx, gy) => fmod(ocy.add(gy)).mul(G).add(fmod(ocx.add(gx))).toUint();
  const cl = (v) => v.max(int(0)).min(int(GRID - 1));
  // 邻居查询：先在**窗口坐标**里钳制再环绕，否则窗口边缘会读到对面那一行
  const at = (buf, gx, gy) => buf.element(bufOf(cl(gx), cl(gy)));
  const worldOf = (gx, gy) => vec2(
    ocx.add(gx).toFloat().mul(cell),
    ocy.add(gy).toFloat().mul(cell),
  );

  /** 世界 xz -> 本级窗口里最近的那一格 */
  const nearest = (x, z) => ({
    gx: x.div(cell).sub(ocx.toFloat()).add(0.5).floor().toInt(),
    gy: z.div(cell).sub(ocy.toFloat()).add(0.5).floor().toInt(),
  });
  const surfAt = (x, z) => { const n = nearest(x, z); return at(surf, n.gx, n.gy); };
  const lightAt = (x, z) => { const n = nearest(x, z); return at(lightB, n.gx, n.gy); };
  /** 世界 xz 是否落在本级窗口内（留一格余量） */
  const insideWindow = (x, z) => {
    const n = nearest(x, z);
    return n.gx.greaterThan(int(0)).and(n.gx.lessThan(int(GRID - 1)))
      .and(n.gy.greaterThan(int(0))).and(n.gy.lessThan(int(GRID - 1)));
  };

  // ---- compute 侧：缓冲区下标 -> 窗口坐标 ----
  const idx = instanceIndex.toInt();
  const cgx = fmod(idx.mod(G).sub(ocx));
  const cgy = fmod(idx.div(G).sub(ocy));
  const cw = worldOf(cgx, cgy);
  const cwc = vec2(ocx.add(cgx).toFloat(), ocy.add(cgy).toFloat());

  // ---------------------------------------------------------------- 补脏格
  //
  // 窗口滑动之后，绕回来的那几行还存着上一圈的旧数据。这里逐格比对 tag，
  // 对不上就按当前的平衡雪深重填。补的是「已经下到几成」的雪 ——
  // 补满会让新露出的地面比脚下厚，补 0 则会一路露出裸地。
  const computeRefresh = Fn(() => {
    const d = tag.element(instanceIndex).sub(cwc).abs();
    If(d.x.add(d.y).greaterThan(0.25), () => {
      const t = terrainSample(cw);
      // 补的是「已经下到几成的雪」+「这一格历史上被踩出来的形变」
      const st = stashAt(cw);
      const b = snowBaseFrom(cw, t).mul(U.snowProgress).add(st.x).max(0);
      height.element(instanceIndex).assign(b);
      // 注意不写 height2：紧接着的 relax 会从 height 重新算出它。
      // 这一条是被 WebGPU 的 **每阶段 8 个 storage buffer** 逼出来的 ——
      // 加上形变留存之后这个 pass 正好卡在 9 个，超一个就整条计算管线创建失败。
      // （适配器其实支持 16，但 8 是规范保证的下限，不该为了省事牺牲兼容性。）
      // 往这个 pass 里再加缓冲之前，先数一遍：
      //   tag / height / packed / crust / surf / terrain / stash / touch = 8，已经满了。
      packed.element(instanceIndex).assign(st.y.clamp(0, 1));
      crust.element(instanceIndex).assign(U.crustSeed.mul(float(1).sub(st.y.clamp(0, 1))));
      surf.element(instanceIndex).assign(t.x.add(b));
      tag.element(instanceIndex).assign(cwc);
      if (isFine) touchBuf.element(instanceIndex).assign(select(st.x.abs().greaterThan(0.004), 1, 0));
    });
  })().compute(CELLS);

  // ---------------------------------------------------------------- 清空 / 铺满
  const computeFill = Fn(() => {
    const t = terrainSample(cw);
    const n = driftNoise(cw);
    const h = U.fillValue.mul(float(1).add(n.mul(U.driftAmount).mul(0.55))).max(0);
    height.element(instanceIndex).assign(h);
    height2.element(instanceIndex).assign(h);
    packed.element(instanceIndex).assign(0);
    crust.element(instanceIndex).assign(0);
    surf.element(instanceIndex).assign(t.x.add(h));
    tag.element(instanceIndex).assign(cwc);
    if (isFine) touchBuf.element(instanceIndex).assign(0);
  })().compute(CELLS);

  // ---------------------------------------------------------------- 松弛
  // 超过休止角的坡度会塌落（反对称流量 → 质量守恒），并做轻微自平整。
  // 阈值是「坡度 x 格子尺寸」，所以三级用同一个休止角，塌出来的坡形是一致的。
  const computeRelax = Fn(() => {
    const h = height.element(instanceIndex);
    const hL = at(height, cgx.sub(1), cgy);
    const hR = at(height, cgx.add(1), cgy);
    const hD = at(height, cgx, cgy.sub(1));
    const hU = at(height, cgx, cgy.add(1));

    const thr = U.reposeSlope.mul(cell);
    const flux = (d) => d.sign().mul(d.abs().sub(thr).max(0));
    const flow = flux(h.sub(hL)).add(flux(h.sub(hR))).add(flux(h.sub(hD))).add(flux(h.sub(hU)));
    const kk = U.slumpRate.mul(U.dt).mul(0.22).min(0.24);
    const slumped = h.sub(flow.mul(kk));

    const avg = hL.add(hR).add(hD).add(hU).mul(0.25);
    const sm = U.smoothRate.mul(U.dt).min(0.35);

    height2.element(instanceIndex).assign(mix(slumped, avg, sm).max(0));
  })().compute(CELLS);

  // ---------------------------------------------------------------- 堆积
  const computeAccumulate = Fn(() => {
    const h = height2.element(instanceIndex);
    const t = terrainSample(cw);
    const base = snowBaseFrom(cw, t);

    // 接近平衡厚度时自然收敛。三级用同一个 base，所以收敛到同一个面。
    const gate = float(1).sub(smoothstep(base.mul(0.45), base.max(1e-4), h));
    const add = U.depositRate.mul(U.dt).mul(gate);
    const nh = float(0).toVar();
    nh.assign(h.add(add));

    if (!isFine) {
      // L0 是形变的**来源**，不能反过来读留存（会自激）。
      // L1/L2 不可交互，直接把留存并进平衡值再快速拉齐就行 ——
      // 这样痕迹跨过 L0 的边界进入 L1 时是连着的，不会齐着一个圆断掉。
      const want = base.add(stashAt(cw).x).max(0);
      nh.assign(mix(nh, want, U.dt.mul(8.0).min(1)));
    }

    height.element(instanceIndex).assign(nh);
    surf.element(instanceIndex).assign(t.x.add(nh));

    const p = packed.element(instanceIndex);
    packed.element(instanceIndex).assign(p.mul(float(1).sub(add.mul(U.freshCover)).clamp(0, 1)));

    // 风壳：风把表层吹结实，新落的雪又把壳埋掉 —— 雪的「层」就是这么来的
    const cr = crust.element(instanceIndex);
    crust.element(instanceIndex).assign(
      cr.add(U.crustRate.mul(U.dt)).sub(add.mul(U.freshCover).mul(2.2)).clamp(0, 1),
    );

    // 痕迹被新雪埋掉之后就不再算「碰过」，留存也随之释放
    if (isFine) {
      const tc = touchBuf.element(instanceIndex);
      touchBuf.element(instanceIndex).assign(
        tc.sub(add.mul(U.freshCover).mul(1.6)).clamp(0, 1));
    }
  })().compute(CELLS);

  // ---------------------------------------------------------------- 手的交互（只有 L0）
  let computeDeform = null;
  if (isFine) {
    computeDeform = Fn(() => {
      const w = cw;
      const R = U.handRadius;
      const a = U.handPrev.xz;
      const b = U.handCur.xz;
      const amt = U.handStrength;

      const h0 = height.element(instanceIndex);
      const p0 = packed.element(instanceIndex);

      // 这一帧手掌扫过的区域（上一帧到这一帧当成一段线段，快速拖动也不会漏）
      const d = segDist(w, a, b);
      const core = insideOf(d, R, R.mul(0.78));

      // 手边缘外侧的雪堤：一条环带，偏向运动方向的前方
      const tt = d.sub(R).div(R.mul(0.92));
      const q = tt.sub(0.40).mul(2.7);
      const band = q.mul(q).negate().exp().mul(smoothstep(-0.05, 0.04, tt));
      const dir = w.sub(b).add(vec2(1e-5, 1e-5)).normalize();
      const bias = dir.dot(U.handAxis).mul(0.5).add(0.5).mul(0.9).add(0.26);
      const avail = h0.div(U.targetDepth.max(0.02)).clamp(0, 1.25);

      const nb = at(height, cgx.sub(1), cgy)
        .add(at(height, cgx.add(1), cgy))
        .add(at(height, cgx, cgy.sub(1)))
        .add(at(height, cgx, cgy.add(1)))
        .mul(0.25);

      // 0 推雪 —— 掌下刮走的雪守恒地堆到掌缘。
      // 环带面积比掌心大好几倍，所以每格分到的量必须小得多，否则雪会凭空长成山。
      const pressP = U.handPress.mul(amt);
      const removed = h0.min(pressP.mul(core));
      const berm = pressP.mul(U.handPile).mul(band).mul(bias).mul(avail.min(1.0)).mul(0.30);
      const pushH = h0.sub(removed).add(berm);
      const pushP = p0.max(core.max(band.mul(0.5)));

      // 1 抚平
      const kS = core.mul(amt).mul(3.2).clamp(0, 1);
      const smoothH = mix(h0, nb, kS);
      const smoothP = p0.mul(float(1).sub(kS.mul(0.45)));

      // 2 堆雪
      const soft = insideOf(d, R, R.mul(0.95));
      const pileH = h0.add(U.handPress.mul(amt).mul(soft).mul(1.4));
      const pileP = p0.max(soft.mul(0.7));

      // 3 手印
      const rel2 = w.sub(b);
      const ax = U.handAxis;
      const rt = vec2(ax.y, ax.x.negate());
      const prof = handPrint(rel2.dot(ax).div(R), rel2.dot(rt).div(R));
      // 压到当地雪深的 ~82%：浅雪里也能留下掌形，而不是一个见底的洞
      const stampDepth = U.handPress.mul(1.4).min(h0.mul(0.82)).mul(amt);
      const edge = smoothstep(0.02, 0.28, prof).mul(float(1).sub(smoothstep(0.28, 0.70, prof)));
      const printH = h0.sub(stampDepth.mul(prof))
        .add(U.handPress.mul(U.handPile).mul(edge).mul(avail.min(1.0)).mul(0.22));
      const printP = p0.max(prof.mul(0.95));

      const nh = float(0).toVar();
      const np = float(0).toVar();
      const touch = float(0).toVar();      // 这一帧被手动过的程度，用来打碎风壳

      If(U.handMode.lessThan(0.5), () => {
        nh.assign(pushH); np.assign(pushP); touch.assign(core.max(band.mul(0.8)));
      }).ElseIf(U.handMode.lessThan(1.5), () => {
        nh.assign(smoothH); np.assign(smoothP); touch.assign(kS);
      }).ElseIf(U.handMode.lessThan(2.5), () => {
        nh.assign(pileH); np.assign(pileP); touch.assign(soft);
      }).Else(() => {
        nh.assign(printH); np.assign(printP); touch.assign(prof);
      });

      const ceil = U.targetDepth.mul(3.5).add(0.10);
      const outH = nh.clamp(0, ceil);
      height.element(instanceIndex).assign(outH);
      surf.element(instanceIndex).assign(terrainSample(w).x.add(outH));
      packed.element(instanceIndex).assign(np.clamp(0, 1));
      const cr0 = crust.element(instanceIndex);
      crust.element(instanceIndex).assign(cr0.mul(float(1).sub(touch.clamp(0, 1))).clamp(0, 1));
      const tc0 = touchBuf.element(instanceIndex);
      touchBuf.element(instanceIndex).assign(tc0.max(touch.clamp(0, 1)).clamp(0, 1));
    })().compute(CELLS);
  }

  // ---------------------------------------------------------------- 光线步进
  //
  // 逐格算两件事：
  //   x = 太阳可见度 —— 沿太阳方向在**绝对表面高度**上步进。因为 surf 里含地形，
  //       粗层顺手就把远山的自阴影算出来了，这是 shadow map 覆盖不到的距离。
  //   y = 天空遮蔽   —— 6 个方位找地平线仰角（HBAO）。半径按格子尺寸缩放，
  //       所以 L0 得到的是掌印里的接触暗部，L2 得到的是山谷的大尺度暗部。
  //
  // 放在 compute 里做而不是逐像素做：高度场只有 448²，屏幕有两百多万像素。
  const computeLighting = Fn(() => {
    const s0 = surf.element(instanceIndex);

    const sd = U.sunDir;
    const hlen = vec2(sd.x, sd.z).length().max(1e-3);
    const sx = sd.x.div(hlen);
    const sz = sd.z.div(hlen);
    const slope = sd.y.div(hlen);                 // 水平前进 1m，光线升高多少

    // 参考高度必须取「光线」和「地面自己的爬升」里更高的那个。
    //
    // 只跟光线比的话，任何比太阳仰角更陡的坡都会判成自遮挡 —— 而缓坡正好落在
    // 明暗交界上，那里结果对采样位置极其敏感，逐格取最近邻就会显出一道道
    // 垂直于太阳方位的条纹（第一版整片远景都是这个）。
    //
    // 坡面朝背光侧本来就该暗，但那是 NdotL 的活，不该由光线步进来做；
    // 步进只负责「别处投过来的影子」。所以沿光线方向减掉地面自身的爬升率。
    const gsx = at(surf, cgx.add(1), cgy).sub(at(surf, cgx.sub(1), cgy)).div(cell * 2);
    const gsz = at(surf, cgx, cgy.add(1)).sub(at(surf, cgx, cgy.sub(1))).div(cell * 2);
    const rise = slope.max(gsx.mul(sx).add(gsz.mul(sz)));

    const vis = float(1).toVar();
    for (let n = 1; n <= SUN_STEPS; n++) {
      const dist = 0.055 * n * n * rel;           // L0 到 10.8m，L2 到 173m
      const hs = surfAt(cw.x.add(sx.mul(dist)), cw.y.add(sz.mul(dist)));
      const occ = hs.sub(s0.add(rise.mul(dist))).div(0.06 * rel).clamp(0, 1);
      vis.assign(vis.min(float(1).sub(occ)));
    }
    // 细层借最粗那级的远距离结果，否则 L0/L1 的接缝上会出现一条明显的明暗界
    if (coarse) vis.assign(vis.min(coarse.lightAt(cw.x, cw.y).x));
    // 太阳贴近地平线时关掉自阴影，否则整片雪地会一起黑掉
    vis.assign(mix(float(1), vis, smoothstep(0.005, 0.07, sd.y)));

    // 天空遮蔽同样要在**切平面**里算，不能在水平面里算。
    //
    // 直接用 (hs - s0)/r 的话，一个均匀斜坡上坡方向的邻居永远更高，
    // 于是所有坡面都被判成被遮蔽 —— 而这个量对采样点的位置极其敏感：
    // L2 一格 0.93m，相邻两格在斜坡上就差 0.4m，最近邻取样的抖动直接变成
    // 一格一格的噪声，铺满整个远景。斜坡该不该暗是 NdotL 的事，
    // 遮蔽只该看**相对于局部切平面的起伏**。
    const occSum = float(0).toVar();
    const openSum = float(0).toVar();       // 相对切平面高出多少 —— 正 = 凹陷
    for (let a = 0; a < AO_DIRS; a++) {
      const ang = (a / AO_DIRS) * Math.PI * 2;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      const maxT = float(0).toVar();
      for (const r0 of AO_RAD) {
        const r = r0 * rel;
        const hs = surfAt(cw.x.add(dx * r), cw.y.add(dz * r));
        const plane = gsx.mul(dx * r).add(gsz.mul(dz * r));   // 切平面在这个方向上的抬升
        const dh = hs.sub(s0).sub(plane);
        maxT.assign(maxT.max(dh.div(r)));
        openSum.addAssign(dh.div(rel));
      }
      occSum.addAssign(maxT.div(float(1).add(maxT.mul(maxT)).sqrt()));   // sin(atan(t))
    }
    const ao = float(1).sub(occSum.div(AO_DIRS)).clamp(0, 1).toVar();
    // 每一级的 AO 半径是按自己的格距缩放的，所以「大尺度」那部分各级算出来不一样，
    // 接缝上会横着出现一条淡淡的亮度台阶。和太阳可见度一样，让细层把最粗那级的
    // 结果乘进来 —— 大尺度分量于是全场一致，缝就看不出来了。
    if (coarse) ao.mulAssign(coarse.lightAt(cw.x, cw.y).y.clamp(0, 1));

    // 大尺度凹陷度：坑里的雪四面都被雪包着，光在里面走的路更长 ——
    // 这正是雪洞、脚印内部会发蓝的原因
    const cav = openSum.div(AO_DIRS * AO_RAD.length).div(0.12).clamp(-1, 1);

    lightB.element(instanceIndex).assign(vec4(vis, ao.pow(1.35), cav, 0));
  })().compute(CELLS);

  const L = {
    k, cell, rel, isFine,
    height, packed, crust, surf, lightB,
    oc, ocx, ocy, touchBuf,
    at, bufOf, cl, worldOf, surfAt, lightAt, insideWindow,
    computeRefresh, computeFill, computeRelax, computeAccumulate, computeDeform, computeLighting,
    mesh: null,
  };
  L.material = snowMaterial(L);
  return L;
}

// ---------------------------------------------------------------- 雪地材质

/**
 * 冰在可见光波段的吸收系数（1/m，相对值）。红光被吸收得比蓝光强二十倍 ——
 * 这就是深雪、雪洞、压实的雪会发蓝的**唯一**原因，不是什么美术偏好。
 */
const ICE_ABSORB = [0.34, 0.065, 0.017];

function snowMaterial(L) {
  const { cell, isFine, height, packed, crust, lightB, at, bufOf, cl, worldOf } = L;

  // 顶点 -> 窗口坐标。几何体是行主序的 GRID x GRID，所以下标就是窗口坐标；
  // 世界坐标由窗口起点算出来，模型矩阵保持单位阵。
  const vi = vertexIndex.toInt();
  const vgx = vi.mod(G);
  const vgy = vi.div(G);
  const vw = worldOf(vgx, vgy);
  const vt = terrainSample(vw);                 // vec3(h, dh/dx, dh/dz)
  const self = bufOf(cl(vgx), cl(vgy));

  const hHere = at(height, vgx, vgy);
  const hXm = at(height, vgx.sub(1), vgy);
  const hXp = at(height, vgx.add(1), vgy);
  const hZm = at(height, vgx, vgy.sub(1));
  const hZp = at(height, vgx, vgy.add(1));

  // 雪自身的梯度（不含地形）。
  //
  // 这里用 3x3 的 Sobel 而不是最省事的中心差分。中心差分沿 x 只看奇数列、
  // 沿 z 只看奇数行 —— 奇偶两套格子互不相干，于是高度场里任何一点点噪声都会
  // 在法线上放大成两格周期的棋盘，远景整片铺开就是那种菱形斜纹。
  // Sobel 把相邻行/列也混进来，奇偶就耦合上了，斜纹随之消失。多 4 次读取。
  const hmm = at(height, vgx.sub(1), vgy.sub(1));
  const hpm = at(height, vgx.add(1), vgy.sub(1));
  const hmp = at(height, vgx.sub(1), vgy.add(1));
  const hpp = at(height, vgx.add(1), vgy.add(1));
  const gsx = hpm.add(hXp.mul(2)).add(hpp).sub(hmm).sub(hXm.mul(2)).sub(hmp).div(cell * 8);
  const gsz = hmp.add(hZp.mul(2)).add(hpp).sub(hmm).sub(hZm.mul(2)).sub(hpm).div(cell * 8);
  const snowN = vec3(gsx.negate(), 1, gsz.negate()).normalize();
  // 真正的表面法线 = 地形梯度 + 雪梯度
  const surfN = vec3(gsx.add(vt.y).negate(), 1, gsz.add(vt.z).negate()).normalize();

  const vNrm = varying(surfN, 'vSnowN');
  const vDep = varying(hHere, 'vSnowH');
  const vPack = varying(packed.element(self), 'vSnowP');
  const vCrust = varying(crust.element(self), 'vSnowK');
  // 光照缓冲逐格算，粗层一格就有 0.23 / 0.93 米，逐格的细小差异在远处会连成
  // 一片摩尔纹。粗层上先做一次 3x3 帐篷滤波再送进插值 —— 反正太阳可见度和
  // 天空遮蔽本来就是低频量，糊一格不损失任何看得见的东西。
  // L0 不滤：那里要保住掌印边缘干脆的接触暗部。
  const lightTent = () => {
    if (isFine) return lightB.element(self);
    let acc = at(lightB, vgx, vgy).mul(4);
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      acc = acc.add(at(lightB, vgx.add(dx), vgy.add(dz)).mul(2));
    }
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      acc = acc.add(at(lightB, vgx.add(dx), vgy.add(dz)));
    }
    return acc.div(16);
  };
  const vLight = varying(lightTent(), 'vSnowL');
  // 拉普拉斯：>0 表示凹陷（掌印内部），用来做接触遮蔽
  const vCav = varying(hXm.add(hXp).add(hZm).add(hZp).mul(0.25).sub(hHere), 'vSnowC');
  // 只看雪自己的坡度（不含地形），层理和破碎才只出现在被挖开的切面上，
  // 而不是把整座山坡都画满层
  const vSlope = varying(vec2(snowN.x, snowN.z).length(), 'vSnowS');

  // 雪是致密的散射介质，不是不透明漫反射体。用带次表面项的 physical 材质，
  // 光进入雪里散射几厘米再漫出来 —— 这是雪「晶莹」而不是「白纸」的物理来源。
  const mat = new THREE.MeshSSSNodeMaterial();
  mat.ior = 1.31;          // 冰的折射率，F0≈0.018（默认 1.5 的 F0 是 0.04，会让雪像塑料）
  mat.metalness = 0;
  mat.name = `snow_L${L.k}`;

  // 有效光程：几何厚度 x 密度（越密单位厚度里散射次数越多）x 凹陷加成
  const scatterPath = Fn(() => {
    const dens = float(1)
      .add(vPack.clamp(0, 1).mul(1.8))      // 压实的雪最密
      .add(vCrust.clamp(0, 1).mul(0.6));    // 风壳次之
    const d = vDep.div(0.20).clamp(0.06, 3.0);
    const cav = vLight.z.max(0).mul(U.sssCavity).add(1.0);
    return U.sssPath.mul(d).mul(dens).mul(cav);
  })();

  // Beer-Lambert：出射光谱
  const iceTransmit = Fn(() => vec3(
    scatterPath.mul(-ICE_ABSORB[0]).exp(),
    scatterPath.mul(-ICE_ABSORB[1]).exp(),
    scatterPath.mul(-ICE_ABSORB[2]).exp(),
  ))();

  // ---- 顶点位移：直接输出世界坐标（模型矩阵是单位阵）----
  // 粗层往下压一点点：接缝的重叠带上永远是细层赢，不会 z-fighting。
  const yBias = -0.015 * L.k;
  // 陡边破碎只在 L0 做：26 周期/米的噪声在 23cm 的格距上会直接混叠成噪点
  const crumbleK = isFine;

  mat.positionNode = Fn(() => {
    let y = vt.x.add(hHere).add(yBias);
    if (crumbleK) {
      const slopeW = smoothstep(0.10, 0.55, vec2(snowN.x, snowN.z).length());
      const c = crumbleAt(vw);
      y = y.add(c.x.sub(0.5).mul(U.crumble).mul(slopeW));
    }
    return vec3(vw.x, y, vw.y);
  })();

  // ---- 法线：宏观形状 + 风纹 + 雪粒 ----
  mat.normalNode = Fn(() => {
    const n = vNrm.normalize();
    const p = positionWorld.xz;
    // 风纹最细的那一层是 19 周期/米（波长 5cm）。26m 的场地里它是「雪的质感」，
    // 铺到 400m 之后一个像素里要过好几个周期 —— 直接烂成条纹摩尔纹。
    //
    // 淡出的判据不该是距离，而是**一个像素在雪面上覆盖多少米**。
    // 同样 40m 远，俯视和掠视的像素足迹能差十倍：先前用距离拍的阈值，
    // 站高了往下看时近处的雪就早早糊平了，画面下半截一片死白。
    // fwidth 直接把这个足迹给出来，分辨率、视场角、掠射角一并算进去了。
    //
    // 阈值故意放在「一个像素约 3–14cm」而不是严格的奈奎斯特（2.5cm）。
    // 严格按奈奎斯特淡出的话，贴地平视时 10m 外的风纹就没了 —— 而那正是
    // 这个场景最好看的一档质感。留一点点混叠交给 TRAA，视觉上划算得多；
    // 何况亚像素的法线方差已经在 roughnessNode 里按距离折算成粗糙度了。
    const foot = fwidth(positionWorld.xz).length();
    const near = float(1).sub(smoothstep(0.030, 0.140, foot));

    // 转到风向坐标系：风纹垂直于风向、顺风被拉长
    const wv = U.wind.xz.add(vec2(1e-4, 0));
    const wl = wv.length().max(1e-4);
    const cwd = wv.x.div(wl);
    const swd = wv.y.div(wl);
    const q = vec2(p.x.mul(cwd).add(p.y.mul(swd)), p.x.mul(swd).negate().add(p.y.mul(cwd)));

    const F1X = 5.0, F1Y = 19.0, F2X = 13.0, F2Y = 47.0;
    const n1 = noised(vec2(q.x.mul(F1X), q.y.mul(F1Y)));
    const n2 = noised(vec2(q.x.mul(F2X), q.y.mul(F2Y)).add(vec2(31.7, 11.3)));

    // 风壳把细颗粒糊平，只留下大尺度的风棱
    const fine = float(1).sub(vCrust.clamp(0, 1).mul(0.55));
    const gqx = n1.y.mul(F1X).add(n2.y.mul(F2X * 0.40).mul(fine));
    const gqy = n1.z.mul(F1Y).add(n2.z.mul(F2Y * 0.40).mul(fine));
    const gx = gqx.mul(cwd).sub(gqy.mul(swd));
    const gz = gqx.mul(swd).add(gqy.mul(cwd));

    // 风纹强弱跟着雪的厚度走，压实过的地方变平
    const relief = vDep.div(U.targetDepth.max(0.02)).clamp(0, 1.4).mul(0.7).add(0.42);
    const grain = float(0.0062).mul(relief).mul(float(1).sub(vPack.clamp(0, 1).mul(0.72)));
    let g = vec3(gx.negate(), 0, gz.negate()).mul(grain).mul(near).mul(U.microRelief);

    if (crumbleK) {
      // 陡边破碎的法线贡献，必须和顶点位移用同一套噪声
      const slopeW = smoothstep(0.10, 0.55, vSlope);
      const cb = crumbleAt(positionWorld.xz);
      g = g.add(vec3(cb.y.negate(), 0, cb.z.negate()).mul(CRUMBLE_F).mul(U.crumble).mul(slopeW));
    }

    return transformNormalToView(n.add(g).normalize());
  })();

  // ---- 反照率：新雪 / 风壳 / 压实雪 三态，外加断面层理 ----
  mat.colorNode = Fn(() => {
    const pk = vPack.clamp(0, 1);
    const cr = vCrust.clamp(0, 1).mul(float(1).sub(pk));   // 手压过的地方风壳早碎了
    const cover = smoothstep(0.002, 0.032, vDep);

    const fresh = vec3(0.900, 0.932, 0.980);    // 新粉雪：最白
    const crustC = vec3(0.878, 0.914, 0.968);   // 风壳：略灰、略致密
    const packC = vec3(0.700, 0.775, 0.900);    // 压实雪：暗且偏蓝
    const ground = vec3(0.086, 0.079, 0.070);   // 露出来的地面 / 岩壁

    // 极细的颗粒：雪不是一张均匀的白纸，近看有糖粒一样的明暗。
    // 210 周期/米（波长 5mm），同样按像素足迹关掉，否则会烂成噪点。
    const gritK = float(1).sub(smoothstep(0.004, 0.016, fwidth(positionWorld.xz).length()));
    const grit = noised(positionWorld.xz.mul(210.0)).x.sub(0.5).mul(0.055)
      .add(noised(positionWorld.xz.mul(41.0)).x.sub(0.5).mul(0.035))
      .mul(gritK);

    let c = mix(mix(fresh, crustC, cr), packC, pk.mul(0.80)).add(grit);

    // 漫反射本身就是多次散射的结果，所以反照率也该带上吸收造成的偏蓝。
    // 归一化到蓝通道，让它只改色相、不整体压暗。
    const tr = iceTransmit;
    const hue = tr.div(tr.z.max(1e-3)).clamp(0, 1);
    c = c.mul(mix(vec3(1, 1, 1), hue, U.sssTint));

    // 断面层理：只在陡坡（被挖开的切面）显现，按世界高度分层
    const yb = positionWorld.y.mul(38.0).add(noised(positionWorld.xz.mul(2.2)).x.mul(1.7));
    const band = yb.fract();
    const line = smoothstep(0.40, 0.50, band).mul(float(1).sub(smoothstep(0.50, 0.60, band)));
    const strata = line.mul(smoothstep(0.30, 0.75, vSlope)).mul(U.strata).mul(cover);
    c = c.mul(float(1).sub(strata.mul(0.20)));

    c = mix(ground, c, cover);

    // 手掌本身在雪上的柔和投影
    const dh = positionWorld.xz.distance(U.handCur.xz);
    const sh = float(1).sub(smoothstep(U.handRadius.mul(0.15), U.handRadius.mul(1.55), dh))
      .mul(0.18).mul(U.handActive);
    return c.mul(float(1).sub(sh)).mul(float(1).sub(U.debugMode.clamp(0, 1)));
  })();

  // 调试通道：把某一个中间量当无光照的颜色直接画出来，用来定位画面上的花纹
  // 到底是哪一步产生的。__snow.U.debugMode.value = 1..5
  const debugColor = Fn(() => {
    const out = vec3(0).toVar();
    const m = U.debugMode;
    If(m.greaterThan(0.5).and(m.lessThan(1.5)), () => {
      out.assign(vec3(vLight.x.clamp(0, 1)));
    }).ElseIf(m.lessThan(2.5), () => {
      out.assign(vec3(vLight.y.clamp(0, 1)));
    }).ElseIf(m.lessThan(3.5), () => {
      out.assign(vec3(vDep.div(U.targetDepth.max(1e-3)).mul(0.5).clamp(0, 1)));
    }).ElseIf(m.lessThan(4.5), () => {
      out.assign(vNrm.normalize().mul(0.5).add(0.5));
    }).ElseIf(m.lessThan(5.5), () => {
      out.assign(vec3(L.k === 0 ? 1 : 0, L.k === 1 ? 1 : 0, L.k === 2 ? 1 : 0));
    }).ElseIf(m.lessThan(6.5), () => {
      // 纯 Lambert：对法线最敏感的探针
      out.assign(vec3(vNrm.normalize().dot(U.sunDir).clamp(0, 1)));
    });
    return out;
  })();

  // ---- 光线步进的结果直接接进光照 ----
  // 天空遮蔽只作用于间接光（环境贴图），这正是掌印内部变暗的物理原因
  mat.aoNode = vLight.y.clamp(0, 1);
  // 太阳可见度乘进阴影项：近处是雪堤在自己脚下的投影，远处是山体的自阴影 ——
  // 后者的距离 shadow map 根本覆盖不到
  mat.receivedShadowNode = (shadow) => shadow.mul(vLight.x.clamp(0, 1));

  mat.roughnessNode = Fn(() => {
    const pk = vPack.clamp(0, 1);
    const cr = vCrust.clamp(0, 1).mul(float(1).sub(pk));
    const n = noised(positionWorld.xz.mul(3.5)).x.sub(0.5).mul(0.10);
    // 新雪是无数松散冰晶面 → 中等粗糙；风壳被风磨过、压实雪被压过 → 更光滑
    const base = mix(mix(float(0.68), float(0.38), cr), float(0.30), pk.mul(0.9))
      .add(n).clamp(0.13, 0.92);

    // 远处按距离加粗糙度。一个像素在 100m 外覆盖十几厘米的雪面，里面本来就有
    // 无数朝向；用一个窄高光去拟合它，等于把顶点法线的插值误差放大上百倍 ——
    // 远景的菱形斜纹就是这么来的。把亚像素的法线方差折算成粗糙度是标准做法。
    const dist = cameraPosition.distance(positionWorld);
    return mix(base, float(0.90), smoothstep(25.0, 140.0, dist));
  })();

  // ---- 次表面散射 ----
  //
  // 雪是稠密散射介质：光折射进冰晶、在里面随机游走几十上百次、再从附近漫出来。
  // 所以要建模的不是「透明度」，而是**光在雪里走了多远**，然后用 Beer-Lambert
  // 配上冰的吸收系数得到出射颜色 —— 蓝色是算出来的，不是调出来的。

  mat.thicknessColorNode = Fn(() => {
    const thin = float(1).sub(smoothstep(0.02, 0.17, vDep));           // 薄雪透得最多
    const crest = vCav.negate().max(0).div(float(cell)).clamp(0, 1);   // 雪堤的薄棱也透
    const amount = thin.mul(0.55).add(crest.mul(0.35)).add(U.sssAmount)
      .mul(vLight.x.clamp(0, 1))
      .mul(float(1).sub(vPack.clamp(0, 1).mul(0.40)));
    return iceTransmit.mul(amount);
  })();

  // 各向同性的绕射项。它不乘 NdotL，所以会绕到背光面去 ——
  // 这就是次表面散射让明暗交界变柔的原因，也是雪不像石膏的关键。
  mat.thicknessAmbientNode = Fn(() =>
    U.sssWrap.div(float(1).add(vPack.clamp(0, 1).mul(1.8))))();

  mat.thicknessDistortionNode = float(0.40);
  mat.thicknessAttenuationNode = float(0.90);
  mat.thicknessPowerNode = float(2.0);
  mat.thicknessScaleNode = float(3.6);

  // ---- 冰晶闪烁 + 逆反射 + 光标环 ----
  mat.emissiveNode = Fn(() => {
    const N = vNrm.normalize();
    const V = cameraPosition.sub(positionWorld).normalize();
    const Lv = U.sunDir;
    const Hv = Lv.add(V).normalize();
    const cover = smoothstep(0.002, 0.032, vDep);
    // 注意：这里只有高度场自遮挡，拿不到 shadow map。冰晶走 emissive 通道，
    // 而 emissive 在光照之前就求值了，所以石头/树投下的影子里雪面照样会闪。
    // 试过用 toVar 把 receivedShadowNode 的结果截获出来，求值顺序不配合，没成。
    const sunVis = vLight.x.clamp(0, 1);

    // 表层松散冰晶的密度。新雪最多；被压实或被风烧结成壳之后就没有了 ——
    // 所以推过的地方不闪，刚落的雪最闪。
    const hoar = float(1)
      .sub(vPack.clamp(0, 1).mul(0.92))
      .sub(vCrust.clamp(0, 1).mul(0.50))
      .clamp(0, 1);

    const dist = cameraPosition.distance(positionWorld);
    const fade = (a, b) => float(1).sub(smoothstep(a, b, dist));

    const thr = float(1).sub(U.crystals.mul(0.42));

    // 冰晶的取向分布。
    //
    // 注意别把片晶做成「完全躺平的镜子」：那样只有太阳和视线都很陡时才会闪，
    // 低角度太阳下整片雪地会一个闪点都没有。干雪之所以在任何角度都闪，
    // 是因为晶面取向本来就很散。所以这里用一个**宽分布 + 轻微朝上的偏置**。
    const facetBase = mix(N, vec3(0, 1, 0), 0.28).normalize();

    const crystalAt = (freq, seed, power, spread) => {
      const sp = positionWorld.xz.mul(freq);
      const cid = sp.floor().add(8192.0);
      const cx = cid.x.toUint();
      const cy = cid.y.toUint();
      const h = (a, b, o) => hash(cx.mul(uint(a)).add(cy.mul(uint(b))).add(uint(seed + o)));
      const r1 = h(1973, 9277, 0);
      const r2 = h(7919, 2699, 17);
      const r3 = h(6151, 3079, 91);
      const r4 = h(4001, 5011, 53);
      const r5 = h(3299, 8161, 131);
      const r6 = h(5387, 6733, 197);

      const j = vec3(r3.sub(0.5), r5.sub(0.5), r6.sub(0.5));
      const nj = facetBase.add(j.mul(spread)).normalize();

      // 冰晶是格子里的一个「点」，不是整格 —— 否则近看会变成一片小方块
      const pt = float(1).sub(smoothstep(0.12, 0.40, sp.fract().sub(vec2(r1, r2)).length()));
      return nj.dot(Hv).clamp(0, 1).pow(power)
        .mul(smoothstep(thr, thr.add(0.13), r4))
        .mul(pt);
    };

    // 三个尺度按距离淡出：近处细密、远处粗疏，避免远景闪成一片噪点
    const g = crystalAt(52.0, 0, 60.0, 1.15).mul(0.8).mul(fade(16.0, 38.0))
      .add(crystalAt(165.0, 331, 110.0, 1.40).mul(fade(5.0, 15.0)))
      .add(crystalAt(460.0, 777, 190.0, 1.70).mul(0.9).mul(fade(1.6, 5.5)));

    // 冰有色散，三个通道用略不同的指数 → 闪点边缘泛一点彩虹
    const disp = vec3(g.pow(0.90), g, g.pow(1.14));
    const glint = disp.mul(U.sparkle).mul(U.sunPower).mul(2.6).mul(cover).mul(sunVis).mul(hoar);

    let e = U.sunColor.mul(glint);

    // 逆反射：顺着阳光看过去时雪特别亮（颗粒间多次散射的结果）
    const retro = V.dot(Lv).clamp(0, 1).pow(2.5).mul(0.048)
      .mul(U.sunPower).mul(cover).mul(sunVis);
    e = e.add(U.sunColor.mul(retro));

    // 掠射角的天光光泽：菲涅耳权重的一层柔光，雪由此有丝绒质感而不是哑光纸。
    // 指数 4.5 意味着它在掠射角上对法线极其敏感，而远景恰恰全是掠射角 ——
    // 所以和高光一样按距离淡出，那本来也是只有近看才成立的质感。
    const nv = N.dot(V).clamp(0, 1);
    const crK = vCrust.clamp(0, 1).mul(float(1).sub(vPack.clamp(0, 1)));
    const sheen = float(1).sub(nv).pow(4.5).mul(0.30).mul(cover)
      .mul(vLight.y.clamp(0, 1)).mul(crK.mul(0.9).add(1.0))
      .mul(float(1).sub(smoothstep(25.0, 110.0, dist)));
    e = e.add(U.skyHorizon.mul(sheen));

    const dbg = U.debugMode.clamp(0, 1);
    if (!isFine) return mix(e, debugColor, dbg);

    // 手的位置指示环（只有可交互的 L0 需要）
    const dh = positionWorld.xz.distance(U.handCur.xz);
    const R = U.handRadius;
    const ring = smoothstep(R.mul(0.90), R.mul(0.985), dh)
      .mul(float(1).sub(smoothstep(R.mul(0.985), R.mul(1.075), dh)));
    return mix(e.add(vec3(0.42, 0.68, 1.0).mul(ring).mul(0.45).mul(U.handActive)), debugColor, dbg);
  })();

  return mat;
}

// ---------------------------------------------------------------- 建级（粗 -> 细）
//
// 倒着建：细层要引用最粗那一级的光照缓冲，所以粗的必须先存在。

const _built = [];
for (let k = LEVELS - 1; k >= 0; k--) _built.push(createLevel(k, _built[0] || null));
export const levels = _built.slice().reverse();     // levels[0] 最细
export const L0 = levels[0];
export const computeDeform = L0.computeDeform;

// ---------------------------------------------------------------- 形变留存的两个 pass

// 写入：只跑 L0 覆盖的那一小块（212² ≈ 4.5 万格），不是整张 2048²。
// 形变图是环形寻址的，L0 覆盖的区域在缓冲区里并不连续，所以按**世界坐标**
// 组织线程：每个线程负责 L0 附近的一个形变格，自己算出该写到缓冲区哪里。
const computeStashWrite = (() => {
  const W = int(STASH_WIN);
  const idx = instanceIndex.toInt();
  // 以 L0 窗口中心为基准的世界格子坐标
  const c0 = U.fieldCenter.xz.div(STASH_CELL).floor();
  const wx = c0.x.toInt().add(idx.mod(W)).sub(int(STASH_WIN >> 1));
  const wy = c0.y.toInt().add(idx.div(W)).sub(int(STASH_WIN >> 1));
  const w = vec2(wx.toFloat().mul(STASH_CELL), wy.toFloat().mul(STASH_CELL));

  // 这个形变格落在 L0 的哪一格上
  const gx = w.x.div(L0.cell).sub(L0.ocx.toFloat()).add(0.5).floor().toInt();
  const gy = w.y.div(L0.cell).sub(L0.ocy.toFloat()).add(0.5).floor().toInt();

  return Fn(() => {
    const inL0 = gx.greaterThan(int(1)).and(gx.lessThan(int(GRID - 2)))
      .and(gy.greaterThan(int(1))).and(gy.lessThan(int(GRID - 2)));
    If(inL0, () => {
      const tc = L0.at(L0.touchBuf, gx, gy);
      const h = L0.at(L0.height, gx, gy);
      const pk = L0.at(L0.packed, gx, gy);
      const base = snowBaseAt(w);
      // 只记录手碰过的格子；没碰过的写 0，这样痕迹被埋掉之后留存也会自己释放
      const rec = tc.greaterThan(0.02);
      stashBuf.element(sIdx(sfmod(wx.sub(socx)), sfmod(wy.sub(socy))))
        .assign(select(rec, vec2(h.sub(base), pk), vec2(0)));
    });
  })().compute(STASH_WIN * STASH_WIN);
})();

// 补脏格：整张 2048² 扫一遍。只在窗口真的滑动过的那一帧跑 ——
// 窗口按 16m 对齐，走路时大约六十帧才碰上一次。
const computeStashRefresh = (() => {
  const idx = instanceIndex.toInt();
  const bx = idx.mod(SN);
  const by = idx.div(SN);
  const gx = sfmod(bx.sub(socx));
  const gy = sfmod(by.sub(socy));
  // 世界块号（窗口起点必然是 128 的整数倍，所以整除是精确的）
  const wb = vec2(socx.add(gx).div(int(128)).toFloat(), socy.add(gy).div(int(128)).toFloat());
  const want = wb.x.mul(2048.0).add(wb.y);
  return Fn(() => {
    If(stashTag.element(instanceIndex).sub(want).abs().greaterThan(0.25), () => {
      stashBuf.element(instanceIndex).assign(vec2(0));
      stashTag.element(instanceIndex).assign(want);
    });
  })().compute(STASH_N * STASH_N);
})();

// ---------------------------------------------------------------- 几何

/**
 * GRID x GRID 顶点、行主序。position 属性只用来给包围盒一个大概值 ——
 * 真正的世界坐标是 positionNode 从窗口起点算出来的。
 *
 * hole = true 时挖掉中间那块做成环：内层正好把洞盖住，两层不重叠也不打架。
 */
function gridGeometry(cell, hole) {
  const n = GRID;
  const half = (n - 1) * cell * 0.5;
  const pos = new Float32Array(n * n * 3);
  for (let y = 0, i = 0; y < n; y++) {
    for (let x = 0; x < n; x++, i += 3) {
      pos[i] = x * cell - half;
      pos[i + 2] = y * cell - half;
    }
  }
  const idx = [];
  for (let y = 0; y < n - 1; y++) {
    const skipY = hole && y >= HOLE_LO && y < HOLE_HI;
    for (let x = 0; x < n - 1; x++) {
      if (skipY && x >= HOLE_LO && x < HOLE_HI) continue;
      const a = y * n + x, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  g.boundingBox = new THREE.Box3(
    new THREE.Vector3(-1e5, -1e5, -1e5), new THREE.Vector3(1e5, 1e5, 1e5));
  return g;
}

// ---------------------------------------------------------------- 裙边
//
// L2 之外不再模拟：高度直接等于「地形 + 平衡雪深」。用的是同一个 snowBaseFrom，
// 和 L2 的收敛值一致，接缝看不出来。做成四条带子围一圈，中间留给 clipmap。

const skirtCenter = uniform(new THREE.Vector2());

function createSkirt(scene) {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.name = 'snow_skirt';
  mat.metalnessNode = float(0);
  mat.roughnessNode = float(0.86);

  // 几何体的顶点存的是相对窗口中心的偏移，加上中心才是世界坐标
  mat.positionNode = Fn(() => {
    const w = positionLocal.xz.add(skirtCenter);
    const t = terrainSample(w);
    const h = snowBaseFrom(w, t).mul(U.snowProgress);
    return vec3(w.x, t.x.add(h).sub(0.06), w.y);
  })();

  mat.colorNode = Fn(() => {
    const t = terrainSample(positionWorld.xz);
    const bare = smoothstep(0.62, 1.60, vec2(t.y, t.z).length());
    const n = mx_fractal_noise_float(vec3(positionWorld.xz.mul(0.35), 3.0), 3, 2.2, 0.55, 1.0)
      .mul(0.5).add(0.5);
    return mix(mix(vec3(0.780, 0.822, 0.900), vec3(0.895, 0.925, 0.980), n),
      vec3(0.086, 0.079, 0.070), bare);
  })();

  const inner = spanOf(LEVELS - 1) * 0.5 - cellOf(LEVELS - 1) * 2;   // 往里咬两格，别留缝
  const band = (FAR_SPAN + inner) / 2;
  const span = FAR_SPAN - inner;

  const strip = (cx, cz, w, d, sw, sd) => {
    const g = new THREE.PlaneGeometry(w, d, sw, sd);
    g.rotateX(-Math.PI / 2);
    g.translate(cx, 0, cz);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    m.receiveShadow = false;
    m.castShadow = false;
    m.renderOrder = LEVELS;
    return m;
  };

  const group = new THREE.Group();
  group.name = 'skirt';
  group.matrixAutoUpdate = false;
  group.add(strip(0, -band, FAR_SPAN * 2, span, 220, 90));
  group.add(strip(0, band, FAR_SPAN * 2, span, 220, 90));
  group.add(strip(-band, 0, span, inner * 2, 90, 110));
  group.add(strip(band, 0, span, inner * 2, 90, 110));
  scene.add(group);
  return group;
}

// ---------------------------------------------------------------- 场景组装

export function createSnowField(scene) {
  // L1/L2 拓扑一模一样，索引缓冲共用
  let ringGeo = null;
  for (const L of levels) {
    let geo;
    if (L.isFine) {
      geo = gridGeometry(L.cell, false);
    } else {
      if (!ringGeo) ringGeo = gridGeometry(L.cell, true);
      geo = ringGeo;
    }
    const mesh = new THREE.Mesh(geo, L.material);
    mesh.name = `snow_L${L.k}`;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;        // 顶点全靠 positionNode 摆，包围盒没意义
    mesh.matrixAutoUpdate = false;     // 模型矩阵必须保持单位阵
    mesh.renderOrder = L.k;
    scene.add(mesh);
    L.mesh = mesh;
  }
  createSkirt(scene);
  return levels;
}

// ---------------------------------------------------------------- 每帧：窗口对齐
//
// 三级共用一个对齐步长 SNAP（= 最粗那级的格子），所以各级格线永远互相对齐，
// 外层的洞正好等于内层的覆盖。相机走过 SNAP 的整数倍窗口才滑一格，
// L0 于是一次滑 16 格 —— 一帧补 16 x 448 ≈ 七千个格子，不值一提。

const _snap = new THREE.Vector2();

export function updateClipmap(x, z) {
  const px = Math.round(x / SNAP) * SNAP;
  const pz = Math.round(z / SNAP) * SNAP;
  for (const L of levels) {
    L.oc.value.set(
      Math.round(px / L.cell) - GRID / 2,
      Math.round(pz / L.cell) - GRID / 2,
    );
  }
  skirtCenter.value.set(px, pz);
  U.fieldCenter.value.set(px, 0, pz);

  // 形变图按 16m 对齐（= 128 格）。粒度粗是故意的：窗口一动就得整张 2048²
  // 扫一遍补脏格，按 16m 走的话六十帧才摊上一次。
  const sx = Math.round(px / STASH_SNAP) * STASH_SNAP / STASH_CELL - STASH_N / 2;
  const sz = Math.round(pz / STASH_SNAP) * STASH_SNAP / STASH_CELL - STASH_N / 2;
  stashMoved = sx !== stashOC.value.x || sz !== stashOC.value.y;
  stashOC.value.set(sx, sz);

  return _snap.set(px, pz);
}

let stashMoved = true;

/** 形变留存：写入 + （必要时）补脏格。要排在 deform 之后、accumulate 之前。 */
export function stashSnow(renderer) {
  if (stashMoved) { renderer.compute(computeStashRefresh); stashMoved = false; }
  renderer.compute(computeStashWrite);
}

/** 清空积雪时把留存也清掉，否则「清空」之后旧痕迹会立刻被补回来 */
export function clearStash(renderer) {
  stashOC.value.set(stashOC.value.x + STASH_N * 3, stashOC.value.y + STASH_N * 3);
  renderer.compute(computeStashRefresh);
  stashMoved = true;
}

// ---------------------------------------------------------------- 每帧：GPU
//
// 粗层先算：细层的光照要读最粗那级的太阳可见度。

/** 补脏格。必须排在 deform 前面 —— 手不能去动一块还没重填的格子。 */
export function refreshSnow(renderer) {
  for (let i = levels.length - 1; i >= 0; i--) renderer.compute(levels[i].computeRefresh);
}

export function stepSnow(renderer) {
  for (let i = levels.length - 1; i >= 0; i--) {
    renderer.compute(levels[i].computeRelax);
    renderer.compute(levels[i].computeAccumulate);
  }
}

export function lightSnow(renderer) {
  for (let i = levels.length - 1; i >= 0; i--) renderer.compute(levels[i].computeLighting);
}

export function fillSnow(renderer, depth) {
  clearStash(renderer);
  U.fillValue.value = depth;
  for (const L of levels) renderer.compute(L.computeFill);
}

// ---------------------------------------------------------------- 给雪花用
//
// 返回**绝对**表面高度。L0 窗口内用 L0（手边的雪堤要准），外面用 L1（够大够用）。

export function sampleHeightXZ(xz) {
  return select(L0.insideWindow(xz.x, xz.y),
    L0.surfAt(xz.x, xz.y),
    levels[1].surfAt(xz.x, xz.y));
}
