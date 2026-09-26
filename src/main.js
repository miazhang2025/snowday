/**
 * main.js — 启动、主循环、后期
 *
 * 每帧的 GPU 流水线（每一级 clipmap 都跑一遍，粗的先跑）：
 *   refresh  →  (deform)  →  relax  →  accumulate  →  lighting
 *   →  flakes  →  spray  →  render(+bloom)
 */

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { params, U, refresh, isEnvDirty, clearEnvDirty, GRID, LEVELS, spanOf } from './config.js';
import {
  createSnowField, updateClipmap, refreshSnow, stashSnow, stepSnow, lightSnow,
  fillSnow as fillSnowGPU,
} from './snowfield.js';
import { uploadTerrain, terrainY, terrainAt, TERRAIN_HALF } from './terrain.js';
import { batchModel } from './batch.js';
import {
  createSnowfall, computeFlakeInit, computeFlakeUpdate,
  computeSprayInit, computeSprayUpdate,
} from './snowfall.js';
import {
  createSky, createFog, createLights, createEnvironment, syncLights, setEnvInfo,
  bindGodrayShadow,
} from './sky.js';
import { createPostFX } from './postfx.js';
import { createScenery } from './scenery.js';
import { createInteraction } from './interaction.js';
import { initUI } from './ui.js';
import { loadModel, unloadModel } from './models.js';
import { t, applyStatic } from './i18n.js';
import { initLanding } from './landing.js';

// 载入画面在 init 之前就要有文字，所以这里先刷一次静态文案
applyStatic();

let renderer, scene, camera, controls, lights, env, postfx, interaction;
const props = [];      // 每个 BatchedMesh 组的 { update, meshes, stats }
let lastBake = -1e9;
const timer = new THREE.Timer();

// 4K 原图 15MB，但它只用来烘环境贴图、从不直接显示 —— 1K 在固定机位对比下
// 和 4K 的差异落在 TAA 的噪声底里。用 tools/shrink-hdri.py 生成。
const HDRI_URL = 'assets/winter_lake_1k.exr';

// 外部模型。原始文件都是 8K 贴图直出的大资产，用 tools/optimize-glb.py 压过：
//   plant 97.9→3.6MB   pine 2.7→1.7MB   rock1 210→4.5MB   rock2 135.5→2.2MB   tree 92.3→4.9MB
const PLANT_URL = 'assets/plant.opt.glb';
const TREE_URL = 'assets/tree.opt.glb';
const PINE_URL = 'assets/pine.opt.glb';
const ROCK1_URL = 'assets/rock1.opt.glb';
const ROCK2_URL = 'assets/rock2.opt.glb';

/**
 * 用固定种子撒一圈，避开中心的玩雪区。
 *
 * 半径取 sqrt 是为了**面积均匀** —— 直接对半径取均匀分布的话，
 * 内圈会挤成一坨、外圈稀稀拉拉，撒到 380m 时一眼就能看出来。
 * 另外太陡的坡上不放东西：那里雪都挂不住，树石头也该是浮着或者陷进去的。
 */
function scatter(count, rMin, rMax, seed, sMin, sMax, opts = {}) {
  const { maxSlope = 0.55, clumps = 0, spread = 20 } = opts;
  let s = seed >>> 0;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const r2a = rMin * rMin, r2b = rMax * rMax;
  const lim = TERRAIN_HALF - 40;

  // 成丛：先撒一批丛心，实例再围着丛心散开。
  // 均匀撒满整个圆的话，树是「到处都有一点」—— 既没有林子的密度，
  // 又没有空地，而且远处每一棵都得画。成丛之后有疏有密，好看也便宜。
  const seeds = [];
  for (let i = 0; i < clumps; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(r2a + rnd() * (r2b - r2a));
    seeds.push([Math.cos(a) * r, Math.sin(a) * r]);
  }

  const out = [];
  let guard = count * 30;
  while (out.length < count && guard-- > 0) {
    let x, z;
    if (clumps) {
      const [cx, cz] = seeds[(rnd() * clumps) | 0];
      // 两个均匀数相加近似高斯，够用了
      const g = () => (rnd() + rnd() + rnd() - 1.5) * spread;
      x = cx + g(); z = cz + g();
      if (x * x + z * z < r2a) continue;
    } else {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(r2a + rnd() * (r2b - r2a));
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    }
    if (Math.abs(x) > lim || Math.abs(z) > lim) continue;
    const t = terrainAt(x, z);
    if (Math.hypot(t.gx, t.gz) > maxSlope) continue;
    out.push([x, z, rnd() * Math.PI * 2, sMin + rnd() * (sMax - sMin)]);
  }
  return out;
}

