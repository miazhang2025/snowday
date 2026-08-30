/**
 * config.js — 全局常量、可调参数、以及所有 GPU uniform。
 *
 * 设计约定：
 *   params  : 纯 JS 对象，UI 直接读写（滑杆 / 按钮）。
 *   U       : TSL uniform 节点，着色器读取。
 *   refresh(): 把 params 推导成 uniform 值（含风向、太阳方位、天光配色等派生量）。
 */

import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

// ---------------------------------------------------------------- 场地尺度
//
// 积雪不再是「一张固定的 26m 网格」，而是一组跟着相机走的 clipmap：
// 每一级都是 GRID x GRID，格子大小逐级 x LOD，于是分辨率随距离自然衰减。
//
//   L0   5.8cm / 格   26.0 m   ← 可交互的那一层
//   L1  23.2cm / 格  104.0 m
//   L2  92.9cm / 格  415.9 m
//
// 三级共用一个对齐步长 SNAP（= 最粗那级的格子），所以各级的格线永远互相对齐，
// 外层挖的洞正好等于内层的覆盖范围，接缝上不会出现错位或缝隙。

export const GRID = 448;                 // 每级 clipmap 的分辨率
export const CELLS = GRID * GRID;
export const LEVELS = 3;                 // clipmap 层数
export const LOD = 4;                    // 每级放大倍数

export const CELL0 = 26 / GRID;          // L0 的格子尺寸（米）≈ 0.0580
export const CELL = CELL0;               // 兼容旧名字
export const GROUND = GRID * CELL0;      // L0 边长 = 26 m
export const HALF = GROUND / 2;
export const SNAP = CELL0 * LOD ** (LEVELS - 1);   // 所有层共用的窗口对齐步长
export const FAR_SPAN = 1300;            // 最外圈裙边的半宽（米）

/** 第 k 级的格子尺寸 / 覆盖边长 */
export const cellOf = (k) => CELL0 * LOD ** k;
export const spanOf = (k) => (GRID - 1) * cellOf(k);

// 外层挖洞的范围（以本级的顶点下标计）。内层覆盖 [168, 279.75]，
// 所以去掉 168..278 这 111 个四边形，留 0.75 格的重叠 —— 宁可叠一点也不能有缝。
export const HOLE_LO = (GRID / 2) * (1 - 1 / LOD);
export const HOLE_HI = HOLE_LO + GRID / LOD - 1;

export const FLAKES = 90000;             // 空中雪花上限
export const SPRAY = 12288;              // 被手扬起的粉雪上限
export const SPRAY_BATCH = 160;          // 每帧最多发射多少粉雪
export const SKY_TOP = 15;               // 雪花出生高度（相对当前地面）
export const FIELD_R = GROUND * 0.62;    // 降雪覆盖半径（跟着相机走）

// 手势
export const HAND = { PUSH: 0, SMOOTH: 1, PILE: 2, PRINT: 3, MOLD: 4 };

// 高度场的天花板（米）。原来是「目标雪深 x 3.5」，也就是二十几厘米 ——
// 那是给手堆的小雪堆定的，模具一上来就顶穿了：computeDeform 是**逐格无条件**
// 写回的，钳制会作用于整个 L0，于是随便推一下雪，场上所有城堡就被齐刷刷
// 削平到那个高度。所以钳制取「雪深推出来的值」和这个常数里更大的那个。
// 5m 是「最高的模具（塔楼 2.58）开到最大尺度 1.8」再留一点余量。
export const BUILD_CEIL = 5.0;

// ---------------------------------------------------------------- 可调参数

