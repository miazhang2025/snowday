/**
 * molds.js — 雪模具的形状库
 *
 * 像玩沙子一样：挑一个模具，在雪地上按一下，就扣出一坨那个形状的雪。
 *
 * 每个模具就是一个**归一化的高度剖面**。输入是以模具尺度归一化的局部坐标
 * （u 沿模具朝向、v 横向），输出 vec2：
 *
 *   x  高度，也是归一化的 —— 乘 moldScale 才是米
 *   y  轮廓的 2D 有向距离，负 = 在里面。用来画预览的描边、以及盖章时的边缘抗锯齿
 *
 * 为什么做成「写进高度场」而不是「摆一个模型」：
 *
 * 整个雪场本来就是一张高度场，模具直接盖进去之后，它就**是雪**了 ——
 * 次表面散射、冰晶闪烁、风壳、断面层理、光线步进的自阴影和天空遮蔽、
 * 形变留存（走开再回来还在）、休止角塌落，一件都不用重做。
 * 也不存在「模型浮在雪面上」那道永远对不齐的接缝。
 *
 * 代价是高度场表达不了悬空结构：拱门的洞、屋檐、伸出来的胳膊都做不出来。
 * 所以这套形状全部按「从上往下看每一点最高多少」来设计 —— 雪屋的门只能是
 * 一条门廊的凸起，不能是洞；球也只能露出赤道以上那半边。
 *
 * 同一套形状写了两遍：
 *   TSL 一份给 GPU（盖章 + 预览描边）
 *   JS  一份给 CPU（射线拾取 —— 光标要能爬到已经堆好的东西上面去，
 *                   这样才能往塔顶上再摞一层，城堡才叠得起来）
 * 两份必须保持一致，改一边记得改另一边。JS 那份省掉了砌块缝、环脊这类
 * 只影响观感、不影响「人站在哪儿」的细节。
 */

import { If, float, vec2, select } from 'three/tsl';
import { U } from './config.js';

// ---------------------------------------------------------------- 模具表
//
// foot  归一化的包围半径 —— 拖动连放的间距、CPU 拾取的剔除半径都用它
// top   归一化的最高点，只用来报个数（面板上显示实际高度）

export const MOLDS = [
  { id: 'ball',    key: 'mold.ball',    foot: 1.00, top: 1.28 },
  { id: 'tower',   key: 'mold.tower',   foot: 1.15, top: 2.58 },
  { id: 'wall',    key: 'mold.wall',    foot: 1.74, top: 1.80 },
  { id: 'igloo',   key: 'mold.igloo',   foot: 1.55, top: 1.05 },
  { id: 'spire',   key: 'mold.spire',   foot: 1.05, top: 2.52 },
  { id: 'star',    key: 'mold.star',    foot: 1.05, top: 0.66 },
];

// ---------------------------------------------------------------- GPU 侧小工具

const sdBox = (p, b) => {
  const d = p.abs().sub(b);
  return d.max(vec2(0)).length().add(d.x.max(d.y).min(0));
};

/**
 * iq 的五角星有向距离。全靠两次镜像折叠 + 一段线段的距离，
 * 不需要 atan —— 这一点很要紧，TSL 各版本里两参数的 atan 名字反复改过。
 */
const sdStar5 = (p0, r, rf) => {
  const k1 = vec2(0.809016994375, -0.587785252292);
  const k2 = vec2(-0.809016994375, -0.587785252292);
  const p = vec2(p0.x.abs(), p0.y).toVar();
  p.subAssign(k1.mul(p.dot(k1).max(0).mul(2)));
  p.subAssign(k2.mul(p.dot(k2).max(0).mul(2)));
  p.assign(vec2(p.x.abs(), p.y.sub(r)));
  const ba = vec2(0.587785252292, 0.809016994375).mul(rf).sub(vec2(0, 1));
  const h = p.dot(ba).div(ba.dot(ba)).clamp(0, r);
  return p.sub(ba.mul(h)).length().mul(p.y.mul(ba.x).sub(p.x.mul(ba.y)).sign());
};

/** 三角波，0..1，在 fract == 0.5 处取到 1 —— 拿来做砌块横缝 */
const tri = (x) => float(1).sub(x.fract().mul(2).sub(1).abs());

// ---------------------------------------------------------------- 六个形状（GPU）

