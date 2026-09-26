/**
 * sculpt.js — 模具扣出来的雪雕
 *
 * 每个雪雕是一块**可以改的**三维距离场（体素格上存的 SDF，单位米），
 * 网格随时从它重新抽出来。这是它能和场景长在一起的根本：
 *
 *   - 往上摞 / 挨着放：新模具不是另起一个网格硬插进去，而是用软并集
 *     **合并进同一块距离场**，接缝处自己长出圆角 —— 雪捏在一起就是这样。
 *   - 用手抚平 / 推 / 堆：手直接改距离场（局部平滑、削、鼓），改哪儿就只
 *     重抽那一小块网格，所以是实时的。
 *   - 和地面：放下时拿读回的真实雪面，在距离场里和「地面」也做一次软并集，
 *     雕塑的脚自己外扩成一圈圆角、顺着坡没进雪里。
 *
 * 实现上分三层：
 *
 *   1. 模具场（每种模具一份，归一化，缓存）
 *      molds.js 的 SDF 在 3.4%（归一化）的格子上采样一次。之后放置时直接乘尺度拿来用，
 *      合并时三线性重采样 —— 慢的 SDF 求值一种模具只做一次。
 *
 *   2. 雪雕（每个一份，单位米）
 *      自己的局部坐标系（原点在底面中心、x 沿朝向）+ 一块体素格。
 *      体素格按 24³ 分块，每块一个 Mesh。改动只把碰到的块标脏，块内重抽网格不到 1ms。
 *
 *   3. 抽网格（Surface Nets）
 *      每个跨过表面的体素放一个顶点，位置取它 12 条棱上过零点的平均；
 *      法线取距离场的梯度（三线性插值），所以表面是光滑的，没有棋盘格。
 *      分块时每块多算一圈低侧邻格的顶点，相邻块算出来的是同一个点，接缝是严丝合缝的。
 */

import * as THREE from 'three/webgpu';
import {
  Fn, float, vec3, vec4, mix, smoothstep, select, varying, positionWorld, normalWorld, cameraPosition,
  transformNormalToView, mx_noise_vec3, mx_noise_float, fwidth, uniform,
} from 'three/tsl';

import { U } from './config.js';
import { MOLDS, lumps } from './molds.js';
import {
  L0, iceTransmitOf, scatterPathOf, snowGrit, snowAlbedo, snowRoughness, windGrainGrad,
  snowSparkle, sssAmountOf, sssWrapOf, applySssConstants,
} from './snowfield.js';

// ---------------------------------------------------------------- 常量

const VOX = 0.034;        // 体素边长（归一化）。模具 55cm 时约 1.9cm，比雪地网格细三倍
const PAD = 0.22;         // 模具场四周留的余量（归一化）：给脚下圆角、给手往外堆雪
const CH = 24;            // 分块边长（体素）
const MAX_DIM = 260;      // 一块雪雕的体素格每边最多这么多，再大就不往里合并了
const MAX_KEEP = 96;
const KEEP_DIST = 130;    // 超出这个距离就丢（GPU 的形变留存也只有 ±128m）
const GROW_T = 0.32;
const BIG = 1e3;          // 「远在外面」
const EPS_GROUND = 0.02;  // 脚下那圈圆角最后压到真实雪面以下这么多（米），由雪盖住

const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/** 多项式软并集 / 软交集（和 molds.js 里那对一样，这里要逐体素用，写成内联的） */
const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a, b, k) => -smin(-a, -b, k);

// ---------------------------------------------------------------- 1. 模具场（归一化，缓存）

const fieldCache = new Map();

function moldField(type) {
  if (fieldCache.has(type)) return fieldCache.get(type);
  const M = MOLDS[type] || MOLDS[0];
  const [bx0, bx1, by1, bz0, bz1] = M.bounds;
  const x0 = bx0 - PAD, y0 = -0.25, z0 = bz0 - PAD;
  const nx = Math.ceil((bx1 + PAD - x0) / VOX) + 1;
  const ny = Math.ceil((by1 + PAD - y0) / VOX) + 1;
  const nz = Math.ceil((bz1 + PAD - z0) / VOX) + 1;
  const F = new Float32Array(nx * ny * nz);
  let n = 0;
  for (let k = 0; k < nz; k++) {
    const z = z0 + k * VOX;
    for (let j = 0; j < ny; j++) {
      const y = y0 + j * VOX;
      for (let i = 0; i < nx; i++) {
        const x = x0 + i * VOX;
        F[n++] = M.sdf(x, y, z) + lumps(x, y, z);
      }
    }
  }
  const fd = { F, nx, ny, nz, x0, y0, z0, top: M.top };
  fieldCache.set(type, fd);
  return fd;
}

/** 模具场里三线性取值（归一化坐标）；出了格子就当是远在外面 */
function sampleField(fd, x, y, z) {
  const fx = (x - fd.x0) / VOX, fy = (y - fd.y0) / VOX, fz = (z - fd.z0) / VOX;
  const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
  if (i < 0 || j < 0 || k < 0 || i >= fd.nx - 1 || j >= fd.ny - 1 || k >= fd.nz - 1) return 1.0;
  const tx = fx - i, ty = fy - j, tz = fz - k;
  const F = fd.F, sx = 1, sy = fd.nx, sz = fd.nx * fd.ny;
  const o = i + j * sy + k * sz;
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(F[o], F[o + sx], tx), l(F[o + sy], F[o + sy + sx], tx), ty),
    l(l(F[o + sz], F[o + sz + sx], tx), l(F[o + sz + sy], F[o + sz + sy + sx], tx), ty),
    tz,
  );
}

// ---------------------------------------------------------------- 3. Surface Nets（分块）

// 体素的 8 个角：下标 = dx + 2dy + 4dz
const CORNER = [];
for (let c = 0; c < 8; c++) CORNER.push([c & 1, (c >> 1) & 1, (c >> 2) & 1]);
// 12 条棱：只差一位的两个角
const EDGES = [];
for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) EDGES.push([a, a | bit]);