export const params = {
  // 降雪
  intensity: 0.41,      // 降雪强度 0..1
  flakeSize: 0.63,      // 雪花大小
  windSpeed: 1.65,       // 风力 m/s
  windDir: 210,         // 风向（度）
  turbulence: 1.5,     // 湍流 / 飘舞
  falling: true,        // 是否下雪

  // 积雪
  depth: 0.20,          // 目标积雪厚度（米）
  deposit: 0.6,        // 堆积速度
  softness: 0.5,        // 松软度（影响休止角与自平整）
  cover: 0.69,          // 新雪掩盖旧痕迹的速度
  drift: 0.45,           // 雪面起伏 / 风吹雪堆
  crust: 0.55,          // 风壳：表层被风吹硬的程度
  strata: 0.6,          // 切面上的层理强度
  crumble: 0.4,         // 陡边的破碎程度
  sss: 0.8,             // 次表面散射强度
  sssDepth: 2.2,        // 光在雪里的有效光程（米）—— 越长越蓝

  // 手
  handSize: 0.5,        // 手掌半径（米）
  press: 0.23,          // 按压力度
  pile: 0.6,            // 推雪堆积量
  spray: 0.3,           // 扬起的粉雪量
  mode: HAND.PUSH,      // 当前手势

  // 模具
  mold: 0,              // 当前模具（molds.js 里 MOLDS 的下标）
  moldSize: 0.55,       // 模具尺度（米，约等于底面半径）
  moldRot: 0,           // 在「背对镜头」之外再转多少度
  moldFirm: 0.85,       // 压得多实 —— 越实越挺得住，0 则和松雪一样会塌

  // 环境
  timeOfDay: 0.76,      // 0..1（午后斜阳，影子最长）
  overcast: 0.28,       // 阴天程度
  fog: 0.0045,          // 霾浓度：绿光每米的消光系数
  hazeHeight: 140,      // 霾的标高（米）—— 越小，山谷越浑、山脊越清
  bloom: 0.5,           // 辉光
  vignette: 0.40,       // 镜头暗角
  lensBlur: 1,       // 四角虚化
  envLight: 0.40,       // 环境贴图的间接光强度
  hdriMix: 0.73,         // 环境贴图里 HDRI 占比（0 = 纯程序化天空）
  hdriTint: 0.60,       // 让 HDRI 跟着「时间/阴天」的配色走
  hdriRot: 0,           // HDRI 绕 Y 轴旋转（度）
  hdriFollowSun: true,  // 自动把 HDRI 最亮处对到太阳方位
  sparkle: 1,         // 雪面闪烁的亮度
  crystals: 1,       // 表层冰晶的密度
  quality: 1,           // 0 低 / 1 中 / 2 高

  // 后期
  taa: true,            // 时域抗锯齿
  ssao: true,           // 屏幕空间接触遮蔽
  rays: true,           // 体积光轴
};

export const defaults = { ...params };

// ---------------------------------------------------------------- Uniforms