/**
 * 0 雪球 —— 一个球。
 *
 * 高度场画不出赤道以下的内收，所以一个「整球」的剖面到赤道就直接掉到地面，
 * 边上会有一圈垂直的裙边。这不是要遮掩的瑕疵，而是**本来就该这样**：
 * 一颗雪球滚在雪地上，本来就会陷进去一截，露出来的正是赤道以上那部分。
 *
 * 所以球心压到 0.28 —— 球陷掉约四分之一，裙边只剩薄薄一圈，
 * 再让盖章那边的软并集（半径 5cm 的圆角）把它和周围的雪焊在一起，
 * 看上去就是一颗坐在雪窝里的球，而不是一个贴上去的半球。
 */
const BALL_SINK = 0.28;

const mBall = (p) => {
  const d2 = p.dot(p);
  const t = float(1).sub(d2);
  const h = select(t.greaterThan(0.0), float(BALL_SINK).add(t.max(0).sqrt()), float(0));
  return vec2(h, d2.sqrt().sub(1.0));
};

/**
 * 1 塔楼 —— 外墙 + 中间凹下去的平台 + 一圈雉堞 + 一圈基座。
 *
 * 雉堞要按方位角分八段。这里没用 atan，而是用倍角公式把 cos(8θ) 从
 * 单位向量直接推出来：cos(2θ)=c²-s²，连推三次就到 cos(8θ)，
 * 它大于 0 的那八段就是八个垛口。四次乘加，比 atan 便宜也更稳。
 */
const mTower = (p) => {
  const r = p.length();
  const inv = r.max(1e-4);
  const c1 = p.x.div(inv);
  const s1 = p.y.div(inv);
  const c2 = c1.mul(c1).sub(s1.mul(s1));
  const s2 = c1.mul(s1).mul(2);
  const c4 = c2.mul(c2).sub(s2.mul(s2));
  const s4 = c2.mul(s2).mul(2);
  const c8 = c4.mul(c4).sub(s4.mul(s4));

  const h = float(0).toVar();
  h.assign(select(r.lessThan(1.15), float(0.30), float(0)));           // 基座
  h.assign(select(r.lessThan(1.00), float(2.16), h));                  // 外墙
  h.assign(select(r.lessThan(1.00).and(r.greaterThan(0.64)).and(c8.greaterThan(0.0)),
    float(2.58), h));                                                  // 雉堞
  h.assign(select(r.lessThan(0.64), float(1.86), h));                  // 平台

  return vec2(h, r.sub(1.15));
};

/** 2 城墙 —— 沿模具朝向的一段带垛口的墙，拖着放能连成一长条 */
const mWall = (p) => {
  const body = sdBox(p, vec2(1.60, 0.40));
  const base = sdBox(p, vec2(1.74, 0.54));
  const mer = p.x.mul(1.25).fract().lessThan(0.52);

  const h = float(0).toVar();
  h.assign(select(base.lessThan(0.0), float(0.28), float(0)));
  h.assign(select(body.lessThan(0.0), float(1.46), h));
  h.assign(select(body.lessThan(0.0).and(mer), float(1.80), h));

  return vec2(h, base);
};

/**
 * 3 雪屋 —— 半球 + 沿朝向伸出去的门廊。
 * 门是做不出来的（高度场没有洞），所以只做成一条半圆柱的门廊凸起。
 * 表面按高度切几道横缝，看起来像是一块块雪砖砌的。
 */
const mIgloo = (p) => {
  const r = p.length();
  const dome = float(1).sub(r.mul(r)).max(0).sqrt().mul(1.05);
  const tb = sdBox(p.sub(vec2(1.00, 0)), vec2(0.48, 0.34));
  const tun = float(1).sub(p.y.div(0.34).clamp(-1, 1).pow(2)).max(0).sqrt().mul(0.50);

  const h = float(0).toVar();
  h.assign(select(r.lessThan(1.0), dome, float(0)));
  h.assign(select(tb.lessThan(0.0), h.max(tun), h));

  const seam = tri(h.mul(4.6)).pow(5.0).mul(0.038);
  h.assign(h.sub(select(h.greaterThan(0.10), seam, float(0))).max(0));

  return vec2(h, r.sub(1.0).min(tb));
};

/** 4 尖塔 —— 一个带基座和几道环脊的圆锥，沙滩上那只小桶扣出来的样子 */
const mSpire = (p) => {
  const r = p.length();
  const cone = float(1).sub(r.div(0.92)).max(0).mul(2.30);

  const h = float(0).toVar();
  h.assign(select(r.lessThan(1.05), float(0.22), float(0)));
  h.assign(select(r.lessThan(0.92), cone.add(0.22), h));

  const ring = tri(h.mul(1.7)).pow(6.0).mul(0.055);
  h.assign(h.sub(select(h.greaterThan(0.35), ring, float(0))).max(0));

  return vec2(h, r.sub(1.05));
};

