/**
 * interaction.js — 把鼠标当成一只手
 *
 * 鼠标射线打在「当前雪面高度」的水平面上得到手掌位置。每帧把上一帧和这一帧的位置
 * 作为一段线段送进 computeDeform，所以快速拖动也不会漏掉中间的雪。
 *
 *   左键按住拖动 —— 手掌贴着雪面推，雪从掌下被刮走、堆到手的前方，速度够快还会扬起粉雪
 *   左键轻点     —— 按一个手印（掌心 + 五指）
 *   1 / 2 / 3    —— 切换 推雪 / 抚平 / 堆雪
 *   右键拖动     —— 转视角，中键拖动 —— 平移，滚轮 —— 缩放
 */

import * as THREE from 'three/webgpu';
import { U, params, HAND, SPRAY, SPRAY_BATCH, HALF } from './config.js';
import { computeDeform } from './snowfield.js';
import { computeSprayEmit } from './snowfall.js';
import { terrainY } from './terrain.js';

const CLICK_MS = 200;      // 短于这个时间且几乎没动 → 判定为「轻点」
const CLICK_DIST = 0.09;   // 世界单位

const smoothstep01 = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

/**
 * 沿射线找和「地形 + 平均雪深」的交点。
 *
 * 地面不再是一个水平面，所以不能用 Plane.intersect 了。做法是最直接的：
 * 步进到第一次穿过地面，再二分几次收敛。步长按距离递增 ——
 * 近处要准（手就在那儿），远处只要能落在正确的格子里就行。
 *
 * 这里用的 terrainY 和 GPU 端的 terrainSample 读的是同一张高度图、
 * 同一套插值权重，所以「看到的」和「摸到的」是同一个面。
 */
const MARCH_MAX = 220;

function raycastGround(origin, dir, snow, out) {
  const surf = (x, z) => terrainY(x, z) + snow;
  let t = 0.05;
  let py = origin.y - surf(origin.x, origin.z);
  if (py <= 0) return false;                       // 相机已经在地面以下

  let step = 0.25;
  while (t < MARCH_MAX) {
    const nt = t + step;
    const x = origin.x + dir.x * nt;
    const z = origin.z + dir.z * nt;
    const y = origin.y + dir.y * nt - surf(x, z);
    if (y <= 0) {
      // 二分收敛：8 次就够到毫米级
      let lo = t, hi = nt;
      for (let i = 0; i < 8; i++) {
        const m = (lo + hi) * 0.5;
        const mx = origin.x + dir.x * m;
        const mz = origin.z + dir.z * m;
        if (origin.y + dir.y * m - surf(mx, mz) > 0) lo = m; else hi = m;
      }
      const m = (lo + hi) * 0.5;
      out.set(origin.x + dir.x * m, origin.y + dir.y * m, origin.z + dir.z * m);
      return true;
    }
    t = nt;
    py = y;
    step = Math.min(step * 1.22, 6.0);
  }
  return false;
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
  };

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
    dom.setPointerCapture?.(e.pointerId);
  });

  const release = (e) => {
    if (!S.down) return;
    S.down = false;
    const quick = performance.now() - S.downAt < CLICK_MS && S.moved < CLICK_DIST;
    // 轻点还没来得及「压下去」时，盖一个手印
    if (quick && !S.engaged && S.inField) {
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

  // ------------------------------------------------------------ 每帧

  function update(dt) {
    // 平均雪面高度：跟 computeAccumulate 用同一条收敛规则
    const target = Math.max(params.depth, 1e-4);
    const gate = 1 - smoothstep01(target * 0.45, target, S.estY);
    S.estY = Math.min(S.estY + U.depositRate.value * dt * gate, target * 1.08);

    prevPos.copy(S.cur);

    ray.setFromCamera(ndc, camera);
    S.hasHit = raycastGround(ray.ray.origin, ray.ray.direction, S.estY, hit);

    if (S.hasHit) {
      // 可交互的只有 L0 那 26m 的窗口，而窗口是跟着相机走的
      const lim = HALF * 0.96;
      S.inField = Math.abs(hit.x - center.x) < lim && Math.abs(hit.z - center.y) < lim;
      hit.x = THREE.MathUtils.clamp(hit.x, center.x - lim, center.x + lim);
      hit.z = THREE.MathUtils.clamp(hit.z, center.y - lim, center.y + lim);
      hit.y = terrainY(hit.x, hit.z) + S.estY;
      // 轻微跟随延迟，手看起来有一点重量
      S.cur.lerp(hit, S.down ? 0.75 : 0.45);
    } else {
      S.inField = false;
    }

    const dx = S.cur.x - prevPos.x;
    const dz = S.cur.z - prevPos.z;
    const step = Math.hypot(dx, dz);
    S.speed = step / Math.max(dt, 1e-4);
    if (step > 1e-3) S.axis.set(dx / step, dz / step);

    U.handPrev.value.copy(prevPos);
    U.handCur.value.copy(S.cur);
    U.handAxis.value.copy(S.axis);
    U.handActive.value = (S.over && S.inField && !controls.__dragging) ? 1 : 0;

    // 按下之后：移动一小段 或 按住一小会儿，手才真正「压进」雪里
    if (S.down) {
      S.moved += step;
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

  /** 清空/铺满之后重置雪面高度估计 */
  function setSurface(y) { S.estY = y; }

  /** clipmap 窗口中心，每帧由 main.js 告知 */
  function setCenter(x, z) { center.set(x, z); }

  return { update, setSurface, setCenter, state: S };
}