export const U = {
  // 时间
  dt:            uniform(0),
  elapsed:       uniform(0),
  seed:          uniform(0),

  // 积雪场
  depositRate:   uniform(0),
  targetDepth:   uniform(0),
  driftAmount:   uniform(0),
  freshCover:    uniform(0),
  slumpRate:     uniform(0),
  reposeSlope:   uniform(0),
  smoothRate:    uniform(0),
  crustRate:     uniform(0),   // 结壳速度
  strata:        uniform(0),   // 层理强度
  crumble:       uniform(0),   // 陡边破碎幅度
  // 次表面散射
  sssAmount:     uniform(0),   // 漫出来的量
  sssWrap:       uniform(0),   // 各向同性的绕射项（软化明暗交界）
  sssPath:       uniform(0),   // 有效光程（米）
  sssTint:       uniform(0),   // 反照率被冰吸收染蓝的程度
  sssCavity:     uniform(1.2), // 凹陷处的光程加成
  fillValue:     uniform(0),   // 「清空 / 铺满」用
  meanDepth:     uniform(0),   // CPU 估算的平均雪深
  // clipmap 滑出去的格子要用「当前的平衡雪深」补，不能补 0，否则往前走会露出裸地。
  // snowProgress 就是「雪下到几成了」，0 = 刚开始下，1 = 已经堆到目标厚度。
  snowProgress:  uniform(0),
  crustSeed:     uniform(0),   // 新补进来的格子初始风壳
  fieldCenter:   uniform(new THREE.Vector3()),  // 降雪 / clipmap 窗口中心

  // 手
  handCur:       uniform(new THREE.Vector3()),
  handPrev:      uniform(new THREE.Vector3()),
  handAxis:      uniform(new THREE.Vector2(0, 1)),
  handRadius:    uniform(0.9),
  handPress:     uniform(0),
  handPile:      uniform(0),
  handStrength:  uniform(0),   // 这一帧实际作用强度（含 dt）
  handActive:    uniform(0),   // 是否显示光标环
  handMode:      uniform(0),

  // 模具
  moldPos:       uniform(new THREE.Vector3()),      // 世界坐标的落点
  moldAxis:      uniform(new THREE.Vector2(0, 1)),  // 朝向（单位向量，xz）
  moldBase:      uniform(0),                        // 模具 y=0 那一面的绝对高度
  moldScale:     uniform(0.55),                     // 归一化单位 -> 米
  moldType:      uniform(0),
  moldActive:    uniform(0),                        // 是否画预览轮廓
  // 压实的雪能挺住多陡的坡。松雪的休止角只有三十几度，塔一堆好就塌了；
  // 手压过的雪能立成墙，这是模具扣出来的东西能站住的**唯一**原因，所以直接乘在休止角上。
  packRepose:    uniform(16),
  buildCeil:     uniform(BUILD_CEIL),

  // 雪花
  wind:          uniform(new THREE.Vector3()),
  fallSpeed:     uniform(1.1),
  flutter:       uniform(0.5),
  flakeScale:    uniform(0.02),
  activeFlakes:  uniform(FLAKES),

  // 粉雪
  emitOffset:    uniform(0),
  emitPower:     uniform(0),
  emitDir:       uniform(new THREE.Vector3()),

  // 环境
  sunDir:        uniform(new THREE.Vector3(0.4, 0.6, 0.5)),
  groundRadiance:uniform(new THREE.Vector3(0.5, 0.52, 0.56)),  // 雪地反弹，烘进环境贴图
  hdriMix:       uniform(0),                          // 0 程序化天空 -> 1 HDRI
  hdriTintCol:   uniform(new THREE.Vector3(1, 1, 1)), // 把 HDRI 调向当前天光配色
  hdriRot:       uniform(0),                          // 弧度
  sunColor:      uniform(new THREE.Color(0xfff3e2)),
  sunPower:      uniform(2.4),
  skyTop:        uniform(new THREE.Color(0x4e86c6)),
  skyHorizon:    uniform(new THREE.Color(0xcfe0ef)),
  fogColor:      uniform(new THREE.Color(0xc6d6e6)),
  // 大气透视：hazeSigma 是绿光在参考高度上每米的消光，hazeHeight 是气溶胶标高
  hazeSigma:     uniform(0.0032),
  hazeHeight:    uniform(140),
  ambient:       uniform(0.9),
  // 调试通道：0 关；1 太阳可见度 2 天空遮蔽 3 雪深 4 法线 5 层号 6 纯 Lambert。
  // 远景那片菱形斜纹就是靠 6 号（对法线最敏感）定位到地形插值上的，留着。
  debugMode:     uniform(0),
  microRelief:   uniform(1),   // 风纹/雪粒法线的总强度（调试与降噪用）
  sparkle:       uniform(0.7),
  crystals:      uniform(0.65),  // 表层冰晶密度
  snowCoat:      uniform(0.6),  // 物体表面的积雪覆盖度
};

// ---------------------------------------------------------------- 一天中的光

export const DAY_START = 4;    // 滑杆 0 → 04:00
export const DAY_END = 28;     // 滑杆 1 → 次日 04:00

