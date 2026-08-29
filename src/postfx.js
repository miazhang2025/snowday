/**
 * postfx.js — 后期管线
 *
 *   pre-pass (只画不透明物体) ──> depth + 打包法线 + 速度
 *   scene pass ──────────────> 颜色（AO 通过 contextNode 注入光照）
 *        │
 *        ├─ GTAO    屏幕空间环境光遮蔽。高度场那套光线步进只知道雪自己，
 *        │          石头 / 树 / 之后放进来的模型压在雪里的接触暗部要靠它。
 *        │          用 builtinAOContext 注进光照，只影响间接光 —— 直接乘在
 *        │          最终颜色上会把太阳直射也一起压暗，那是错的
 *        ├─ TRAA    时域抗锯齿。冰晶闪烁和风纹法线属于「着色走样」，
 *        │          MSAA 治不了，只有时域累积压得住
 *        ├─ Godrays 体积光轴：雪天空气里全是悬浮冰晶，逆光该有光柱
 *        ├─ Bloom   冰晶高光的辉光
        └─ Lens    镜头：四角虚化 + 暗角
 *
 * pre-pass 特意设成只画不透明物体：九万片半透明雪花如果混进法线/速度缓冲，
 * GTAO 会以为那里有几何体，TRAA 也会被错误的速度带偏。
 */

