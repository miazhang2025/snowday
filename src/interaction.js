/**
 * interaction.js — 把鼠标当成一只手，或者一只模具
 *
 * 鼠标射线打在「当前雪面」上得到手掌位置。每帧把上一帧和这一帧的位置
 * 作为一段线段送进 computeDeform，所以快速拖动也不会漏掉中间的雪。
 *
 *   左键按住拖动 —— 手掌贴着雪面推，雪从掌下被刮走、堆到手的前方，速度够快还会扬起粉雪
 *   左键轻点     —— 按一个手印（掌心 + 五指）
 *   1 / 2 / 3    —— 切换 推雪 / 抚平 / 堆雪
 *   4            —— 换成模具：左键按下扣一坨形状的雪，按住拖着走能连着扣一排
 *   右键拖动     —— 转视角，中键拖动 —— 平移，滚轮 —— 缩放
 */

import * as THREE from 'three/webgpu';
import { U, params, HAND, SPRAY, SPRAY_BATCH, HALF, CELL0 } from './config.js';
import { computeDeform, computeMold } from './snowfield.js';
import { computeSprayEmit } from './snowfall.js';
import { terrainY } from './terrain.js';
import { MOLDS, moldHeight } from './molds.js';

const CLICK_MS = 200;      // 短于这个时间且几乎没动 → 判定为「轻点」
const CLICK_DIST = 0.09;   // 世界单位

const smoothstep01 = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- 已经堆好的东西（CPU 镜像）
//
// 模具是直接写进 GPU 高度场的，读回来太贵（一次 448² 的回读要等一整帧）。
// 但光标必须能爬到堆好的东西上面去 —— 不然没法往塔顶上再摞一层，
// 城堡就只能永远摊在地上，「造城堡」这件事也就不成立。
//
// 所以 CPU 这边留一份很轻的镜像：只记「哪个模具、放在哪、多大、朝哪、底面多高」，
// 高度用 molds.js 里那份 JS 剖面现算。射线拾取的地面函数取它和雪面的较大者。
//
// 它只服务于拾取，所以不必和 GPU 逐位一致：拿手把塔推塌了这边并不知道，
// 光标会在那儿浮一点点。比起「城堡摞不起来」，这个偏差可以接受。

const MAX_BUILDS = 512;
const BUILD_KEEP = 130;          // 超出这个距离就丢掉（GPU 的形变留存也只有 ±128m）

const builds = [];
let bMinX = 1e9, bMaxX = -1e9, bMinZ = 1e9, bMaxZ = -1e9;

function rebound() {
  bMinX = 1e9; bMaxX = -1e9; bMinZ = 1e9; bMaxZ = -1e9;
  for (const b of builds) {
    if (b.x - b.r < bMinX) bMinX = b.x - b.r;
    if (b.x + b.r > bMaxX) bMaxX = b.x + b.r;
    if (b.z - b.r < bMinZ) bMinZ = b.z - b.r;
    if (b.z + b.r > bMaxZ) bMaxZ = b.z + b.r;
  }
}

/** 堆好的结构在这一点的绝对高度；没有就返回 -Infinity */
function builtAt(x, z) {
  if (x < bMinX || x > bMaxX || z < bMinZ || z > bMaxZ) return -Infinity;
  let best = -Infinity;
  for (let i = 0; i < builds.length; i++) {
    const b = builds[i];
    const dx = x - b.x;
    const dz = z - b.z;
    if (dx * dx + dz * dz > b.r * b.r) continue;
    // 世界 -> 模具局部：u 沿 axis，v 是它右手边的法向（和 molds.js 的 moldLocal 一致）
    const h = moldHeight(b.type, (dx * b.ax + dz * b.az) / b.s, (dx * b.az - dz * b.ax) / b.s);
    if (h > 0) {
      const y = b.baseY + h * b.s;
      if (y > best) best = y;
    }
  }
  return best;
}

/** 观察点走远之后，把留存范围之外的记录丢掉 —— GPU 那边它们也已经没了 */
function pruneBuilds(cx, cz) {
  let n = 0;
  for (const b of builds) {
    if (Math.abs(b.x - cx) < BUILD_KEEP && Math.abs(b.z - cz) < BUILD_KEEP) builds[n++] = b;
  }
  if (n !== builds.length) { builds.length = n; rebound(); }
}

