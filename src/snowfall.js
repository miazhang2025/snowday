/**
 * snowfall.js — 空中的雪
 *
 *  1) 飘落的雪花（GPU 粒子）：风 + 湍流飘舞 + 终端速度，落到「当前积雪表面」时回到天上。
 *  2) 被手扬起的粉雪：推雪够快时从掌缘喷出的一小蓬雪沫，受重力和空气阻力，很快消散。
 *
 * 两者都用 Sprite + 实例化渲染（WebGPU 的 point primitive 只有 1px，必须走 Sprite）。
 */

import * as THREE from 'three/webgpu';
import {
  Fn, If, float, uint, vec2, vec3, vec4,
  instancedArray, instanceIndex, uv, positionView, cameraPosition,
  hash, select, mix, smoothstep,
} from 'three/tsl';

import { FLAKES, SPRAY, SPRAY_BATCH, SKY_TOP, FIELD_R, U } from './config.js';
import { sampleHeightXZ, noised } from './snowfield.js';

// ---------------------------------------------------------------- 缓冲区

const fPos = instancedArray(FLAKES, 'vec3');
const fVel = instancedArray(FLAKES, 'vec3');
const fRnd = instancedArray(FLAKES, 'vec4');   // x 尺寸 y 相位 z 亮度 w 自转

const sPos = instancedArray(SPRAY, 'vec3');
const sVel = instancedArray(SPRAY, 'vec3');
const sLife = instancedArray(SPRAY, 'vec4');   // x 剩余寿命 y 总寿命 z 尺寸 w 随机

// ---------------------------------------------------------------- 工具

const rnd = (i, salt) => hash(i.mul(uint(9781)).add(uint(salt)));
const rndT = (i, salt) => hash(i.mul(uint(9781)).add(uint(salt)).add(U.seed.toUint().mul(uint(2654435761))));

// 降雪区跟着 clipmap 窗口走 —— 场景是可以走动的，雪不能只下在世界原点那一块。
// U.fieldCenter 的 y 是窗口中心的地面高度，雪花的出生高度以它为基准。
const cx = () => U.fieldCenter.x;
const cz = () => U.fieldCenter.z;

/** 把坐标环绕回中心 ± FIELD_R，避免负数取模的坑 */
const wrapAround = (v, c) => v.sub(c).add(FIELD_R * 9).mod(FIELD_R * 2).sub(FIELD_R).add(c);

/** 出生点：窗口内随机一处，高度是「地面 + SKY_TOP」 */
const bornXZ = (r) => r.sub(0.5).mul(FIELD_R * 2);

// ---------------------------------------------------------------- 雪花

export const computeFlakeInit = Fn(() => {
  const r1 = rnd(instanceIndex, 1);
  const r2 = rnd(instanceIndex, 2);
  const r3 = rnd(instanceIndex, 3);
  const r4 = rnd(instanceIndex, 4);
  const r5 = rnd(instanceIndex, 5);

  fPos.element(instanceIndex).assign(vec3(
    bornXZ(r1).add(cx()),
    U.fieldCenter.y.add(r2.mul(SKY_TOP)),
    bornXZ(r3).add(cz()),
  ));
  fVel.element(instanceIndex).assign(vec3(0, -1, 0));
  // 尺寸分布偏小（少数大片雪花更显眼）
  fRnd.element(instanceIndex).assign(vec4(
    r4.mul(r4).mul(1.15).add(0.35),
    r5,
    r1.mul(0.35).add(0.72),
    r2.sub(0.5).mul(2.0),
  ));
})().compute(FLAKES);