// 关键帧：t, 太阳仰角, 方位角, 阳光色, 强度, 天顶色, 地平色, 雾色, 环境光
const SKY_KEYS = [
  { t: 0.00, el:  -4, az:  95, sun: 0x46557a, i: 0.22, top: 0x131b2c, hor: 0x27324a, fog: 0x1e2739, amb: 0.30 },
  { t: 0.10, el:   1, az:  98, sun: 0x8c7fa8, i: 0.45, top: 0x1e2a45, hor: 0x50597b, fog: 0x38425a, amb: 0.38 },
  { t: 0.18, el:   7, az: 104, sun: 0xffb27a, i: 1.30, top: 0x2f4d78, hor: 0xf0a878, fog: 0x74869f, amb: 0.52 },
  { t: 0.38, el:  33, az: 134, sun: 0xffe9cf, i: 2.45, top: 0x5b8ec9, hor: 0xc3d7ea, fog: 0xb9cbdd, amb: 0.85 },
  { t: 0.55, el:  50, az: 180, sun: 0xfffaf2, i: 2.95, top: 0x4a82c4, hor: 0xd2e2f0, fog: 0xc6d6e6, amb: 0.98 },
  { t: 0.72, el:  20, az: 224, sun: 0xffd2a0, i: 2.00, top: 0x4374b4, hor: 0xe3c9c0, fog: 0xb3bcc9, amb: 0.72 },
  { t: 0.82, el:   6, az: 248, sun: 0xff9d5c, i: 1.25, top: 0x2b477a, hor: 0xf29f68, fog: 0x8a8ea4, amb: 0.50 },
  { t: 0.92, el:   0, az: 262, sun: 0x6f86b8, i: 0.48, top: 0x1b2a47, hor: 0x41527a, fog: 0x39445d, amb: 0.36 },
  { t: 1.00, el:  -4, az:  95, sun: 0x46557a, i: 0.22, top: 0x131b2c, hor: 0x27324a, fog: 0x1e2739, amb: 0.30 },
];

const _cA = new THREE.Color(), _cB = new THREE.Color(), _gray = new THREE.Color();

function lerpKeys(t) {
  t = THREE.MathUtils.clamp(t, 0, 1);
  let i = 0;
  while (i < SKY_KEYS.length - 2 && SKY_KEYS[i + 1].t < t) i++;
  const a = SKY_KEYS[i], b = SKY_KEYS[i + 1];
  const k = THREE.MathUtils.smoothstep(t, a.t, b.t);
  const mixC = (ka, kb, out) => out.setHex(ka, THREE.SRGBColorSpace)
    .lerp(_cB.setHex(kb, THREE.SRGBColorSpace), k);
  return {
    el: THREE.MathUtils.lerp(a.el, b.el, k),
    az: THREE.MathUtils.lerp(a.az, b.az, k),
    i: THREE.MathUtils.lerp(a.i, b.i, k),
    amb: THREE.MathUtils.lerp(a.amb, b.amb, k),
    sun: mixC(a.sun, b.sun, _cA).clone(),
    top: mixC(a.top, b.top, _cA).clone(),
    hor: mixC(a.hor, b.hor, _cA).clone(),
    fog: mixC(a.fog, b.fog, _cA).clone(),
  };
}

/** 由 params 推导出所有 uniform 值。UI 每次改动后调用。 */
// 环境贴图只在天光真的变了才重烘
let _envSig = '';
let _envDirty = true;
export const isEnvDirty = () => _envDirty;
export const clearEnvDirty = () => { _envDirty = false; };