export function createInteraction(renderer, camera, controls, dom) {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2(0, 0);
  const hit = new THREE.Vector3();
  const prevPos = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const center = new THREE.Vector2();   // 当前 L0 窗口中心（由 main.js 每帧写入）

  const S = {
    over: false,
    down: false,
    engaged: false,
    downAt: 0,
    moved: 0,
    inField: false,
    hasHit: false,
    stamp: false,
    speed: 0,
    estY: 0,            // 估算的平均雪面高度（用来放置射线平面）
    emitCursor: 0,
    cur: new THREE.Vector3(0, 0, 0),
    axis: new THREE.Vector2(0, 1),
    // 模具
    placeReq: false,    // 这一帧要不要扣一下
    hasPlaced: false,
    lastPX: 0,
    lastPZ: 0,
  };

  /**
   * 这一点的「地面」有多高。
   *
   * 除了地形 + 平均雪深，还要算上已经堆好的结构 —— 光标于是会爬上雪球的顶、
   * 塔楼的平台，新的模具就直接摞在上面。城堡是这样一层层叠起来的。
   */
  const surfaceAt = (x, z) => Math.max(terrainY(x, z) + S.estY, builtAt(x, z));

  /**
   * 沿射线找和地面的交点。
   *
   * 地面不是一个水平面（有地形，现在还有堆出来的东西），所以不能用
   * Plane.intersect。做法是最直接的：步进到第一次穿过地面，再二分几次收敛。
   * 步长按距离递增 —— 近处要准（手就在那儿），远处只要能落在正确的格子里就行。
   *
   * 这里用的 terrainY 和 GPU 端的 terrainSample 读的是同一张高度图、
   * 同一套插值权重，所以「看到的」和「摸到的」是同一个面。
   */
  const MARCH_MAX = 220;

  function raycastGround(origin, dir, out) {
    let t = 0.05;
    if (origin.y - surfaceAt(origin.x, origin.z) <= 0) return false;   // 相机已经在地面以下

    let step = 0.25;
    while (t < MARCH_MAX) {
      const nt = t + step;
      const x = origin.x + dir.x * nt;
      const z = origin.z + dir.z * nt;
      if (origin.y + dir.y * nt - surfaceAt(x, z) <= 0) {
        // 二分收敛：8 次就够到毫米级
        let lo = t, hi = nt;
        for (let i = 0; i < 8; i++) {
          const m = (lo + hi) * 0.5;
          const mx = origin.x + dir.x * m;
          const mz = origin.z + dir.z * m;
          if (origin.y + dir.y * m - surfaceAt(mx, mz) > 0) lo = m; else hi = m;
        }
        const m = (lo + hi) * 0.5;
        out.set(origin.x + dir.x * m, origin.y + dir.y * m, origin.z + dir.z * m);
        return true;
      }
      t = nt;
      step = Math.min(step * 1.22, 6.0);
    }
    return false;
  }

  // ------------------------------------------------------------ 指针事件

  const toNDC = (e) => {
    const r = dom.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };

  dom.addEventListener('pointermove', (e) => { toNDC(e); S.over = true; });
  dom.addEventListener('pointerenter', () => { S.over = true; });
  dom.addEventListener('pointerleave', () => { S.over = false; S.down = false; S.engaged = false; });

  dom.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;               // 右键/中键留给相机
    toNDC(e);
    S.over = true;
    S.down = true;
    S.engaged = false;
    S.downAt = performance.now();
    S.moved = 0;
    // 模具是「按下就扣」，不等抬手 —— 手感上它更像盖章而不像画画
    if (params.mode === HAND.MOLD) { S.placeReq = true; S.hasPlaced = false; }
    dom.setPointerCapture?.(e.pointerId);
  });

  const release = (e) => {
    if (!S.down) return;
    S.down = false;
    const quick = performance.now() - S.downAt < CLICK_MS && S.moved < CLICK_DIST;
    // 轻点还没来得及「压下去」时，盖一个手印
    if (quick && !S.engaged && S.inField && params.mode !== HAND.MOLD) {
      // 手指朝远离镜头的方向
      camera.getWorldDirection(fwd);
      const l = Math.hypot(fwd.x, fwd.z) || 1;
      S.axis.set(fwd.x / l, fwd.z / l);
      S.stamp = true;
    }
    S.engaged = false;
    if (e) dom.releasePointerCapture?.(e.pointerId);
  };
  dom.addEventListener('pointerup', release);
  dom.addEventListener('pointercancel', release);
  window.addEventListener('blur', () => release(null));

  // ------------------------------------------------------------ 模具

  /** 模具的朝向：默认背对镜头（正面冲着你），再叠上用户转的那个角 */
  function updateMoldAxis() {
    camera.getWorldDirection(fwd);
    const l = Math.hypot(fwd.x, fwd.z) || 1;
    const ax = fwd.x / l;
    const az = fwd.z / l;
    const r = THREE.MathUtils.degToRad(params.moldRot);
    const cs = Math.cos(r);
    const sn = Math.sin(r);
    U.moldAxis.value.set(ax * cs - az * sn, ax * sn + az * cs);
  }

  // 正在「长」出来的模具。盖章不是一帧完成的：每个模具在 GROW_T 秒里
  // 从底面升到全高，期间每帧重跑一遍 computeMold（它的合并是幂等的 max，
  // 反复盖不会越盖越高）。拖着连放的时候会有好几个同时在长。
  const GROW_T = 0.32;
  const growing = [];

  function stampMold(g, k) {
    U.moldPos.value.set(g.x, g.baseY, g.z);
    U.moldAxis.value.set(g.ax, g.az);
    U.moldBase.value = g.baseY;
    U.moldScale.value = g.s;
    U.moldType.value = g.type;
    U.moldBlur.value = g.blur;
    U.moldReach.value = g.r + g.blur + g.s * 0.35;
    U.moldGrow.value = k;
    renderer.compute(computeMold);
  }

  function stepGrowing(dt) {
    if (!growing.length) return;
    let n = 0;
    for (const g of growing) {
      g.t = Math.min(1, g.t + dt / GROW_T);
      // easeOutCubic：先快后慢，最后轻轻「落定」
      const k = 1 - Math.pow(1 - g.t, 3);
      stampMold(g, k);
      if (g.t < 1) growing[n++] = g;
    }
    growing.length = n;
    // 预览描边读的也是这几个 uniform，盖完章把它们交还给光标
    U.moldGrow.value = 1;
    U.moldScale.value = Math.max(0.05, params.moldSize);
    U.moldType.value = params.mold;
  }

  function placeMold() {
    const M = MOLDS[params.mold] || MOLDS[0];
    const s = Math.max(0.05, params.moldSize);
    // 底面比雪面低一点点，模具的脚是「陷进雪里」而不是「摆在雪上」的
    const base = surfaceAt(S.cur.x, S.cur.z) - s * 0.05;

    const b = {
      x: S.cur.x, z: S.cur.z,
      ax: U.moldAxis.value.x, az: U.moldAxis.value.y,
      s, baseY: base, type: params.mold, r: M.foot * s + 0.05,
    };

    // 滤波半径：至少一格多一点（去锯齿），模具越高越宽（墙带一点收分）
    growing.push({ ...b, t: 0, blur: CELL0 * 1.1 + M.top * s * 0.05 });

    // CPU 镜像直接按最终形状记 —— 光标马上就能爬上去接着摞
    if (builds.length >= MAX_BUILDS) builds.shift();
    builds.push(b);
    rebound();

    S.lastPX = S.cur.x;
    S.lastPZ = S.cur.z;
    S.hasPlaced = true;
  }

  // ------------------------------------------------------------ 每帧

  function update(dt) {
    stepGrowing(dt);

    // 平均雪面高度：跟 computeAccumulate 用同一条收敛规则
    const target = Math.max(params.depth, 1e-4);
    const gate = 1 - smoothstep01(target * 0.45, target, S.estY);
    S.estY = Math.min(S.estY + U.depositRate.value * dt * gate, target * 1.08);

    prevPos.copy(S.cur);

    ray.setFromCamera(ndc, camera);
    S.hasHit = raycastGround(ray.ray.origin, ray.ray.direction, hit);

    if (S.hasHit) {
      // 可交互的只有 L0 那 26m 的窗口，而窗口是跟着相机走的
      const lim = HALF * 0.96;
      S.inField = Math.abs(hit.x - center.x) < lim && Math.abs(hit.z - center.y) < lim;
      hit.x = THREE.MathUtils.clamp(hit.x, center.x - lim, center.x + lim);
      hit.z = THREE.MathUtils.clamp(hit.z, center.y - lim, center.y + lim);
      hit.y = surfaceAt(hit.x, hit.z);
      // 轻微跟随延迟，手看起来有一点重量
      S.cur.lerp(hit, S.down ? 0.75 : 0.45);
    } else {
      S.inField = false;
    }

    const dx = S.cur.x - prevPos.x;
    const dz = S.cur.z - prevPos.z;
    const stepLen = Math.hypot(dx, dz);
    S.speed = stepLen / Math.max(dt, 1e-4);
    if (stepLen > 1e-3) S.axis.set(dx / stepLen, dz / stepLen);

    const live = S.over && S.inField && !controls.__dragging;
    const molding = params.mode === HAND.MOLD;

    U.handPrev.value.copy(prevPos);
    U.handCur.value.copy(S.cur);
    U.handAxis.value.copy(S.axis);
    U.handActive.value = live ? 1 : 0;

    // ---- 模具 ----
    if (molding) {
      updateMoldAxis();
      U.moldPos.value.copy(S.cur);
      U.moldScale.value = Math.max(0.05, params.moldSize);
      U.moldType.value = params.mold;
      U.moldActive.value = live ? 1 : 0;

      // 按住不放拖着走 = 连着扣一排。间距取模具自己的包围半径，
      // 相邻两个刚好挨上；软并集会把它们焊成连续的一道墙。
      const M = MOLDS[params.mold] || MOLDS[0];
      const spacing = M.foot * Math.max(0.05, params.moldSize) * 1.05;
      const far = S.hasPlaced
        && Math.hypot(S.cur.x - S.lastPX, S.cur.z - S.lastPZ) > spacing;
      if ((S.placeReq || (S.down && far)) && S.inField && S.hasHit) placeMold();
      S.placeReq = false;
      return;                       // 拿着模具的时候手不在场上，下面那些都不跑
    }

    U.moldActive.value = 0;
    S.placeReq = false;

    // 按下之后：移动一小段 或 按住一小会儿，手才真正「压进」雪里
    if (S.down) {
      S.moved += stepLen;
      if (!S.engaged && (S.moved > CLICK_DIST || performance.now() - S.downAt > CLICK_MS)) {
        S.engaged = true;
      }
    }

    if (S.engaged && S.inField) {
      U.handMode.value = params.mode;
      U.handStrength.value = Math.min(0.32, dt * 8.0);
      renderer.compute(computeDeform);

      // 推得够快 → 掌缘扬起粉雪
      if (params.mode === HAND.PUSH && params.spray > 0.01 && S.speed > 0.85) {
        U.emitPower.value = Math.min(3.4, (S.speed - 0.7) * 0.55) * params.spray;
        U.emitDir.value.set(S.axis.x, 0, S.axis.y);
        U.emitOffset.value = S.emitCursor;
        renderer.compute(computeSprayEmit);
        S.emitCursor = (S.emitCursor + SPRAY_BATCH) % SPRAY;
      }
    }

    if (S.stamp) {
      S.stamp = false;
      U.handMode.value = HAND.PRINT;
      U.handStrength.value = 1.0;
      U.handAxis.value.copy(S.axis);
      U.handPrev.value.copy(S.cur);     // 手印是单点，不是线段
      renderer.compute(computeDeform);
    }
  }

  /** 清空/铺满之后重置雪面高度估计。堆好的东西也一起没了。 */
  function setSurface(y) {
    S.estY = y;
    builds.length = 0;
    growing.length = 0;
    rebound();
  }

  /** clipmap 窗口中心，每帧由 main.js 告知 */
  function setCenter(x, z) {
    center.set(x, z);
    pruneBuilds(x, z);
  }

  return { update, setSurface, setCenter, state: S, builds };
}