/** 5 星形 —— 沙模里最经典的那个，用来给城墙压边和铺路 */
const mStar = (p) => {
  const d = sdStar5(p, 1.0, 0.44);
  const h = d.negate().mul(3.2).clamp(0, 1).mul(0.18).add(0.48);
  return vec2(select(d.lessThan(0.0), h, float(0)), d);
};

// ---------------------------------------------------------------- GPU 入口

/**
 * 世界 xz -> 模具局部坐标（归一化）。
 * u 沿 moldAxis，v 是它右手边的法向。
 */
export const moldLocal = (xz) => {
  const d = xz.sub(U.moldPos.xz);
  const a = U.moldAxis;
  const rt = vec2(a.y, a.x.negate());
  return vec2(d.dot(a), d.dot(rt)).div(U.moldScale.max(1e-3));
};

/**
 * 按 U.moldType 取出对应的形状。分支条件是 uniform，
 * 整个 workgroup / draw 走同一条路，没有发散代价。
 */
export const moldShape = (p) => {
  const out = vec2(0, 1).toVar();
  const m = U.moldType;
  If(m.lessThan(0.5), () => out.assign(mBall(p)))
    .ElseIf(m.lessThan(1.5), () => out.assign(mTower(p)))
    .ElseIf(m.lessThan(2.5), () => out.assign(mWall(p)))
    .ElseIf(m.lessThan(3.5), () => out.assign(mIgloo(p)))
    .ElseIf(m.lessThan(4.5), () => out.assign(mSpire(p)))
    .Else(() => out.assign(mStar(p)));
  return out;
};

// ---------------------------------------------------------------- CPU 侧（必须和上面一致）
//
// 只算高度，不算有向距离 —— 射线拾取只关心「这一点的雪面有多高」。

const jsBox = (u, v, bx, by) => {
  const dx = Math.abs(u) - bx;
  const dy = Math.abs(v) - by;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
};

const jsStar5 = (u0, v0, r, rf) => {
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

/**
 * 归一化局部坐标 -> 归一化高度。和 GPU 那六个函数一一对应。
 * 砌块横缝、眼窝这些只有几毫米的细节故意没做 —— 它们不改变「站在哪儿」。
 */
export function moldHeight(type, u, v) {
  switch (type | 0) {
    case 0: {                                   // 雪球
      const t = 1 - (u * u + v * v);
      return t > 0 ? BALL_SINK + Math.sqrt(t) : 0;
    }
    case 1: {                                   // 塔楼
      const r = Math.hypot(u, v);
      if (r >= 1.15) return 0;
      if (r < 0.64) return 1.86;
      if (r >= 1.00) return 0.30;
      const c1 = u / Math.max(r, 1e-4), s1 = v / Math.max(r, 1e-4);
      const c2 = c1 * c1 - s1 * s1, s2 = 2 * c1 * s1;
      const c4 = c2 * c2 - s2 * s2, s4 = 2 * c2 * s2;
      return (c4 * c4 - s4 * s4) > 0 ? 2.58 : 2.16;
    }
    case 2: {                                   // 城墙
      if (jsBox(u, v, 1.74, 0.54) >= 0) return 0;
      if (jsBox(u, v, 1.60, 0.40) >= 0) return 0.28;
      const f = u * 1.25 - Math.floor(u * 1.25);
      return f < 0.52 ? 1.80 : 1.46;
    }
    case 3: {                                   // 雪屋
      const r = Math.hypot(u, v);
      let h = r < 1 ? Math.sqrt(Math.max(0, 1 - r * r)) * 1.05 : 0;
      if (jsBox(u - 1.00, v, 0.48, 0.34) < 0) {
        const t = Math.min(1, Math.max(-1, v / 0.34));
        h = Math.max(h, Math.sqrt(Math.max(0, 1 - t * t)) * 0.50);
      }
      return h;
    }
    case 4: {                                   // 尖塔
      const r = Math.hypot(u, v);
      if (r >= 1.05) return 0;
      if (r >= 0.92) return 0.22;
      return Math.max(0, 1 - r / 0.92) * 2.30 + 0.22;
    }
    default: {                                  // 星形
      const d = jsStar5(u, v, 1.0, 0.44);
      if (d >= 0) return 0;
      return Math.min(1, Math.max(0, -d * 3.2)) * 0.18 + 0.48;
    }
  }
}