import * as THREE from 'three/webgpu';
import {
  pass, mrt, velocity, normalView, uniform, mix, float, vec2, vec3, screenUV, screenSize,
  sample, smoothstep, Fn, If, packNormalToRGB, unpackRGBToNormal, builtinAOContext,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

export function createPostFX(renderer, scene, camera, sun) {
  const Pipeline = THREE.RenderPipeline || THREE.PostProcessing;
  const pipeline = new Pipeline(renderer);

  // ---------------------------------------------------------- 预通道

  const prePass = pass(scene, camera);
  prePass.name = 'Pre-Pass';
  prePass.transparent = false;                    // 雪花不进法线/速度缓冲
  prePass.setMRT(mrt({
    output: packNormalToRGB(normalView),
    velocity,
  }));

  // 法线用 8 位存就够，省一半带宽
  prePass.getTexture('output').type = THREE.UnsignedByteType;

  const preNormal = sample((uv) => unpackRGBToNormal(prePass.getTextureNode().sample(uv)));
  const preDepth = prePass.getTextureNode('depth');
  const preVelocity = prePass.getTextureNode('velocity');

  // ---------------------------------------------------------- 各效果

  const aoNode = ao(preDepth, preNormal, camera);
  aoNode.resolutionScale = 0.5;                   // AO 是低频的，半分辨率足够
  aoNode.useTemporalFiltering = true;
  aoNode.radius.value = 0.45;
  aoNode.thickness.value = 1.0;
  aoNode.distanceExponent.value = 1.6;
  aoNode.samples.value = 12;
  const aoTex = aoNode.getTextureNode();

  const raysNode = godrays(preDepth, camera, sun);
  raysNode.resolutionScale = 0.5;
  raysNode.raymarchSteps.value = 40;
  raysNode.density.value = 0.55;
  raysNode.maxDensity.value = 0.26;
  raysNode.distanceAttenuation.value = 2.4;
  const raysTex = raysNode.getTextureNode();

  // ---------------------------------------------------------- 镜头
  //
  // 真实镜头有两个到处都在、但一旦缺席就说不出哪里不对的特征：
  // 视场边缘分辨率下降（场曲/像散），以及四角进光量变少（暗角）。
  // 加一点点能让画面「像是拍出来的」而不是「算出来的」。
  //
  // 性能上只有一条要求：**画面中央一分钱都不能花**。所以虚化被包在
  // `If` 里，判据是归一化半径。中心那一大片的整个 wave 都是 false，
  // 直接跳过九次采样；只有四角真的掏钱。
  const vignette = uniform(0.30);
  const lensBlur = uniform(0.35);

  /** 归一化半径：中心 0，四角 1。必须按画幅比例校正，否则宽屏上暗角会是椭圆。 */
  const lensRadius = Fn(() => {
    const p = screenUV.sub(0.5).mul(2.0);
    const ar = screenSize.x.div(screenSize.y);
    return vec2(p.x.mul(ar), p.y).div(vec2(ar, 1.0).length()).length();
  })();

  const LENS_TAPS = 8;
  const LENS_MAX = 0.010;        // 最大偏移 = 画面高度的 1%（与分辨率无关）

  /** 四角虚化：中心保留 AA 后的锐利结果，边角混向多次采样的模糊 */
  function lensSoften(sharp, sceneTex) {
    return Fn(() => {
      const e = smoothstep(0.58, 1.0, lensRadius);        // 只有四角 > 0
      const out = vec3(sharp).toVar();

      If(e.greaterThan(0.003), () => {
        const ar = screenSize.x.div(screenSize.y);
        const rad = e.mul(lensBlur).mul(LENS_MAX);
        const acc = vec3(sceneTex.sample(screenUV)).toVar();
        for (let i = 0; i < LENS_TAPS; i++) {
          const a = (i / LENS_TAPS) * Math.PI * 2;
          // x 方向除以画幅比，采样点才是圆的而不是椭圆的
          const off = vec2(Math.cos(a), Math.sin(a)).mul(rad).div(vec2(ar, 1.0));
          acc.addAssign(vec3(sceneTex.sample(screenUV.add(off))));
        }
        out.assign(mix(out, acc.div(LENS_TAPS + 1), e));
      });

      return out;
    })();
  }

  /** 暗角。放在最后，连辉光一起压 —— 它是镜头的进光量，不是场景的一部分 */
  const lensVignette = Fn(() =>
    float(1).sub(vignette.mul(smoothstep(0.30, 1.06, lensRadius).pow(1.5))))();

  const aoStrength = uniform(1.0);
  const rayStrength = uniform(0.55);
  const rayTint = uniform(new THREE.Color(0xffffff));

  const state = { taa: true, ao: true, rays: true, bloom: 0.5 };
  let bloomNode = null;

  // ---------------------------------------------------------- 组装

  function rebuild() {
    const scenePass = pass(scene, camera);
    scenePass.name = 'Scene';

    // AO 注进光照上下文：只作用于间接光
    if (state.ao) {
      const occ = mix(float(1), aoTex.sample(screenUV).r, aoStrength);
      scenePass.contextNode = builtinAOContext(occ);
    }

    // 渲染器没开 MSAA（见 main.js），所以关掉 TRAA 时要有个空间抗锯齿兜底
    const sceneTex = scenePass.getTextureNode('output');
    let c = state.taa
      ? traa(scenePass, preDepth, preVelocity, camera)
      : fxaa(sceneTex);

    // 先虚化再叠光轴和辉光：那两个本来就是软的，没必要再糊一遍，
    // 而且这样能省掉一次「把合成结果落成纹理」的全屏 pass。
    // 边角采的是未经 AA 的原始场景 —— 反正那里已经糊掉了，AA 与否看不出来。
    c = lensSoften(c, sceneTex);

    if (state.rays) {
      c = c.add(raysTex.mul(rayTint).mul(rayStrength));
    }

    bloomNode = bloom(c, state.bloom * 0.55, 0.62, 0.86);
    pipeline.outputNode = c.add(bloomNode).mul(lensVignette);
    pipeline.needsUpdate = true;
  }

  rebuild();

  return {
    pipeline,
    render: () => pipeline.render(),

    /** UI 改开关时调用；只有布尔量变化才重建管线 */
    setOptions(opts = {}) {
      let structural = false;
      for (const k of ['taa', 'ao', 'rays']) {
        if (opts[k] !== undefined && opts[k] !== state[k]) { state[k] = opts[k]; structural = true; }
      }
      if (opts.bloom !== undefined && opts.bloom !== state.bloom) {
        state.bloom = opts.bloom;
        if (bloomNode) bloomNode.strength.value = state.bloom * 0.55;
      }
      if (opts.aoStrength !== undefined) aoStrength.value = opts.aoStrength;
      if (opts.vignette !== undefined) vignette.value = opts.vignette;
      if (opts.lensBlur !== undefined) lensBlur.value = opts.lensBlur;
      if (opts.rayStrength !== undefined) rayStrength.value = opts.rayStrength;
      if (opts.rayTint) rayTint.value.copy(opts.rayTint);
      if (structural) rebuild();
    },

    state,
  };
}