export const computeFlakeUpdate = Fn(() => {
  const alive = instanceIndex.toFloat().lessThan(U.activeFlakes);

  If(alive, () => {
    const pos = fPos.element(instanceIndex);
    const vel = fVel.element(instanceIndex);
    const rr = fRnd.element(instanceIndex);

    const size = rr.x;
    const ph = rr.y.mul(6.2831853);
    const t = U.elapsed;

    // 终端速度：大片雪花落得更快
    const term = U.fallSpeed.mul(float(0.5).add(size.mul(0.85)));

    // 飘舞：两组不同频率的正弦叠加，越小的雪花被吹得越厉害
    const flut = vec3(
      t.mul(1.7).add(ph).sin().mul(t.mul(0.53).add(ph.mul(1.7)).cos()),
      t.mul(2.3).add(ph).sin().mul(0.22),
      t.mul(1.4).add(ph.mul(1.3)).cos().mul(t.mul(0.61).add(ph).sin()),
    ).mul(U.flutter.mul(1.15).div(float(0.45).add(size)));

    const want = vec3(U.wind.x, term.negate(), U.wind.z).add(flut);
    vel.assign(mix(vel, want, U.dt.mul(3.4).min(1)));
    pos.addAssign(vel.mul(U.dt));

    // 落到当前雪面 → 回到天上重新下
    const gh = sampleHeightXZ(pos.xz);
    If(pos.y.lessThan(gh.add(0.015)), () => {
      pos.assign(vec3(
        bornXZ(rndT(instanceIndex, 11)).add(cx()),
        U.fieldCenter.y.add(float(SKY_TOP).mul(rndT(instanceIndex, 13).mul(0.12).add(0.9))),
        bornXZ(rndT(instanceIndex, 17)).add(cz()),
      ));
      vel.assign(vec3(U.wind.x, term.negate(), U.wind.z));
    });

    // 被风吹出场地（或相机走远了）就绕回另一侧
    pos.x.assign(wrapAround(pos.x, cx()));
    pos.z.assign(wrapAround(pos.z, cz()));
  });
})().compute(FLAKES);

// ---------------------------------------------------------------- 粉雪（手扬起的雪沫）

export const computeSprayInit = Fn(() => {
  sLife.element(instanceIndex).assign(vec4(0, 1, 0, 0));
  sPos.element(instanceIndex).assign(vec3(0, -50, 0));
  sVel.element(instanceIndex).assign(vec3(0));
})().compute(SPRAY);

export const computeSprayEmit = Fn(() => {
  const j = U.emitOffset.toUint().add(instanceIndex).mod(uint(SPRAY));

  const r1 = rndT(j, 101);
  const r2 = rndT(j, 103);
  const r3 = rndT(j, 107);
  const r4 = rndT(j, 109);
  const r5 = rndT(j, 113);

  // 沿这一帧手掌扫过的线段随机取点，再往掌缘外散开
  const base = mix(U.handPrev, U.handCur, r1);
  const off = vec3(r2.sub(0.5), 0, r3.sub(0.5)).normalize().mul(U.handRadius.mul(r4.mul(0.55).add(0.55)));
  const p = base.add(off);
  const gh = sampleHeightXZ(p.xz);

  sPos.element(j).assign(vec3(p.x, gh.add(0.02).add(r5.mul(0.05)), p.z));

  const push = vec3(U.emitDir.x, 0, U.emitDir.z).mul(U.emitPower.mul(r2.mul(0.6).add(0.75)));
  const up = vec3(0, U.emitPower.mul(0.55).mul(r3.mul(0.9).add(0.5)).add(0.35), 0);
  const jit = vec3(r3.sub(0.5), r4.mul(0.5), r5.sub(0.5)).mul(U.emitPower.mul(0.5).add(0.35));
  sVel.element(j).assign(push.add(up).add(jit).add(off.mul(1.6)));

  const life = r4.mul(0.75).add(0.45);
  sLife.element(j).assign(vec4(life, life, r5.mul(0.7).add(0.5), r1));
})().compute(SPRAY_BATCH);

export const computeSprayUpdate = Fn(() => {
  const lf = sLife.element(instanceIndex);

  If(lf.x.greaterThan(0), () => {
    const pos = sPos.element(instanceIndex);
    const vel = sVel.element(instanceIndex);

    vel.y.addAssign(float(-5.4).mul(U.dt));
    vel.addAssign(U.wind.mul(U.dt).mul(0.8));
    vel.mulAssign(float(1).sub(U.dt.mul(2.6)).max(0.2));   // 粉雪阻力很大
    pos.addAssign(vel.mul(U.dt));

    lf.x.assign(lf.x.sub(U.dt));

    const gh = sampleHeightXZ(pos.xz);
    If(pos.y.lessThan(gh.add(0.01)), () => {
      lf.x.assign(0);
      pos.y.assign(-50);
    });
  });
})().compute(SPRAY);

// ---------------------------------------------------------------- 渲染

/**
 * 前向散射：视线朝着太阳看过去时返回 1。
 * 冰晶是强前向散射体，逆光下的雪幕会明显发亮 —— 这是雪天最好看的一件事，
 * 也是「一片白点」和「真的在下雪」之间的分界。
 */
const forwardGlow = (worldPos) =>
  cameraPosition.sub(worldPos).normalize().dot(U.sunDir).negate().clamp(0, 1);