const CAM_HOME = new THREE.Vector3(9.4, 5.0, 11.6);
const CAM_TARGET = new THREE.Vector3(0, 0.5, 0);
// 落地页的机位：贴着雪面、平着看出去，像 OG 图那样有前景有远景。
// 从高处俯看的话一地白，粉色的标题会被洗掉。
const CAM_LAND = new THREE.Vector3(6.4, 1.7, 8.0);
const CAM_LAND_TARGET = new THREE.Vector3(0, 1.0, 0);

// ---------------------------------------------------------------- 启动

async function init() {
  if (!navigator.gpu) throw new Error('NO_WEBGPU');

  // 地形要在任何人问「这一点多高」之前先生成好 —— 摆件、射线、GPU 都要用它
  uploadTerrain();

  scene = new THREE.Scene();
  createFog(scene, params);      // 带方向性的雾（背对太阳偏冷、朝向太阳偏暖）

  // 远平面从 700 拉到 2600：最外圈的裙边在 1300m 处
  camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.15, 2600);
  camera.position.copy(CAM_HOME);

  // 不开 MSAA：抗锯齿交给 TRAA（时域），而且 MSAA 的多重采样深度缓冲
  // 没法直接喂给 GTAO / TRAA 的深度采样，会触发 copyTextureToTexture 的采样数不匹配
  renderer = new THREE.WebGPURenderer({ antialias: false, trackTimestamp: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(pixelRatioFor(params.quality));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.90;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  await renderer.init();

  // --- 内容 ---
  createSky(scene);
  lights = createLights(scene, camera, renderer);
  createScenery(scene, { pines: false, rocks: false });   // 松树和石头改用真模型
  createSnowField(scene);
  createSnowfall(scene);

  // --- 相机控制：左键留给「手」，右键转视角，中键平移，滚轮缩放 ---
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(CAM_TARGET);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.minDistance = 1.6;
  controls.maxDistance = 60;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.addEventListener('start', () => { controls.__dragging = true; });
  controls.addEventListener('end', () => { controls.__dragging = false; });
  controls.update();

  // --- 全局光照：把这片天空烘成环境贴图 ---
  env = createEnvironment(renderer);

  // --- 空跑一帧，把级联的阴影图分配出来 ---
  // GodraysNode 在构造时就要拿到 light.shadow.map，而级联的图是在第一次渲染
  // （材质编译 -> ShadowNode.setup -> setupRenderTarget）里才建出来的。
  refreshSnow(renderer);
  stepSnow(renderer);
  lightSnow(renderer);
  renderer.render(scene, camera);
  if (!bindGodrayShadow(lights)) console.warn('[snow] 体积光拿不到阴影图，光轴会失效');

  // --- 后期：TRAA + 接触遮蔽 + 光轴 + 辉光 ---
  postfx = createPostFX(renderer, scene, camera, lights.sun);

  // --- 交互 ---
  interaction = createInteraction(renderer, scene, camera, controls, renderer.domElement);

  // --- UI ---
  initUI({
    onChange: applySettings,
    onFill: (v) => fillSnow(v),
    onResetView: resetView,
    onShot: takeShot,
    onQuality: (q) => renderer.setPixelRatio(pixelRatioFor(q)),
  });

  refresh();
  applySettings();
  maybeBakeEnv();                     // 第一帧就得有环境贴图

  // HDRI 环境光：异步加载，来了之后重烘一次。
  // 天空穹顶、太阳、雾仍然由「时间 / 阴天」那套参数驱动 —— HDRI 只负责间接光。
  env.load(HDRI_URL).then((info) => {
    setEnvInfo(info);
    refresh();
    applySettings();
    lastBake = -1e9;
    maybeBakeEnv();
    console.info(`[snow] HDRI ready: ${HDRI_URL} · 太阳方位 ${(info.sunAz * 180 / Math.PI).toFixed(1)}°`);
  }).catch((e) => {
    console.warn('[snow] HDRI 加载失败，回落到程序化天空环境光：', e.message || e);
  });

  // 外部模型：每个 glb 一个 BatchedMesh，实例数从几十涨到两千。
  // 都是异步的，任何一个失败都不影响主场景。
  const place = (url, opts) =>
    batchModel(scene, url, { groundAt: terrainY, ...opts })
      .then((h) => {
        props.push(h);
        const t = h.stats.lodTris.flat();
        console.info(`[snow] ${url.split('/').pop()}  ${h.stats.instances} 个实例  `
          + `LOD 三角形 ${t.join(' / ')}`);
        return h;
      })
      .catch((e) => console.warn(`[snow] ${url} 加载失败：`, e.message || e));

  // 分两层撒：近处一圈密的（玩雪区周围的「布景」，这是镜头最常看的地方），
  // 外面一大片稀的铺满到 380m。只用一层的话，要么近处空空荡荡、
  // 要么远处密到跑不动 —— 面积差着两个数量级。
  const both = (a, b) => a.concat(b);

  place(PINE_URL, {                       // 松树：主力
    targetHeight: 4.2, coatBias: 0.22, snowAmount: 1.25,
    alignSlope: 0.12, sink: 0.02, footprint: 0.12,   // 树竖着长；着地的只有树干，不是树冠
    instances: both(scatter(26, 9.0, 34.0, 6607, 0.62, 1.5),
      scatter(560, 30.0, 380.0, 3391, 0.62, 1.7, { clumps: 34, spread: 24 })),
  });
  place(ROCK1_URL, {                      // 大石
    targetHeight: 0.95, coatBias: 0.28, snowAmount: 1.4,
    alignSlope: 1.0, sink: 0.07,      // 石头躺在坡上本来就是斜的
    instances: both(scatter(10, 4.2, 16.0, 1327, 0.7, 1.6),
      scatter(180, 16.0, 340.0, 7717, 0.7, 2.4)),
  });
  place(ROCK2_URL, {                      // 小石
    targetHeight: 0.45, coatBias: 0.28, snowAmount: 1.4,
    alignSlope: 1.0, sink: 0.07,
    instances: both(scatter(14, 3.4, 15.0, 9091, 0.6, 1.5),
      scatter(300, 14.0, 340.0, 2273, 0.6, 2.0, { clumps: 40, spread: 16 })),
  });
  place(TREE_URL, {                       // 枯木（树桩）
    targetHeight: 1.15, coatBias: 0.30, snowAmount: 1.5,
    alignSlope: 0.55, sink: 0.05, footprint: 0.85,   // 树桩：一半跟坡，一半保持竖直
    instances: both(scatter(9, 5.0, 13.0, 4471, 0.7, 1.35),
      scatter(220, 13.0, 320.0, 5591, 0.7, 1.6, { clumps: 30, spread: 18 })),
  });
  place(PLANT_URL, {                      // 枯草丛：小，很快就被剔掉
    targetHeight: 0.85, coatBias: 0.10, snowAmount: 0.7,
    alignSlope: 0.40, sink: 0.03, footprint: 0.35,
    instances: both(scatter(30, 3.2, 13.0, 8123, 0.55, 1.5),
      scatter(600, 12.0, 170.0, 6143, 0.55, 1.7, { clumps: 46, spread: 11 })),
  });

  // --- 初始化 GPU 数据 ---
  renderer.compute(computeFlakeInit);
  renderer.compute(computeSprayInit);
  fillSnow(0);                       // 从裸地开始，让雪自己积起来

  // 调试/性能测量入口（也方便你在控制台里直接改参数）
  window.__snow = {
    THREE, renderer, scene, camera, controls, lights, env, postfx, params, U, refresh, applySettings,
    // 放模型：await __snow.loadModel('assets/cabin.glb', { scale: 2, center: true })
    fillSnow, props, interaction,
    loadModel: (url, opts) => loadModel(scene, url, opts),
    unloadModel: (root) => unloadModel(scene, root),
  };

  addEventListener('resize', onResize);
  watchDeviceLoss();

  renderer.setAnimationLoop(animate);
}

function pixelRatioFor(q) {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(dpr, q === 0 ? 1.0 : q === 1 ? 1.5 : 2.0);
}

/** refresh() 之后：把光、雾、后期参数同步过去 */
function applySettings() {
  syncLights(scene, lights);          // 顺带写好 scene.fog.color 和 groundRadiance
  scene.fog.density = params.fog;
  postfx?.setOptions({
    taa: params.taa,
    ao: params.ssao,
    rays: params.rays,
    bloom: params.bloom,
    vignette: params.vignette,
    lensBlur: params.lensBlur,
    rayTint: U.sunColor.value,
    // 0.55 是体积光还坏着的时候拍的（那会儿它其实没生效，见 README）。
    // 修好之后逆光方向会和大气透视叠在一起，画面下半截糊成一片白，所以砍到 0.32。
    rayStrength: params.rays ? 0.32 * Math.min(U.sunPower.value / 2.0, 1.2) : 0,
  });
}

/** 环境贴图重烘：只在天光变了才做，并且限流，拖滑杆时不会每帧烘一次 */
function maybeBakeEnv() {
  if (!isEnvDirty()) return;
  const now = performance.now();
  if (now - lastBake < 100) return;
  lastBake = now;
  clearEnvDirty();
  env.update(scene);
}

function fillSnow(depth) {
  fillSnowGPU(renderer, depth);
  interaction?.setSurface(depth);
}

// ---------------------------------------------------------------- 进场飞行
//
// 点了 ENTER 之后从落地页的低机位飞回玩雪的机位。在球坐标里插值而不是直线插：
// 落地页的镜头一直在绕圈，到点的时候可能正在对面，直线飞会从目标点边上擦过去，
// 画面一下子怼到脸上再翻过来。方位角走短的那一边。

let fly = null;
const _sph0 = new THREE.Spherical();
const _sph1 = new THREE.Spherical();
const _sph2 = new THREE.Spherical();
const _off = new THREE.Vector3();

function flyHome() {
  _sph0.setFromVector3(_off.subVectors(camera.position, controls.target));
  _sph1.setFromVector3(_off.subVectors(CAM_HOME, CAM_TARGET));
  let dTheta = _sph1.theta - _sph0.theta;
  dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
  fly = {
    t: 0, from: _sph0.clone(), dTheta, to: _sph1.clone(),
    q: controls.target.clone(),
  };
}

function stepFly(dt) {
  if (!fly) return;
  // 飞的途中用户自己抓住镜头了 —— 让给他
  if (controls.__dragging) { fly = null; return; }
  fly.t = Math.min(1, fly.t + dt / 2.2);
  const k = fly.t < 0.5 ? 4 * fly.t ** 3 : 1 - (-2 * fly.t + 2) ** 3 / 2;
  const s = _sph2.set(
    fly.from.radius + (fly.to.radius - fly.from.radius) * k,
    fly.from.phi + (fly.to.phi - fly.from.phi) * k,
    fly.from.theta + fly.dTheta * k,
  );
  controls.target.lerpVectors(fly.q, CAM_TARGET, k);
  camera.position.setFromSpherical(s).add(controls.target);
  if (fly.t >= 1) fly = null;
}

/** 落地页期间镜头在自转，绕到山坡那一侧时别钻进地里 */
function keepAboveGround() {
  const floor = terrainY(camera.position.x, camera.position.z) + 0.9;
  if (camera.position.y < floor) camera.position.y = floor;
}

function resetView() {
  fly = null;
  camera.position.copy(CAM_HOME);
  controls.target.copy(CAM_TARGET);
  controls.update();
}

// ---------------------------------------------------------------- 拍照
//
// 存的是 canvas 本身，所以面板、说明、品牌字这些 DOM 一个都不会进画面 ——
// 按下就是一张干净的风景照。
//
// 但光标环和模具预览是画在雪面着色里的，DOM 那一刀切不掉，得先把它们灭了。
// 麻烦在 TRAA：它是攒历史帧的，当帧灭掉之后画面里还留着九成的残影，
// 直接按快门反而比不灭更难看。所以灭掉之后空跑几帧，等历史冲干净再按。
// 8 帧在 60fps 下是 130ms，按下去察觉不到。
const SHOT_SETTLE = 8;
let shotFrames = 0;
let shotDone = null;

/**
 * 请求拍一张。真正的快门在主循环里按（见 animate），拿到 PNG 之后回调 done(blob)，
 * 由 photo.js 摆出预览页；失败时回调 done(null)。帧率低的时候这中间能差上好几秒。
 */
function takeShot(done) {
  if (shotFrames > 0) return;        // 上一张还没落地，别叠
  shotFrames = SHOT_SETTLE;
  shotDone = done || null;
}

function saveFrame() {
  // toBlob 是在**调用的这一刻**对画面取样的，回调只是拿结果，
  // 所以必须紧跟在 postfx.render() 后面、同一个 rAF 里调。
  renderer.domElement.toBlob((blob) => {
    if (!blob) console.warn('[snow] 截图失败：读不出画面');
    shotDone?.(blob || null);
    shotDone = null;
  }, 'image/png');
}

// ---------------------------------------------------------------- 走动
//
// clipmap 的意义要能走起来才看得出来，所以给一套 WASD：
// 整体平移 controls.target 和相机，方向取相机的水平朝向。Shift 加速。

const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.target !== document.body && e.target.tagName === 'INPUT') return;
  // 落地页、拍照预览开着的时候不走动
  if (document.body.matches('.landing, .viewing')) return;
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const _mv = new THREE.Vector3();
const _fw = new THREE.Vector3();
const _rt = new THREE.Vector3();
const _want = new THREE.Vector3();
const walkVel = new THREE.Vector3();   // 当前速度（世界坐标，m/s），带惯性