export function refresh() {
  const p = params;

  // --- 降雪 -------------------------------------------------------
  const intensity = p.falling ? p.intensity : 0;
  U.activeFlakes.value = Math.round(FLAKES * (0.05 + 0.95 * intensity) * (p.quality === 0 ? 0.4 : p.quality === 1 ? 0.75 : 1));
  U.flakeScale.value = 0.008 + p.flakeSize * 0.030;
  U.fallSpeed.value = 0.55 + p.flakeSize * 0.9 + p.windSpeed * 0.12;
  U.flutter.value = p.turbulence;

  const rad = THREE.MathUtils.degToRad(p.windDir);
  U.wind.value.set(Math.sin(rad) * p.windSpeed, 0, -Math.cos(rad) * p.windSpeed);

  // --- 积雪 -------------------------------------------------------
  U.targetDepth.value = p.depth;
  U.depositRate.value = intensity * p.deposit * 0.055;   // 米/秒
  U.driftAmount.value = p.drift;
  U.freshCover.value = p.cover * 26.0;
  // 松软度：越松软 → 休止角越小（更容易塌）、自平整越快
  U.reposeSlope.value = THREE.MathUtils.lerp(1.35, 0.42, p.softness);
  U.slumpRate.value = THREE.MathUtils.lerp(3.0, 14.0, p.softness);
  U.smoothRate.value = THREE.MathUtils.lerp(0.12, 0.95, p.softness);
  // 风越大，表层结壳越快
  U.crustRate.value = p.crust * (0.015 + p.windSpeed * 0.035);
  U.crustSeed.value = p.crust * 0.55;
  U.strata.value = p.strata;
  U.crumble.value = p.crumble * 0.024;      // 米
  U.sssAmount.value = p.sss * 0.18;
  U.sssWrap.value = p.sss * 0.38;
  U.sssPath.value = p.sssDepth;
  U.sssTint.value = THREE.MathUtils.clamp(p.sssDepth * 0.06, 0, 0.45) * p.sss;

  // --- 手 ---------------------------------------------------------
  U.handRadius.value = p.handSize;
  U.handPress.value = p.press * 0.55;
  U.handPile.value = p.pile;
  U.handMode.value = p.mode;

  // --- 模具 -------------------------------------------------------
  U.moldScale.value = p.moldSize;
  U.moldType.value = p.mold;
  U.packRepose.value = 1.5 + p.moldFirm * 20.0;

  // --- 环境 -------------------------------------------------------
  const s = lerpKeys(p.timeOfDay);
  const oc = p.overcast;

  const el = THREE.MathUtils.degToRad(s.el);
  const az = THREE.MathUtils.degToRad(s.az);
  U.sunDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();

  // 阴天：阳光被削弱并去饱和，天光整体压平成灰蓝
  _gray.setRGB(0.62, 0.66, 0.72);
  U.sunColor.value.copy(s.sun).lerp(_gray, oc * 0.75);
  U.sunPower.value = s.i * (1 - 0.82 * oc);
  U.ambient.value = s.amb * (1 + 0.55 * oc);

  _gray.setRGB(0.40, 0.45, 0.52);
  U.skyTop.value.copy(s.top).lerp(_gray, oc * 0.72);
  _gray.setRGB(0.60, 0.65, 0.71);
  U.skyHorizon.value.copy(s.hor).lerp(_gray, oc * 0.80);
  U.fogColor.value.copy(s.fog).lerp(_gray, oc * 0.70);

  U.hazeSigma.value = p.fog;
  U.hazeHeight.value = p.hazeHeight;

  U.sparkle.value = p.sparkle * (1 - 0.55 * oc);
  // 阴天没有强方向光，片晶也就闪不起来
  U.crystals.value = p.crystals * (1 - 0.45 * oc);
  U.snowCoat.value = THREE.MathUtils.clamp(p.depth / 0.28, 0, 1) * 0.50 + 0.30;

  U.hdriMix.value = p.hdriMix;

  const sig = `${p.timeOfDay.toFixed(4)}|${oc.toFixed(3)}|${p.hdriMix.toFixed(3)}`
    + `|${p.hdriTint.toFixed(3)}|${p.hdriRot.toFixed(1)}|${p.hdriFollowSun}`;
  if (sig !== _envSig) { _envSig = sig; _envDirty = true; }
}