/**
 * 从体素格 g 里抽 [ci0,ci1)×[cj0,cj1)×[ck0,ck1) 这些体素负责的那部分网格。
 * g = { F, nx, ny, nz, x0, y0, z0, h }，坐标单位随 g（米或归一化都行）。
 *
 * 一条格点棱上的四边形由它「坐标最大的那个体素」负责；四边形还会用到低侧的邻格，
 * 所以顶点要多算一圈 [c0-1, c1)。相邻两块在这一圈上算出来的是同一个点。
 */
function meshRange(g, ci0, ci1, cj0, cj1, ck0, ck1) {
  const { F, nx, ny, nz, x0, y0, z0, h } = g;
  const sy = nx, sz = nx * ny;
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  ci1 = Math.min(ci1, cx); cj1 = Math.min(cj1, cy); ck1 = Math.min(ck1, cz);
  const vi0 = Math.max(ci0 - 1, 0), vj0 = Math.max(cj0 - 1, 0), vk0 = Math.max(ck0 - 1, 0);
  const W = ci1 - vi0, H = cj1 - vj0, D = ck1 - vk0;
  if (W <= 0 || H <= 0 || D <= 0) return null;
  const vid = new Int32Array(W * H * D).fill(-1);
  const cell = (i, j, k) => (i - vi0) + W * ((j - vj0) + H * (k - vk0));

  const pos = [];
  const nrm = [];
  const v = new Float32Array(8);

  // 格点上的梯度（中心差分，边上钳住）
  const gAt = (i, j, k, out) => {
    const o = i + j * sy + k * sz;
    const ip = i < nx - 1 ? o + 1 : o, im = i > 0 ? o - 1 : o;
    const jp = j < ny - 1 ? o + sy : o, jm = j > 0 ? o - sy : o;
    const kp = k < nz - 1 ? o + sz : o, km = k > 0 ? o - sz : o;
    out[0] = F[ip] - F[im]; out[1] = F[jp] - F[jm]; out[2] = F[kp] - F[km];
  };
  const gc = [0, 0, 0];

  // 8 个角相对体素原点的下标偏移
  const off = CORNER.map((C) => C[0] + C[1] * sy + C[2] * sz);

  for (let k = vk0; k < ck1; k++) {
    for (let j = vj0; j < cj1; j++) {
      for (let i = vi0; i < ci1; i++) {
        const o = i + j * sy + k * sz;
        // 绝大多数体素离表面很远，8 个角同号。一发现异号就停 —— 通常读两三个角就判完了，
        // 比老老实实读满 8 个再看掩码快好几倍（整块重抽的耗时几乎全在这儿）。
        const in0 = F[o] < 0;
        let mixed = false;
        for (let c = 1; c < 8; c++) if ((F[o + off[c]] < 0) !== in0) { mixed = true; break; }
        if (!mixed) continue;
        for (let c = 0; c < 8; c++) v[c] = F[o + off[c]];

        let ax = 0, ay = 0, az = 0, n = 0;
        for (const [a, b] of EDGES) {
          if ((v[a] < 0) === (v[b] < 0)) continue;
          const t = v[a] / (v[a] - v[b]);
          const A = CORNER[a], B = CORNER[b];
          ax += A[0] + (B[0] - A[0]) * t;
          ay += A[1] + (B[1] - A[1]) * t;
          az += A[2] + (B[2] - A[2]) * t;
          n++;
        }
        const fx = ax / n, fy = ay / n, fz = az / n;
        vid[cell(i, j, k)] = pos.length / 3;
        pos.push(x0 + (i + fx) * h, y0 + (j + fy) * h, z0 + (k + fz) * h);

        // 法线：8 个角上的梯度三线性插值到顶点处
        let gx = 0, gy = 0, gz = 0;
        for (let c = 0; c < 8; c++) {
          const C = CORNER[c];
          const w = (C[0] ? fx : 1 - fx) * (C[1] ? fy : 1 - fy) * (C[2] ? fz : 1 - fz);
          gAt(i + C[0], j + C[1], k + C[2], gc);
          gx += gc[0] * w; gy += gc[1] * w; gz += gc[2] * w;
        }
        const gl = Math.hypot(gx, gy, gz) || 1;
        nrm.push(gx / gl, gy / gl, gz / gl);
      }
    }
  }
  if (!pos.length) return null;

  const idx = [];
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    const A = a * 3, B = b * 3, C = c * 3, Dd = d * 3;
    // 沿短的那条对角线切，三角形更匀
    const ac = Math.hypot(pos[A] - pos[C], pos[A + 1] - pos[C + 1], pos[A + 2] - pos[C + 2]);
    const bd = Math.hypot(pos[B] - pos[Dd], pos[B + 1] - pos[Dd + 1], pos[B + 2] - pos[Dd + 2]);
    // 绕序对齐到梯度（朝外）
    const ux = pos[B] - pos[A], uy = pos[B + 1] - pos[A + 1], uz = pos[B + 2] - pos[A + 2];
    const wx = pos[C] - pos[A], wy = pos[C + 1] - pos[A + 1], wz = pos[C + 2] - pos[A + 2];
    const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    let dot = 0;
    for (const q of [A, B, C, Dd]) dot += fx * nrm[q] + fy * nrm[q + 1] + fz * nrm[q + 2];
    const tris = ac <= bd ? [a, b, c, a, c, d] : [a, b, d, b, c, d];
    for (let t = 0; t < 6; t += 3) {
      if (dot < 0) idx.push(tris[t], tris[t + 2], tris[t + 1]);
      else idx.push(tris[t], tris[t + 1], tris[t + 2]);
    }
  };

  for (let k = ck0; k < ck1; k++) {
    for (let j = cj0; j < cj1; j++) {
      for (let i = ci0; i < ci1; i++) {
        const o = i + j * sy + k * sz;
        const s0 = F[o] < 0;
        // x 向的格点棱
        if (j >= 1 && k >= 1 && s0 !== (F[o + 1] < 0)) {
          quad(vid[cell(i, j - 1, k - 1)], vid[cell(i, j, k - 1)], vid[cell(i, j, k)], vid[cell(i, j - 1, k)]);
        }
        // y 向
        if (i >= 1 && k >= 1 && s0 !== (F[o + sy] < 0)) {
          quad(vid[cell(i - 1, j, k - 1)], vid[cell(i, j, k - 1)], vid[cell(i, j, k)], vid[cell(i - 1, j, k)]);
        }
        // z 向
        if (i >= 1 && j >= 1 && s0 !== (F[o + sz] < 0)) {
          quad(vid[cell(i - 1, j - 1, k)], vid[cell(i, j - 1, k)], vid[cell(i, j, k)], vid[cell(i - 1, j, k)]);
        }
      }
    }
  }
  if (!idx.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1)
    : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