/**
 * 冰晶高光。
 *
 * 每个粒子当成一小片冰晶：取向随机，而且**随下落翻滚**。用它对着太阳算高光，
 * 翻滚时就会一闪一闪 —— 这是真实雪幕最显眼的特征，也是「白点」和「冰晶」的分界。
 * 片晶两面都反光，所以取 |dot| 而不是 saturate。
 */
const crystalFlash = (worldPos, seed, spin, power) => {
  const H = U.sunDir.add(cameraPosition.sub(worldPos).normalize()).normalize();
  const t = U.elapsed.mul(spin).add(seed.mul(6.2831853));
  const n = vec3(
    t.sin(),
    t.mul(0.73).add(seed.mul(4.1)).cos(),
    t.mul(1.31).cos(),
  ).normalize();
  return n.dot(H).abs().pow(power);
};

/** 冰的色散：三个通道用略不同的指数，闪光边缘泛一点彩虹 */
const disperse = (g) => vec3(g.pow(0.84), g, g.pow(1.22));

/**
 * 六角枝晶的轮廓：三条对穿的臂 = 六个方向。
 * 只给近处的大雪花用 —— 远处只有几个像素，画了也看不见，反而会闪成噪点。
 */
const dendrite = (p) => {
  const arm = (ax, ay) => {
    const along = p.x.mul(ax).add(p.y.mul(ay)).abs();
    const perp = p.x.mul(ay).sub(p.y.mul(ax)).abs();
    return float(1).sub(perp.mul(11.0)).clamp(0, 1)
      .mul(float(1).sub(along.mul(2.1)).clamp(0, 1));
  };
  return arm(1, 0).max(arm(0.5, 0.8660254)).max(arm(-0.5, 0.8660254));
};

