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
import { U, params, HAND, SPRAY, SPRAY_BATCH, HALF } from './config.js';
import { computeDeform, computeMold, readSurface } from './snowfield.js';
import { computeSprayEmit } from './snowfall.js';
import { terrainY } from './terrain.js';
import { MOLDS, FOOT_REACH } from './molds.js';
import { createSculptures } from './sculpt.js';

const CLICK_MS = 200;      // 短于这个时间且几乎没动 → 判定为「轻点」
const CLICK_DIST = 0.09;   // 世界单位

const smoothstep01 = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

export function createInteraction(renderer, scene, camera, controls, dom) {
  // 模具扣出来的雪雕（网格）。它们在 CPU 这边有一份顶面高度图，
  // 光标能爬到雕塑顶上去 —— 下一个模具就摞在上面，城堡是这样一层层叠起来的。
  const sculpts = createSculptures(scene, (x, z) => groundAt(x, z));
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
    placedCount: 0,     // 一共扣下过几个（新手指引要知道）
    lastPX: 0,
    lastPZ: 0,
  };

  /**
   * 这一点的「地面」有多高。
   *
   * 除了地形 + 平均雪深，还要算上已经堆好的结构 —— 光标于是会爬上雪球的顶、
   * 塔楼的平台，新的模具就直接摞在上面。城堡是这样一层层叠起来的。
   */
  // 真实雪面：L0 的表面高度每隔几帧异步读回一次（见 snowfield.js 的 readSurface）。
  // 读回还没到、或者点在 L0 窗口外面，就退回「地形 + 平均雪深」的估计。
  let field = null;
  let fieldPending = false;
  let fieldTick = 0;

  function pollField() {
    if (fieldPending || ++fieldTick < 4) return;
    fieldTick = 0;
    fieldPending = true;
    readSurface(renderer)
      .then((f) => { field = f; })
      .catch(() => {})
      .finally(() => { fieldPending = false; });
  }

  function fieldAt(x, z) {
    const f = field;
    if (!f) return null;
    const fx = x / f.cell - f.ox;
    const fz = z / f.cell - f.oz;
    const i = Math.floor(fx);
    const k = Math.floor(fz);
    if (i < 1 || k < 1 || i >= f.n - 2 || k >= f.n - 2) return null;
    const n = f.n;
    const at = (gx, gz) => f.data[(((f.oz + gz) % n + n) % n) * n + (((f.ox + gx) % n + n) % n)];
    const tx = fx - i, tz = fz - k;
    const a = at(i, k) + (at(i + 1, k) - at(i, k)) * tx;
    const b = at(i, k + 1) + (at(i + 1, k + 1) - at(i, k + 1)) * tx;
    return a + (b - a) * tz;
  }

  const groundAt = (x, z) => fieldAt(x, z) ?? terrainY(x, z) + S.estY;
  const surfaceAt = (x, z) => Math.max(groundAt(x, z), sculpts.builtAt(x, z));

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

  // 高度场上的盖章：雕塑脚下那圈压实的雪。
  // 不是一帧盖完的 —— 在 STAMP_T 秒里把 moldGrow 从 0 推到 1，每帧重跑一遍
  // computeMold（它的合并是幂等的 max，反复盖不会越盖越高）。
  const STAMP_T = 0.32;
  const stamps = [];

  function runStamp(g, k) {
    U.moldPos.value.set(g.x, g.baseY, g.z);
    U.moldAxis.value.set(g.ax, g.az);
    U.moldBase.value = g.baseY;
    U.moldScale.value = g.s;
    U.moldType.value = g.type;
    U.moldPadH.value = g.padH;
    U.moldPadW.value = g.padW;
    // 贴地截面的图集覆盖 ±FOOT_REACH，影响半径至少要到那儿
    U.moldReach.value = (FOOT_REACH + g.padW + 0.1) * g.s;
    U.moldGrow.value = k;
    renderer.compute(computeMold);
  }

  function stepStamps(dt) {
    if (!stamps.length) return;
    let n = 0;
    for (const g of stamps) {
      g.t = Math.min(1, g.t + dt / g.dur);
      runStamp(g, 1 - Math.pow(1 - g.t, 3));      // easeOutCubic
      if (g.t < 1) stamps[n++] = g;
    }
    stamps.length = n;
  }

  /** 把「当前光标处的模具」写进预览用的 uniform（盖章会借用它们，每帧还回来） */
  function setPreviewUniforms(s) {
    U.moldPos.value.copy(S.cur);
    U.moldScale.value = s;
    U.moldType.value = params.mold;
  }

  function placeMold() {
    const M = MOLDS[params.mold] || MOLDS[0];
    const s = Math.max(0.05, params.moldSize);
    const x = S.cur.x, z = S.cur.z;
    const ax = U.moldAxis.value.x, az = U.moldAxis.value.y;
    // 底面取底座范围里最低的那一点：落在雪堆的坡上时，低的那一侧也不会悬空
    // （高的那一侧只是多埋进雪里一点）
    let ground = groundAt(x, z);
    const px = -az, pz = ax;
    for (const [u, v] of [[0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8],
      [0.55, 0.55], [0.55, -0.55], [-0.55, 0.55], [-0.55, -0.55]]) {
      const lu = u * M.foot[0] * s, lv = v * M.foot[1] * s;
      ground = Math.min(ground, groundAt(x + ax * lu + px * lv, z + az * lu + pz * lv));
    }
    const info = sculpts.builtInfo(x, z);
    const stackedOn = info.y > groundAt(x, z) + 0.02 ? info.sc : null;
    const top = info.y;
    // 底面比雪面低一点：脚是「陷进雪里」而不是「摆在雪上」的
    const base = (stackedOn ? top : ground) - s * 0.04;

    // 摞在上面 / 挨着放 会合并进已有的那一座（见 sculpt.js 的 place）
    sculpts.place(params.mold, x, z, ax, az, s, base, stackedOn);

    // 雕塑脚下和地面的圆角已经长在网格里了；这里再在高度场上压一圈薄薄的实雪，
    // 把两者的交线埋住。摞在别的雕塑上面时，底下的高度场够不着，不盖。
    if (!stackedOn) {
      stamps.push({
        x, z, ax, az, s, baseY: base, type: params.mold,
        padH: 0.08, padW: 0.30, t: 0, dur: STAMP_T,
      });
    }

    S.lastPX = x;
    S.lastPZ = z;
    S.hasPlaced = true;
    S.placedCount++;
  }

  // ------------------------------------------------------------ 每帧

  function update(dt) {
    pollField();
    stepStamps(dt);
    sculpts.update(dt);

    // 平均雪面高度：跟 computeAccumulate 用同一条收敛规则
    const target = Math.max(params.depth, 1e-4);
    const gate = 1 - smoothstep01(target * 0.45, target, S.estY);
    S.estY = Math.min(S.estY + U.depositRate.value * dt * gate, target * 1.08);

    prevPos.copy(S.cur);

    ray.setFromCamera(ndc, camera);
    S.hasHit = raycastGround(ray.ray.origin, ray.ray.direction, hit);
    // 雪雕直接拿网格求交。地面步进的步长在几米外会涨到大半米，
    // 射线擦过塔顶的那一小段会被一步跨过去 —— 往上摞就点不中了。
    const sculptHit = sculpts.raycast(ray.ray, S.hasHit ? ray.ray.origin.distanceTo(hit) + 0.3 : 400);
    if (sculptHit) { hit.copy(sculptHit.point); S.hasHit = true; }

    if (S.hasHit) {
      // 可交互的只有 L0 那 26m 的窗口，而窗口是跟着相机走的
      const lim = HALF * 0.96;
      S.inField = Math.abs(hit.x - center.x) < lim && Math.abs(hit.z - center.y) < lim;
      hit.x = THREE.MathUtils.clamp(hit.x, center.x - lim, center.x + lim);
      hit.z = THREE.MathUtils.clamp(hit.z, center.y - lim, center.y + lim);
      // 拿着模具：落点取这一列的顶面（这样才摞得上去）。
      // 用手：打中雕塑侧面就是侧面上那一点 —— 手是一个球，要贴着它真正碰到的地方。
      hit.y = sculptHit && params.mode !== HAND.MOLD ? sculptHit.point.y : surfaceAt(hit.x, hit.z);
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
      sculpts.setBrush(false);
      updateMoldAxis();
      const M = MOLDS[params.mold] || MOLDS[0];
      const s = Math.max(0.05, params.moldSize);
      setPreviewUniforms(s);
      U.moldActive.value = live ? 1 : 0;
      sculpts.setGhost(live, params.mold, S.cur.x, S.cur.y - s * 0.05, S.cur.z,
        U.moldAxis.value.x, U.moldAxis.value.y, s);

      // 按住不放拖着走 = 连着扣一排。间距取底座沿拖动方向的投影长度，
      // 相邻两个刚好挨上：城墙首尾相接，雪人一个挨一个。
      let far = false;
      if (S.hasPlaced) {
        const ddx = S.cur.x - S.lastPX, ddz = S.cur.z - S.lastPZ;
        const d = Math.hypot(ddx, ddz);
        if (d > 1e-4) {
          const ax = U.moldAxis.value.x, az = U.moldAxis.value.y;
          const along = Math.abs((ddx * ax + ddz * az) / d);
          const side = Math.abs((ddz * ax - ddx * az) / d);
          far = d > (along * M.foot[0] + side * M.foot[1]) * 2 * s;
        }
      }
      if ((S.placeReq || (S.down && far)) && S.inField && S.hasHit) placeMold();
      S.placeReq = false;
      return;                       // 拿着模具的时候手不在场上，下面那些都不跑
    }

    sculpts.setGhost(false);
    U.moldActive.value = 0;
    S.placeReq = false;

    // 按下之后：移动一小段 或 按住一小会儿，手才真正「压进」雪里
    if (S.down) {
      S.moved += stepLen;
      if (!S.engaged && (S.moved > CLICK_DIST || performance.now() - S.downAt > CLICK_MS)) {
        S.engaged = true;
      }
    }

    // ---- 手：一个球 ----
    // 地面和雪雕用的是**同一只手**：同一个位置（平滑过的 3D 光标）、同一个半径
    // （面板上的「手掌大小」）、同一条衰减曲线。每帧球碰到哪就改哪 ——
    // 在雕塑脚下推，地面和雕塑一起被推开。
    // 以前是二选一：射线打中雕塑就只改雕塑（而且半径减半），没打中就只改地面，
    // 手一放到雕塑脚下射线就在两者之间来回跳，一帧推地一帧推雕塑，光标也跟着跳。
    const R = U.handRadius.value;
    const P = S.cur;
    const nearGround = P.y - groundAt(P.x, P.z) < R * 0.6;
    const hitSculpts = live ? sculpts.touching(P, R) : [];

    U.handActive.value = live && nearGround ? 1 : 0;
    sculpts.setBrush(hitSculpts.length > 0, P, R);
    if (S.engaged && hitSculpts.length) {
      const m = params.mode === HAND.PUSH ? 'push' : params.mode === HAND.PILE ? 'pile' : 'smooth';
      for (const sc of hitSculpts) sculpts.brush(sc, P, R, m, dt);
    }
    if (!nearGround) {
      // 手在雕塑半腰 / 顶上：地面够不着
      S.stamp = false;
      return;
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
    field = null;
    sculpts.clear();
    stamps.length = 0;
  }

  /** clipmap 窗口中心，每帧由 main.js 告知 */
  function setCenter(x, z) {
    center.set(x, z);
    sculpts.prune(x, z);
  }

  /**
   * 屏幕像素坐标 -> 雪面上的点（新手指引要把圆圈画在雪面上）。
   * 打不到地面返回 false。
   */
  const _pr = new THREE.Raycaster();
  const _pn = new THREE.Vector2();
  function pickGround(sx, sy, out) {
    const r = dom.getBoundingClientRect();
    _pn.set(((sx - r.left) / r.width) * 2 - 1, -((sy - r.top) / r.height) * 2 + 1);
    _pr.setFromCamera(_pn, camera);
    return raycastGround(_pr.ray.origin, _pr.ray.direction, out);
  }

  return { update, setSurface, setCenter, pickGround, state: S, sculpts };
}