function walk(dt) {
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const r = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  // 注意别用 Space —— 它已经绑给「开关降雪」了
  const u = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
  if (!f && !r && !u && walkVel.lengthSq() < 1e-6) { walkVel.set(0, 0, 0); return; }

  camera.getWorldDirection(_fw);
  _fw.y = 0;
  if (_fw.lengthSq() < 1e-8) _fw.set(0, 0, -1);
  _fw.normalize();
  // 右手边 = forward × up（three 是右手系，y 朝上）
  _rt.set(-_fw.z, 0, _fw.x);

  // 目标速度；斜着走不比直着走快
  const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 46 : 9;
  _want.set(0, 0, 0).addScaledVector(_fw, f).addScaledVector(_rt, r);
  if (_want.lengthSq() > 1) _want.normalize();
  _want.multiplyScalar(speed);
  _want.y = u * speed;

  // 指数逼近目标速度：起步 ~0.15s 到位，松手 ~0.25s 滑停。和帧率无关。
  const k = 1 - Math.exp(-dt * (f || r || u ? 14 : 9));
  walkVel.lerp(_want, k);

  _mv.copy(walkVel).multiplyScalar(dt);

  camera.position.add(_mv);
  controls.target.add(_mv);

  // 别钻到地底下去
  const floor = terrainY(camera.position.x, camera.position.z) + 0.7;
  if (camera.position.y < floor) {
    const lift = floor - camera.position.y;
    camera.position.y += lift;
    controls.target.y += lift;
  }
}