/** 预览虚影用：整块模具场一次抽完（底面以下切平） */
const ghostCache = new Map();
function ghostGeometry(type) {
  if (ghostCache.has(type)) return ghostCache.get(type);
  const fd = moldField(type);
  const F = new Float32Array(fd.F.length);
  for (let k = 0, n = 0; k < fd.nz; k++) {
    for (let j = 0; j < fd.ny; j++) {
      const y = fd.y0 + j * VOX;
      for (let i = 0; i < fd.nx; i++, n++) F[n] = Math.max(fd.F[n], -(y + 0.06));
    }
  }
  const geo = meshRange({ ...fd, F, h: VOX }, 0, fd.nx, 0, fd.ny, 0, fd.nz)
    || new THREE.BufferGeometry();
  ghostCache.set(type, geo);
  return geo;
}

// ---------------------------------------------------------------- 材质

/**
 * 模具扣出来的雪本来就是压实过的，但不是地上被手推过那种「压实到发蓝」——
 * 取一半。朝上的面再积一层新雪（pk 往 0 走），和地上刚落的雪一个样子。
 */
const SCULPT_PACK = 0.5;

/**
 * 雪雕的材质 —— 和地上的雪**是同一套着色**（snowfield.js 里「雪面着色」那几个函数），
 * 不是另写一份「差不多」的。原先两份各写各的，雕塑偏暖、哑光、没有风纹没有闪点，
 * 脚下一圈就是一道明显的分界。
 *
 * 要让接缝两侧算出同一个颜色，光公式一样还不够，**输入**也得一样：
 *
 *   1. 贴地的那一截直接读地面的缓冲区
 *      顶点阶段按世界 xz 取脚下那一格的压实度 / 风壳 / 雪深 / 太阳可见度 / 天空遮蔽，
 *      离雪面越近越靠地面的值，30cm 以上才是雕塑自己的值。
 *   2. 纹理坐标对齐
 *      风纹、颗粒、闪点都是按世界坐标铺的。雕塑做三平面投影，朝上的面走 xz ——
 *      和地面是同一个投影，接缝处图案是连续的。侧面换成 zy / xy。
 */
function sculptMaterial() {
  const m = new THREE.MeshSSSNodeMaterial();
  m.ior = 1.31;            // 冰：F0≈0.018
  m.metalness = 0;
  m.name = 'snow_sculpt';
  // 受影时沿法线往外挪几厘米再查阴影图。
  // 光滑的曲面在明暗交界附近，正面和背面在阴影图里的深度几乎重合，
  // 查出来是一条条的自阴影条纹（shadow acne）—— 塔身上会满是竖纹，像棋盘格又回来了。
  // 全局调 normalBias 会让所有物体的影子脱离脚底，所以只在雪雕的材质上做。
  m.receivedShadowPositionNode = positionWorld.add(normalWorld.mul(0.045));

  // ---- 顶点阶段：脚下那一格地面 ----
  const wp = positionWorld;
  const inside = L0.insideWindow(wp.x, wp.z);
  const gSurf = L0.surfAt(wp.x, wp.z);
  const gLight = L0.sampleAt(L0.lightB, wp.x, wp.z);
  // 离雪面多高：0 = 贴着雪面（完全用地面的值），30cm 以上 = 雕塑自己的值
  const nearG = float(1).sub(smoothstep(0.02, 0.30, wp.y.sub(gSurf))).mul(select(inside, float(1), float(0)));
  const vIn = varying(vec4(
    mix(float(SCULPT_PACK), L0.sampleAt(L0.packed, wp.x, wp.z).clamp(0, 1), nearG),   // 压实度
    mix(float(0), L0.sampleAt(L0.crust, wp.x, wp.z).clamp(0, 1), nearG),               // 风壳
    mix(float(1), gLight.x.clamp(0, 1), nearG),                                         // 太阳可见度
    mix(float(1), gLight.y.clamp(0, 1), nearG),                                         // 天空遮蔽
  ), 'vSculptIn');
  // 「雪深」：光程和风纹强弱都按它算。雕塑整体当成一块厚雪
  const vDepth = varying(mix(float(0.30), L0.sampleAt(L0.height, wp.x, wp.z), nearG), 'vSculptDep');

  // ---- 片元阶段 ----
  const N0 = normalWorld.normalize();
  // 三平面权重：四次方让过渡窄一点，侧面和顶面各管各的
  const w4 = N0.abs().pow(vec3(4.0));
  const wt = w4.div(w4.x.add(w4.y).add(w4.z).max(1e-4));
  const p = positionWorld;

  // 朝上的面积一层新雪：压实度往 0 走，和地上刚落的雪一样白、一样闪
  const coat = smoothstep(0.50, 0.85, N0.y.add(mx_noise_float(p.mul(9.0)).mul(0.15)))
    .mul(U.snowCoat.mul(1.4).clamp(0, 1));
  const pk = vIn.x.mul(float(1).sub(coat.mul(0.85)));
  const crust = vIn.y;
  const sunVis = vIn.z;
  const sky = vIn.w;

  // 闪点格子只能挑一个平面：取法线最朝向的那个轴
  const topDom = N0.y.abs().greaterThan(N0.x.abs().max(N0.z.abs()));
  const p2dom = select(topDom, p.xz, select(N0.x.abs().greaterThan(N0.z.abs()), p.zy, p.xy));

  const iceTransmit = iceTransmitOf(scatterPathOf(vDepth, pk, crust, float(0)));

  m.normalNode = Fn(() => {
    // 顶面：和地面同一套风纹 + 雪粒（接缝处连续）；侧面：同一套雪粒，按各自平面投影
    const gT = windGrainGrad(p.xz, crust, vDepth, pk);
    const gX = windGrainGrad(p.zy, crust, vDepth, pk);
    const gZ = windGrainGrad(p.xy, crust, vDepth, pk);
    const b = vec3(gT.x.negate(), 0, gT.y.negate()).mul(wt.y)
      .add(vec3(0, gX.y.negate(), gX.x.negate()).mul(wt.x))
      .add(vec3(gZ.x.negate(), gZ.y.negate(), 0).mul(wt.z))
      // 手拍出来的大一点的起伏（地面没有，但它离地 30cm 以上才明显）
      .add(mx_noise_vec3(p.mul(14.0)).mul(0.05).mul(float(1).sub(smoothstep(0.015, 0.10, fwidth(p).length()))));
    // 只保留切向分量，法线不会被推得翻过去
    const t = b.sub(N0.mul(b.dot(N0)));
    return transformNormalToView(N0.add(t).normalize());
  })();

  m.colorNode = Fn(() => {
    const grit = snowGrit(p.xz).mul(wt.y).add(snowGrit(p.zy).mul(wt.x)).add(snowGrit(p.xy).mul(wt.z));
    return snowAlbedo(pk, crust, grit, iceTransmit);
  })();

  m.roughnessNode = Fn(() => {
    const dist = cameraPosition.distance(p);
    return mix(snowRoughness(pk, crust, p2dom), float(0.90), smoothstep(25.0, 140.0, dist));
  })();

  // 光照接法和地面一样：天空遮蔽给间接光，高度场的太阳可见度乘进阴影项
  m.aoNode = sky;
  m.receivedShadowNode = (shadow) => shadow.mul(sunVis);

  // 透射量和地面同一个公式，再乘 0.3：地面基本是水平的，很少被逆光照到；
  // 雕塑有大片竖直的背光面，同样的透射量在那儿会放大成一层青色的冰。
  // 它是一整块厚雪，透过来的光本来就该比地上那一层少得多。
  m.thicknessColorNode = iceTransmit.mul(sssAmountOf(vDepth, float(0), pk, sunVis, float(1)).mul(0.3));
  m.thicknessAmbientNode = sssWrapOf(pk, float(1));
  applySssConstants(m);

  // 雪地反光。地面朝上，看到的是整片天；雕塑的侧面有一半对着地面 ——
  // 真实场景里那一半是白雪，会把大量天光和阳光反射回来（所以雪人的肚子底下并不黑）。
  // 环境贴图的下半球比雪暗得多，这份光就没了，侧面整体暗一档、发灰，
  // 和旁边的雪地差出一道分界。按「朝下多少」补回来：
  //   地面反照率 ~0.9 × (天光 + 被照亮的雪地) × 对着地面的那部分立体角
  m.emissiveNode = Fn(() => {
    const down = float(0.5).sub(N0.y.mul(0.5));            // 0 朝天 -> 1 朝地
    const albedo = snowAlbedo(pk, crust, float(0), iceTransmit);
    const lit = U.skyHorizon.add(U.sunColor.mul(U.sunPower).mul(U.sunDir.y.max(0)).mul(0.12));
    const bounce = albedo.mul(lit).mul(down).mul(0.30).mul(sky);
    return snowSparkle(N0, p2dom, pk, crust, sunVis, sky, float(1)).add(bounce);
  })();

  return m;
}