export function createSnowfall(scene) {
  // ------------------------------------------------------------ 飘落的雪

  const flakeMat = new THREE.SpriteNodeMaterial();
  flakeMat.transparent = true;
  flakeMat.depthWrite = false;
  flakeMat.sizeAttenuation = true;

  flakeMat.positionNode = fPos.element(instanceIndex);

  flakeMat.scaleNode = Fn(() => {
    const rr = fRnd.element(instanceIndex);
    const on = select(instanceIndex.toFloat().lessThan(U.activeFlakes), float(1), float(0));
    const s = U.flakeScale.mul(rr.x).mul(on);
    // 下落带来的轻微拖影：落得越快拉得越长
    const stretch = U.fallSpeed.mul(0.10).clamp(0, 0.5).mul(rr.x.mul(0.5).add(0.6));
    return vec2(s, s.mul(float(1).add(stretch)));
  })();

  // 慢慢摆动而不是整片打转，拖影方向才能大致保持竖直
  flakeMat.rotationNode = Fn(() => {
    const rr = fRnd.element(instanceIndex);
    return U.elapsed.mul(rr.w.mul(0.9)).add(rr.y.mul(6.283)).sin().mul(0.45);
  })();

  flakeMat.colorNode = Fn(() => {
    const rr = fRnd.element(instanceIndex);
    const wp = fPos.element(instanceIndex);
    const fwd = forwardGlow(wp);

    // 底色来自天光；逆光时前向散射把雪花点亮
    const ambientLit = U.skyHorizon.mul(0.80).add(U.skyTop.mul(0.22));
    const sunLit = U.sunColor.mul(U.sunPower.mul(0.15))
      .mul(fwd.pow(2.2).mul(2.6).add(0.22));

    // 翻滚中的冰晶面对上太阳时的爆闪。两级：宽叶给底噪，窄叶给偶发的强闪
    const spin = rr.w.mul(2.4).add(0.9);
    const g = crystalFlash(wp, rr.y, spin, 16.0).mul(0.55)
      .add(crystalFlash(wp, rr.y.add(0.37), spin.mul(1.37), 90.0).mul(1.5));
    const spark = disperse(g).mul(U.sunColor)
      .mul(U.sunPower.mul(0.60)).mul(U.crystals.mul(0.9).add(0.35));

    return ambientLit.add(sunLit).add(spark).mul(rr.z.mul(0.42).add(0.80));
  })();

  flakeMat.opacityNode = Fn(() => {
    const rr = fRnd.element(instanceIndex);
    const p = uv().sub(0.5);
    // 每片雪花的边缘软硬不一样：有的锐利有的虚，画面才有景深感
    const soft = rr.y.mul(7.0).fract().mul(1.9).add(0.85);
    const d = p.length().mul(2.0).clamp(0, 1);
    const disc = float(1).sub(d).pow(soft);
    const core = float(1).sub(d.div(0.45).clamp(0, 1)).pow(2.0).mul(0.45);
    let a = disc.add(core).clamp(0, 1);

    const dist = positionView.z.negate();
    // 六角枝晶只在中近距离、且雪花本身够大的时候才显形
    const shape = dist.smoothstep(1.0, 2.8)
      .mul(float(1).sub(dist.smoothstep(4.5, 10.0)))
      .mul(rr.x.sub(0.5).clamp(0, 1));
    a = mix(a, a.max(dendrite(p).mul(0.95)), shape);

    const near = dist.smoothstep(0.30, 1.7);                     // 太近的淡出，别糊住镜头
    const far = float(1).sub(dist.smoothstep(24.0, 44.0));        // 太远的也收掉，省 overdraw
    return a.mul(near).mul(far).mul(0.88);
  })();

  const flakes = new THREE.Sprite(flakeMat);
  flakes.count = FLAKES;
  flakes.frustumCulled = false;
  flakes.renderOrder = 10;
  scene.add(flakes);

  // ------------------------------------------------------------ 手扬起的粉雪

  const sprayMat = new THREE.SpriteNodeMaterial();
  sprayMat.transparent = true;
  sprayMat.depthWrite = false;
  sprayMat.sizeAttenuation = true;

  sprayMat.positionNode = sPos.element(instanceIndex);

  sprayMat.scaleNode = Fn(() => {
    const lf = sLife.element(instanceIndex);
    const age = float(1).sub(lf.x.div(lf.y.max(0.001))).clamp(0, 1);
    // 雪沫在飞散过程中膨胀
    const s = lf.z.mul(0.040).mul(age.mul(2.8).add(0.5))
      .mul(select(lf.x.greaterThan(0), float(1), float(0)));
    return vec2(s);
  })();

  sprayMat.rotationNode = Fn(() => sLife.element(instanceIndex).w.mul(6.283))();

  sprayMat.colorNode = Fn(() => {
    const lf = sLife.element(instanceIndex);
    const wp = sPos.element(instanceIndex);
    const fwd = forwardGlow(wp);

    // 粉雪是密集的细冰晶云，前向散射比单片雪花还强
    const ambientLit = U.skyHorizon.mul(0.92).add(U.skyTop.mul(0.18));
    const sunLit = U.sunColor.mul(U.sunPower.mul(0.20))
      .mul(fwd.pow(1.9).mul(3.2).add(0.30));

    // 整团雪沫的冰晶反光：翻得比落雪快得多（是被打飞出去的）
    const puffFlash = crystalFlash(wp, lf.w, lf.w.mul(5.0).add(3.0), 26.0);

    // 团内部的碎晶：噪声挑出几个亮点，让它看起来是「一把冰晶」而不是一团糊
    const p = uv().sub(0.5);
    const n = noised(p.mul(9.0).add(vec2(lf.w.mul(71.0), lf.w.mul(37.0)))).x;
    const specks = smoothstep(0.70, 0.93, n).mul(crystalFlash(wp, n, 7.0, 12.0).mul(0.7).add(0.35));

    const spark = disperse(puffFlash.mul(0.8).add(specks.mul(1.3)))
      .mul(U.sunColor).mul(U.sunPower.mul(0.55))
      .mul(U.crystals.mul(0.9).add(0.30));

    return ambientLit.add(sunLit).add(spark);
  })();

  sprayMat.opacityNode = Fn(() => {
    const lf = sLife.element(instanceIndex);
    const k = lf.x.div(lf.y.max(0.001)).clamp(0, 1);      // 1 → 0

    // 用噪声把边缘打碎，看起来像一蓬雪沫而不是一个圆点
    const p = uv().sub(0.5);
    const n = noised(p.mul(5.5).add(vec2(lf.w.mul(53.0), lf.w.mul(29.0)))).x;
    const d = p.length().mul(2.0).add(n.sub(0.5).mul(0.55));
    const puff = float(1).sub(d.clamp(0, 1)).pow(1.7);

    const fadeIn = float(1).sub(k.smoothstep(0.88, 1.0));   // 出生瞬间快速浮现
    return puff.mul(fadeIn).mul(k.pow(0.75)).mul(0.45);
  })();

  const spray = new THREE.Sprite(sprayMat);
  spray.count = SPRAY;
  spray.frustumCulled = false;
  spray.renderOrder = 11;
  scene.add(spray);

  return { flakes, spray, flakeMat, sprayMat };
}