// ---------------------------------------------------------------- 主循环

let fpsAcc = 0, fpsCnt = 0;
let propCount = 0;
const statsEl = document.getElementById('stats');

function animate() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 1 / 24);
  U.dt.value = dt;
  U.elapsed.value = timer.getElapsed();
  U.seed.value = (U.seed.value + 1) % 1000000;

  // --- 相机 ---
  walk(dt);
  stepFly(dt);
  controls.update();
  if (document.body.classList.contains('landing')) keepAboveGround();

  // --- clipmap 跟随观察点 ---
  // 用 controls.target 而不是相机位置：玩家真正在看的是那儿，
  // 拉远镜头时最细的那一级也应该留在观察点上。
  const c = updateClipmap(controls.target.x, controls.target.z);
  U.fieldCenter.value.y = terrainY(c.x, c.y);
  interaction.setCenter(c.x, c.y);

  // 雪下到几成了 —— clipmap 补格子时要按这个厚度补，不然走一步露一块裸地
  U.meanDepth.value = interaction.state.estY;
  U.snowProgress.value = Math.min(1, interaction.state.estY / Math.max(params.depth, 1e-4));

  // --- 积雪场演化（粗层先算：细层的光照要读粗层的太阳可见度）---
  refreshSnow(renderer);
  // 手：射线 → 手掌位置 → 变形 / 扬雪（内部按需 dispatch，只作用于 L0）
  interaction.update(dt);
  // 把 L0 这一帧的形变存进留存图，L1/L2 的 accumulate 紧接着就要读它
  stashSnow(renderer);
  stepSnow(renderer);
  // 雪面定形之后再做光线步进（自阴影 + 天空遮蔽）
  lightSnow(renderer);

  // 道具的 LOD / 距离剔除（内部分四帧轮流更新）
  for (let i = 0; i < props.length; i++) props[i].update(camera);

  // 空中的雪
  renderer.compute(computeFlakeUpdate);
  renderer.compute(computeSprayUpdate);

  // 快门期间把光标环、模具预览、笔刷球按掉（见 takeShot 那段注释）
  const shooting = shotFrames > 0;
  const keepHand = U.handActive.value;
  const keepMold = U.moldActive.value;
  const brushBall = interaction.sculpts.brushBall;   // 手在雪雕上时的笔刷球
  const keepBrush = brushBall.visible;
  if (shooting) { U.handActive.value = 0; U.moldActive.value = 0; brushBall.visible = false; }

  maybeBakeEnv();
  postfx.render();

  if (shooting) {
    U.handActive.value = keepHand;
    U.moldActive.value = keepMold;
    brushBall.visible = keepBrush;
    shotFrames -= 1;
    if (shotFrames === 0) saveFrame();
  }

  // FPS + GPU 计时
  fpsAcc += dt; fpsCnt++;
  if (fpsAcc > 0.5) {
    const fps = Math.round(fpsCnt / fpsAcc);
    propCount = props.reduce((a, p) => a + p.stats.instances, 0);
    const r = renderer.info.render.timestamp || 0;
    const c = renderer.info.compute.timestamp || 0;
    statsEl.textContent = `${fps} fps · gpu ${(r + c).toFixed(2)}ms (render ${r.toFixed(2)} / compute ${c.toFixed(2)}) · `
      + `${Math.round(U.activeFlakes.value / 1000)}k ${t('st.flakes')} · `
      + `${LEVELS}×${GRID}² ${t('st.grid')} → ${Math.round(spanOf(LEVELS - 1))}m · `
      + `${propCount} ${t('st.props')}`;
    fpsAcc = 0; fpsCnt = 0;
    renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).catch(() => {});
    renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE).catch(() => {});
  }
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

// ---------------------------------------------------------------- 设备丢失

function watchDeviceLoss() {
  const dev = renderer.backend?.device;
  if (!dev?.lost) return;
  dev.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    fail(t('boot.lost', info.message || info.reason));
  });
}

// ---------------------------------------------------------------- 启动 / 报错

function fail(msg) {
  const boot = document.getElementById('boot');
  boot.classList.remove('done');
  boot.classList.add('failed');
  document.getElementById('booterr').innerHTML = msg;
}

init().then(() => {
  camera.position.copy(CAM_LAND);
  controls.target.copy(CAM_LAND_TARGET);
  controls.update();
  initLanding(controls, { onEnter: flyHome });
  requestAnimationFrame(() => {
    setTimeout(() => document.getElementById('boot').classList.add('done'), 260);
  });
}).catch((err) => {
  console.error(err);
  if (String(err.message).includes('NO_WEBGPU')) {
    fail(t('boot.nogpu'));
  } else {
    fail(t('boot.failed') + (err.message || err));
  }
});