/**
 * 半透明、边缘亮一点的「虚」材质：模具的预览虚影、手在雪雕上的笔刷球。
 * 透明度挂在一个 uniform 上（虚影用 moldActive —— 拍照时它就自己消失了）。
 */
function ghostMaterial(active) {
  const m = new THREE.MeshBasicNodeMaterial();
  m.transparent = true;
  m.depthWrite = false;
  m.name = 'mold_ghost';
  m.colorNode = vec3(0.62, 0.82, 1.0);
  m.opacityNode = Fn(() => {
    const V = cameraPosition.sub(positionWorld).normalize();
    const fres = float(1).sub(normalWorld.dot(V).abs()).pow(2.0);
    return active.mul(fres.mul(0.45).add(0.10));
  })();
  return m;
}

// ---------------------------------------------------------------- 2. 雪雕

/**
 * 模具的「脚」和地面做软并集，再把地面那张片限制在雕塑附近、底下切平。
 *   d   雕塑的距离（米）
 *   gd  到地面的有向距离（米，= y - 地面高度，地面高度已经往下压了 EPS_GROUND）
 * 离雕塑远的地方 d - 1.5k 是正的，地面那张片就没了；
 * 雕塑脚下 1.5k 以内，片和雕塑长成一圈圆角，外缘贴着雪面以下，被雪盖住。
 */
const groundBlend = (d, gd, k, cut) => Math.max(Math.max(smin(d, gd, k), d - 1.5 * k), -(gd + cut));

/**
 * @param {THREE.Scene} scene
 * @param {(x:number, z:number) => number} groundAt  真实雪面的绝对高度（interaction.js 读回的）
 */
export function createSculptures(scene, groundAt) {
  const mat = sculptMaterial();

  const ghost = new THREE.Mesh(new THREE.BufferGeometry(), ghostMaterial(U.moldActive));
  ghost.visible = false;
  ghost.renderOrder = 10;
  scene.add(ghost);

  // 手在雪雕上时的笔刷球
  const brushOn = uniform(0);
  const brushBall = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), ghostMaterial(brushOn));
  brushBall.visible = false;
  brushBall.renderOrder = 11;
  scene.add(brushBall);

  // 空闲的时候把模具场和虚影都先算好，第一次点下去不卡
  const warm = (i) => {
    if (i >= MOLDS.length) return;
    moldField(i);
    ghostGeometry(i);
    const next = () => warm(i + 1);
    if (window.requestIdleCallback) requestIdleCallback(next, { timeout: 2000 }); else setTimeout(next, 30);
  };
  setTimeout(() => warm(0), 1500);

  const list = [];
  const raycaster = new THREE.Raycaster();

  // ---- 坐标 ----
  // 局部系：原点在 (x, baseY, z)，x 沿 (ax, az)，z 沿 (-az, ax)，y 向上。
  // 和物体变换 rotation.y = atan2(-az, ax) 一致。
  const toWorldX = (sc, lx, lz) => sc.x + lx * sc.ax - lz * sc.az;
  const toWorldZ = (sc, lx, lz) => sc.z + lx * sc.az + lz * sc.ax;
  const toLocalX = (sc, wx, wz) => (wx - sc.x) * sc.ax + (wz - sc.z) * sc.az;
  const toLocalZ = (sc, wx, wz) => -(wx - sc.x) * sc.az + (wz - sc.z) * sc.ax;

  function makeSculpt(x, z, ax, az, baseY, h) {
    const group = new THREE.Group();
    group.position.set(x, baseY, z);
    group.rotation.y = Math.atan2(-az, ax);
    scene.add(group);
    return {
      x, z, ax, az, baseY, h,
      F: null, nx: 0, ny: 0, nz: 0, x0: 0, y0: 0, z0: 0, tops: null,
      group, chunks: new Map(), dirty: new Set(),
      grow: 1, anims: [], cxW: x, czW: z, r: 0,
    };
  }

  /** 世界 xz 上的包围圆：builtAt / 射线的快速剔除用 */
  function updateBounds(sc) {
    const hx = (sc.nx - 1) * sc.h / 2, hz = (sc.nz - 1) * sc.h / 2;
    const lcx = sc.x0 + hx, lcz = sc.z0 + hz;
    sc.cxW = toWorldX(sc, lcx, lcz);
    sc.czW = toWorldZ(sc, lcx, lcz);
    sc.r = Math.hypot(hx, hz);
  }

  // ---- 顶面高度：光标要能爬上去，下一个模具才摞得上去 ----
  function computeTops(sc, i0 = 0, i1 = sc.nx - 1, k0 = 0, k1 = sc.nz - 1) {
    const { F, nx, ny } = sc;
    const sz = nx * ny;
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        let top = -BIG;
        for (let j = ny - 2; j >= 0; j--) {
          const a = F[i + j * nx + k * sz];
          if (a < 0) {
            const b = F[i + (j + 1) * nx + k * sz];
            top = sc.y0 + (j + a / (a - b)) * sc.h;
            break;
          }
        }
        sc.tops[i + nx * k] = top;
      }
    }
  }

  // ---- 分块网格 ----
  const chunkKey = (ci, cj, ck) => ci + cj * 1024 + ck * 1048576;

  function markDirty(sc, i0, i1, j0, j1, k0, k1) {
    const mx = Math.ceil((sc.nx - 1) / CH) - 1;
    const my = Math.ceil((sc.ny - 1) / CH) - 1;
    const mz = Math.ceil((sc.nz - 1) / CH) - 1;
    // 改了格点 i，碰到的是体素 i-1 和 i；而块还要多算一圈低侧邻格，所以再往外扩一格
    const c = (v, m) => Math.max(0, Math.min(m, Math.floor(v / CH)));
    for (let ck = c(k0 - 1, mz); ck <= c(k1 + 1, mz); ck++) {
      for (let cj = c(j0 - 1, my); cj <= c(j1 + 1, my); cj++) {
        for (let ci = c(i0 - 1, mx); ci <= c(i1 + 1, mx); ci++) sc.dirty.add(chunkKey(ci, cj, ck));
      }
    }
  }

  const markAll = (sc) => markDirty(sc, 0, sc.nx - 1, 0, sc.ny - 1, 0, sc.nz - 1);

  /**
   * 重抽标脏的块。budget（毫秒）用完就停，剩下的留到下一帧 ——
   * 手掌默认 50cm，一下能碰到半座塔，整块重抽要十几毫秒；分摊开来，
   * 推得猛的时候网格晚一两帧跟上，帧率不会被一次大重抽拖垮。
   */
  function flush(sc, budget = Infinity) {
    const t0 = performance.now();
    for (const key of sc.dirty) {
      if (performance.now() - t0 > budget) break;
      sc.dirty.delete(key);
      const ci = key % 1024, cj = Math.floor(key / 1024) % 1024, ck = Math.floor(key / 1048576);
      const geo = meshRange(sc, ci * CH, (ci + 1) * CH, cj * CH, (cj + 1) * CH, ck * CH, (ck + 1) * CH);
      let mesh = sc.chunks.get(key);
      if (!geo) {
        if (mesh) { sc.group.remove(mesh); mesh.geometry.dispose(); sc.chunks.delete(key); }
        continue;
      }
      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = geo;
      } else {
        mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.sc = sc;
        sc.group.add(mesh);
        sc.chunks.set(key, mesh);
      }
    }
    // 新建的块在下一次渲染之前 matrixWorld 还是单位阵 —— 这一帧里的射线会打空，
    // 光标就被拽到远处的地面上去了（拖着连放时还会误放一个）。立刻刷新。
    sc.group.updateMatrixWorld(true);
  }

  function dropChunks(sc) {
    for (const mesh of sc.chunks.values()) { sc.group.remove(mesh); mesh.geometry.dispose(); }
    sc.chunks.clear();
  }

  /**
   * 保证局部盒子 [lx0,lx1]×[ly0,ly1]×[lz0,lz1] 落在体素格里；不够就扩。
   * 扩的时候对齐原来的格点，旧值原样搬过去，新出来的地方填「远在外面」。
   * 超过 MAX_DIM 就放弃（返回 false）。
   */
  function ensureBox(sc, lx0, lx1, ly0, ly1, lz0, lz1) {
    const h = sc.h;
    const ex = (lo, o) => Math.max(0, Math.ceil((o - lo) / h));
    const addX0 = ex(lx0, sc.x0), addY0 = ex(ly0, sc.y0), addZ0 = ex(lz0, sc.z0);
    const addX1 = Math.max(0, Math.ceil((lx1 - (sc.x0 + (sc.nx - 1) * h)) / h));
    const addY1 = Math.max(0, Math.ceil((ly1 - (sc.y0 + (sc.ny - 1) * h)) / h));
    const addZ1 = Math.max(0, Math.ceil((lz1 - (sc.z0 + (sc.nz - 1) * h)) / h));
    if (!(addX0 + addY0 + addZ0 + addX1 + addY1 + addZ1)) return true;

    const nx = sc.nx + addX0 + addX1, ny = sc.ny + addY0 + addY1, nz = sc.nz + addZ0 + addZ1;
    if (nx > MAX_DIM || ny > MAX_DIM || nz > MAX_DIM) return false;

    const F = new Float32Array(nx * ny * nz).fill(BIG);
    for (let k = 0; k < sc.nz; k++) {
      for (let j = 0; j < sc.ny; j++) {
        const src = (j + k * sc.ny) * sc.nx;
        const dst = addX0 + (j + addY0 + (k + addZ0) * ny) * nx;
        F.set(sc.F.subarray(src, src + sc.nx), dst);
      }
    }
    sc.F = F;
    sc.nx = nx; sc.ny = ny; sc.nz = nz;
    sc.x0 -= addX0 * h; sc.y0 -= addY0 * h; sc.z0 -= addZ0 * h;
    for (const a of sc.anims) {
      a.i0 += addX0; a.i1 += addX0; a.j0 += addY0; a.j1 += addY0; a.k0 += addZ0; a.k1 += addZ0;
    }
    sc.tops = new Float32Array(nx * nz);
    computeTops(sc);
    dropChunks(sc);
    markAll(sc);
    updateBounds(sc);
    return true;
  }

  /** 局部盒子 -> 格点下标范围（钳在格子里） */
  function range(sc, lx0, lx1, ly0, ly1, lz0, lz1) {
    const h = sc.h;
    const c = (v, n) => Math.max(0, Math.min(n - 1, v));
    return {
      i0: c(Math.floor((lx0 - sc.x0) / h), sc.nx), i1: c(Math.ceil((lx1 - sc.x0) / h), sc.nx),
      j0: c(Math.floor((ly0 - sc.y0) / h), sc.ny), j1: c(Math.ceil((ly1 - sc.y0) / h), sc.ny),
      k0: c(Math.floor((lz0 - sc.z0) / h), sc.nz), k1: c(Math.ceil((lz1 - sc.z0) / h), sc.nz),
    };
  }

  // ---- 放一个新的（独立的一座） ----
  // 体素格就是模具场本身乘尺度，格点完全对齐，不用重采样。
  function createStandalone(type, x, z, ax, az, s, baseY) {
    const fd = moldField(type);
    const h = s * VOX;
    const sc = makeSculpt(x, z, ax, az, baseY, h);
    sc.nx = fd.nx; sc.ny = fd.ny; sc.nz = fd.nz;
    sc.x0 = fd.x0 * s; sc.y0 = fd.y0 * s; sc.z0 = fd.z0 * s;
    sc.F = new Float32Array(fd.F.length);
    sc.tops = new Float32Array(sc.nx * sc.nz);

    const kf = 0.14 * s, cut = 0.12 * s;
    const { nx, ny } = sc;
    for (let k = 0; k < sc.nz; k++) {
      const lz = sc.z0 + k * h;
      for (let i = 0; i < nx; i++) {
        const lx = sc.x0 + i * h;
        const g = groundAt(toWorldX(sc, lx, lz), toWorldZ(sc, lx, lz)) - EPS_GROUND;
        for (let j = 0; j < ny; j++) {
          const n = i + nx * (j + ny * k);
          const gd = baseY + sc.y0 + j * h - g;
          sc.F[n] = groundBlend(fd.F[n] * s, gd, kf, cut);
        }
      }
    }
    computeTops(sc);
    updateBounds(sc);
    markAll(sc);
    flush(sc);
    sc.grow = 0;
    sc.group.scale.set(1, 0.001, 1);
    list.push(sc);
    if (list.length > MAX_KEEP) remove(list[0]);
    return sc;
  }

  // ---- 合并进一座已有的 ----
  // 新模具在宿主的格点上三线性重采样，再和原有的场软并集 —— 接缝处长出圆角。
  // 并集不是一帧完成的：一个从下往上升的切面把新的部分「露」出来（见 stepAnim）。
  function mergeInto(sc, type, x, z, ax, az, s, baseY, onGround) {
    const fd = moldField(type);
    // 新模具的包围盒，转到宿主的局部系
    let lx0 = Infinity, lx1 = -Infinity, lz0 = Infinity, lz1 = -Infinity;
    const u0 = fd.x0 * s, u1 = (fd.x0 + (fd.nx - 1) * VOX) * s;
    const v0 = fd.z0 * s, v1 = (fd.z0 + (fd.nz - 1) * VOX) * s;
    for (const u of [u0, u1]) {
      for (const v of [v0, v1]) {
        const wx = x + u * ax - v * az, wz = z + u * az + v * ax;
        const lx = toLocalX(sc, wx, wz), lz = toLocalZ(sc, wx, wz);
        lx0 = Math.min(lx0, lx); lx1 = Math.max(lx1, lx);
        lz0 = Math.min(lz0, lz); lz1 = Math.max(lz1, lz);
      }
    }
    const ly0 = baseY - sc.baseY + fd.y0 * s;
    const ly1 = baseY - sc.baseY + (fd.y0 + (fd.ny - 1) * VOX) * s;
    if (!ensureBox(sc, lx0, lx1, ly0, ly1, lz0, lz1)) return false;

    const R = range(sc, lx0, lx1, ly0, ly1, lz0, lz1);
    const W = R.i1 - R.i0 + 1, H = R.j1 - R.j0 + 1, D = R.k1 - R.k0 + 1;
    const dN = new Float32Array(W * H * D);
    const base = new Float32Array(W * H * D);
    const kf = 0.14 * s, cut = 0.12 * s;
    const { nx, ny, h } = sc;
    for (let k = 0; k < D; k++) {
      const lz = sc.z0 + (R.k0 + k) * h;
      for (let i = 0; i < W; i++) {
        const lx = sc.x0 + (R.i0 + i) * h;
        const wx = toWorldX(sc, lx, lz), wz = toWorldZ(sc, lx, lz);
        const dx = wx - x, dz = wz - z;
        const mu = (dx * ax + dz * az) / s;
        const mv = (-dx * az + dz * ax) / s;
        const g = onGround ? groundAt(wx, wz) - EPS_GROUND : 0;
        for (let j = 0; j < H; j++) {
          const wy = sc.baseY + sc.y0 + (R.j0 + j) * h;
          let d = sampleField(fd, mu, (wy - baseY) / s, mv) * s;
          if (onGround) d = groundBlend(d, wy - g, kf, cut);
          const r = i + W * (j + H * k);
          dN[r] = d;
          base[r] = sc.F[(R.i0 + i) + nx * ((R.j0 + j) + ny * (R.k0 + k))];
        }
      }
    }
    sc.anims.push({
      ...R, W, H, D, dN, base, t: 0,
      lvl0: baseY - sc.baseY - 0.25 * s,
      lvl1: baseY - sc.baseY + (fd.top + 0.2) * s,
      km: 0.07 * s,     // 和原有部分的捏合圆角
      kw: 0.08 * s,     // 上升切面的圆角
    });
    return true;
  }

  function stepAnim(sc, a, dt) {
    a.t = Math.min(1, a.t + dt / GROW_T);
    const done = a.t >= 1;
    const lvl = a.lvl0 + (a.lvl1 - a.lvl0) * easeOut(a.t);
    const { F, nx, ny, h } = sc;
    for (let k = 0; k < a.D; k++) {
      for (let j = 0; j < a.H; j++) {
        const ly = sc.y0 + (a.j0 + j) * h;
        let r = a.W * (j + a.H * k);
        let o = a.i0 + nx * ((a.j0 + j) + ny * (a.k0 + k));
        for (let i = 0; i < a.W; i++, r++, o++) {
          const dk = done ? a.dN[r] : smax(a.dN[r], ly - lvl, a.kw);
          F[o] = smin(a.base[r], dk, a.km);
        }
      }
    }
    computeTops(sc, a.i0, a.i1, a.k0, a.k1);
    markDirty(sc, a.i0, a.i1, a.j0, a.j1, a.k0, a.k1);
    return done;
  }

  // ---- 手 ----

  /**
   * 手在雪雕上：直接改距离场。
   *   PUSH   往里削（场值变大）
   *   PILE   往外鼓（场值变小）
   *   SMOOTH 向 6 邻域的平均拉 —— 对距离场这就是拉普拉斯平滑：
   *          平面上不动，凸棱被磨圆，凹角被填上
   *
   * 大小、衰减、力度都和地面上那只手（snowfield.js 的 computeDeform）对齐：
   *   衰减   1 - smoothstep(内圈, R, d)，推 / 抚平的内圈是 0.22R，堆是 0.05R —— 和地面同一条曲线
   *   力度   跟着面板上的「按压力度」走（U.handPress），推 / 堆每秒挪动表面约 6×handPress 米
   */
  function brush(sc, p, R, mode, dt) {
    if (sc.grow < 1) return;
    const lx = toLocalX(sc, p.x, p.z), lz = toLocalZ(sc, p.x, p.z), ly = p.y - sc.baseY;
    const m = R + sc.h * 2;
    if (mode === 'pile') ensureBox(sc, lx - m, lx + m, ly - m, ly + m, lz - m, lz + m);
    const G = range(sc, lx - R, lx + R, ly - R, ly + R, lz - R, lz + R);
    const { nx, ny, h } = sc;
    const sz = nx * ny;
    const F = sc.F;

    let snap = null;
    if (mode === 'smooth') {
      // 先拍一份快照（外扩一格），平均值都从快照里取，结果才不偏向扫描方向
      snap = new Float32Array((G.i1 - G.i0 + 3) * (G.j1 - G.j0 + 3) * (G.k1 - G.k0 + 3));
      let n = 0;
      for (let k = G.k0 - 1; k <= G.k1 + 1; k++) {
        for (let j = G.j0 - 1; j <= G.j1 + 1; j++) {
          for (let i = G.i0 - 1; i <= G.i1 + 1; i++) {
            const ci = Math.max(0, Math.min(nx - 1, i));
            const cj = Math.max(0, Math.min(ny - 1, j));
            const ck = Math.max(0, Math.min(sc.nz - 1, k));
            snap[n++] = F[ci + cj * nx + ck * sz];
          }
        }
      }
    }
    const SW = G.i1 - G.i0 + 3, SH = G.j1 - G.j0 + 3;
    const S = (i, j, k) => snap[(i - G.i0 + 1) + SW * ((j - G.j0 + 1) + SH * (k - G.k0 + 1))];
    const kS = Math.min(1, dt * 14);
    const rate = U.handPress.value * 6.0;
    const r0 = (mode === 'pile' ? 0.05 : 0.22) * R;

    for (let k = G.k0; k <= G.k1; k++) {
      const dz = sc.z0 + k * h - lz;
      for (let j = G.j0; j <= G.j1; j++) {
        const dy = sc.y0 + j * h - ly;
        for (let i = G.i0; i <= G.i1; i++) {
          const dx = sc.x0 + i * h - lx;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d >= R) continue;
          const tt = Math.max(0, (d - r0) / (R - r0));
          const w = 1 - tt * tt * (3 - 2 * tt);       // 1 - smoothstep(r0, R, d)
          const o = i + j * nx + k * sz;
          if (mode === 'push') F[o] += rate * dt * w;
          else if (mode === 'pile') F[o] -= rate * dt * w;
          else {
            const avg = (S(i - 1, j, k) + S(i + 1, j, k) + S(i, j - 1, k)
              + S(i, j + 1, k) + S(i, j, k - 1) + S(i, j, k + 1)) / 6;
            F[o] += (avg - F[o]) * kS * w;
          }
        }
      }
    }
    computeTops(sc, G.i0, G.i1, G.k0, G.k1);
    markDirty(sc, G.i0, G.i1, G.j0, G.j1, G.k0, G.k1);
    // 网格不在这里重抽：update 里按每帧的时间预算抽
  }

  // ---- 查询 ----

  const _info = { y: -Infinity, sc: null };

  /** 雪雕在这一点的顶面绝对高度，以及是哪一座 */
  function builtInfo(x, z) {
    _info.y = -Infinity; _info.sc = null;
    for (let n = 0; n < list.length; n++) {
      const sc = list[n];
      const ddx = x - sc.cxW, ddz = z - sc.czW;
      if (ddx * ddx + ddz * ddz > sc.r * sc.r) continue;
      const i = Math.round((toLocalX(sc, x, z) - sc.x0) / sc.h);
      const k = Math.round((toLocalZ(sc, x, z) - sc.z0) / sc.h);
      if (i < 0 || k < 0 || i >= sc.nx || k >= sc.nz) continue;
      const top = sc.tops[i + sc.nx * k];
      if (top <= -BIG) continue;
      const y = sc.baseY + top * (sc.grow < 1 ? easeOut(sc.grow) : 1);
      if (y > _info.y) { _info.y = y; _info.sc = sc; }
    }
    return _info;
  }

  const builtAt = (x, z) => builtInfo(x, z).y;

  /** 以 p 为球心、半径 R 的手碰得到哪几座（球和体素格的包围盒相交） */
  function touching(p, R) {
    const out = [];
    for (const sc of list) {
      if (sc.grow < 1) continue;
      const ddx = p.x - sc.cxW, ddz = p.z - sc.czW;
      if (Math.hypot(ddx, ddz) > sc.r + R) continue;
      const lx = toLocalX(sc, p.x, p.z), lz = toLocalZ(sc, p.x, p.z), ly = p.y - sc.baseY;
      const cx = Math.max(sc.x0, Math.min(sc.x0 + (sc.nx - 1) * sc.h, lx));
      const cy = Math.max(sc.y0, Math.min(sc.y0 + (sc.ny - 1) * sc.h, ly));
      const cz = Math.max(sc.z0, Math.min(sc.z0 + (sc.nz - 1) * sc.h, lz));
      if (Math.hypot(lx - cx, ly - cy, lz - cz) < R) out.push(sc);
    }
    return out;
  }

  /**
   * 新模具挨着哪一座、能不能合并进去。
   * 看的是新模具底座的四角、四边中点和中心（fx, fz 是底座半长宽，米）有没有落进
   * 某一座的体素格 —— 只看中心的话，首尾相接的城墙中心隔着整整一段墙长，永远判不上。
   */
  function neighbor(x, z, ax, az, fx, fz, s) {
    for (const sc of list) {
      if (sc.grow < 1) continue;
      const ratio = s / (sc.h / VOX);
      if (ratio < 0.6 || ratio > 1.7) continue;
      const x1 = sc.x0 + (sc.nx - 1) * sc.h, z1 = sc.z0 + (sc.nz - 1) * sc.h;
      for (const u of [-1, 0, 1]) {
        for (const v of [-1, 0, 1]) {
          const wx = x + u * fx * ax - v * fz * az, wz = z + u * fx * az + v * fz * ax;
          const lx = toLocalX(sc, wx, wz), lz = toLocalZ(sc, wx, wz);
          if (lx > sc.x0 && lx < x1 && lz > sc.z0 && lz < z1) return sc;
        }
      }
    }
    return null;
  }

  /**
   * 放一个模具。
   *   摞在某一座上面  -> 合并进那一座（捏合圆角，不碰地面）
   *   挨着某一座      -> 合并进那一座（捏合圆角 + 脚下和地面的圆角）
   *   都不是          -> 新起一座
   * 合并不了（尺度差太多、格子会太大）就退回新起一座。
   */
  function place(type, x, z, ax, az, s, baseY, stackedOn) {
    const M = MOLDS[type] || MOLDS[0];
    if (stackedOn) {
      const ratio = s / (stackedOn.h / VOX);
      if (stackedOn.grow >= 1 && ratio > 0.35 && ratio < 2.5
        && mergeInto(stackedOn, type, x, z, ax, az, s, baseY, false)) return stackedOn;
    } else {
      const nb = neighbor(x, z, ax, az, M.foot[0] * s, M.foot[1] * s, s);
      if (nb && mergeInto(nb, type, x, z, ax, az, s, baseY, true)) return nb;
    }
    return createStandalone(type, x, z, ax, az, s, baseY);
  }

  /** 射线打雪雕：打中了返回 { point, distance, sc } */
  function raycast(ray, far) {
    if (!list.length) return null;
    raycaster.ray.copy(ray);
    raycaster.far = far;
    const hits = raycaster.intersectObjects(list.map((sc) => sc.group), true);
    if (!hits.length) return null;
    return { point: hits[0].point, distance: hits[0].distance, sc: hits[0].object.userData.sc };
  }

  const FLUSH_BUDGET = 5;    // 每帧最多花这么多毫秒重抽网格（所有雪雕合计）

  function update(dt) {
    let left = FLUSH_BUDGET;
    for (const sc of list) {
      if (sc.grow < 1) {
        sc.grow = Math.min(1, sc.grow + dt / GROW_T);
        const k = easeOut(sc.grow);
        // 长出来的时候先略宽一点再收回去，像刚脱模时往下一坐
        const w = 1 + 0.06 * (1 - k);
        sc.group.scale.set(w, Math.max(k, 0.001), w);
        sc.group.updateMatrixWorld(true);
      }
      if (sc.anims.length) sc.anims = sc.anims.filter((a) => !stepAnim(sc, a, dt));
      if (sc.dirty.size && left > 0) {
        const t = performance.now();
        flush(sc, left);
        left -= performance.now() - t;
      }
    }
  }

  /** 虚影：跟着光标，显示即将扣下去的样子 */
  function setGhost(on, type, x, y, z, ax, az, s) {
    ghost.visible = on;
    if (!on) return;
    ghost.geometry = ghostGeometry(type);
    ghost.position.set(x, y, z);
    ghost.rotation.y = Math.atan2(-az, ax);
    ghost.scale.setScalar(s);
  }

  function setBrush(on, p, R) {
    brushBall.visible = on;
    brushOn.value = on ? 1 : 0;
    if (!on) return;
    brushBall.position.copy(p);
    brushBall.scale.setScalar(R);
  }

  function remove(sc) {
    const i = list.indexOf(sc);
    if (i >= 0) list.splice(i, 1);
    dropChunks(sc);
    scene.remove(sc.group);
  }

  function clear() {
    for (const sc of list.slice()) remove(sc);
  }

  function prune(cx, cz) {
    for (const sc of list.slice()) {
      if (Math.abs(sc.cxW - cx) > KEEP_DIST || Math.abs(sc.czW - cz) > KEEP_DIST) remove(sc);
    }
  }

  return {
    place, brush, raycast, builtAt, builtInfo, touching, update,
    setGhost, setBrush, clear, prune, list, brushBall,
  };
}
