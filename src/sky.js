/**
 * sky.js — 天空穹顶、全局光照、灯光
 *
 * 天空是一个反面渲染的大球，颜色由 TSL 程序化生成：
 * 天顶↔地平线渐变 + 太阳/月亮辉光 + 低频云翳 + 夜里的星星。
 * 配色来自 config.js 的关键帧插值，「时间」滑杆一动整片天光都会跟着变。
 *
 * 同一个天空着色器还会被烘成一张 PMREM 环境贴图喂给 scene.environment ——
 * 这是间接光的来源。雪的反照率高达 0.9，反照率越高、光在表面之间弹得越多，
 * 用半球光近似的误差就越大（凹陷处可以差到两倍），所以这一步对雪特别值。
 * 穹顶地平线以下烘的是「被天光照亮的雪原」，环境贴图里因此带着地面反弹的光。
 */

import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, mix, smoothstep, positionLocal, texture, equirectUV,
  mx_fractal_noise_float,
  positionWorld, cameraPosition,
  output, luminance, vec4,
} from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

import { U, params } from './config.js';

const SKY_R = 320;

/** 天空颜色，视线方向 -> 线性辐亮度。可见穹顶和烘焙穹顶共用 */
function skyColor(dir) {
  const up = dir.y.clamp(-1, 1);

  // 天顶 → 地平线
  const grad = smoothstep(-0.02, 0.55, up).pow(0.75);
  let c = mix(U.skyHorizon, U.skyTop, grad);

  // 贴近地平线的天空化进雾色，否则远景雪原（已被雾吃满）会和天空拼出一条硬边
  c = mix(c, U.fogColor, float(1).sub(smoothstep(0.0, 0.055, up)));

  // 太阳 / 月亮：核心 + 大范围散射晕
  const cosA = dir.dot(U.sunDir).clamp(-1, 1);
  const halo = cosA.max(0).pow(9.0).mul(0.42).add(cosA.max(0).pow(220.0).mul(2.2));
  c = c.add(U.sunColor.mul(halo).mul(U.sunPower.mul(0.34).add(0.12)));

  // 云翳：靠近地平线时噪声被拉长，看起来像层积云
  const q = vec3(dir.x, dir.y.mul(2.6), dir.z).mul(2.1);
  const n = mx_fractal_noise_float(q, 4, 2.15, 0.55, 1.0).mul(0.5).add(0.5);
  const cloud = smoothstep(0.42, 0.86, n).mul(smoothstep(0.0, 0.30, up)).mul(0.30);
  c = mix(c, U.fogColor.mul(1.05), cloud);

  // 夜里加一点星星（阳光很弱的时候才显现）
  const star = smoothstep(0.9955, 0.9995,
    mx_fractal_noise_float(dir.mul(220), 1, 2, 0.5, 1).mul(0.5).add(0.5));
  const night = float(1).sub(smoothstep(0.25, 0.9, U.sunPower));
  c = c.add(vec3(0.75, 0.82, 1.0).mul(star).mul(night).mul(smoothstep(0.02, 0.3, up)).mul(0.9));

  return c;
}

/**
 * 大气透视（aerial perspective）。
 *
 * 这是让大场景「变大」最值钱的一项。之前只有一个常数色的 FogExp2，
 * 于是 20m 外的雪和 300m 外的山是同一个值，画面直接塌成一张白纸。
 *
 * 关于实现方式，这里推翻了我自己一开始的方案。UE 那套 aerial perspective
 * 要烘一张 3D LUT，是因为相机会飞到几公里高、大气密度沿高度差好几个数量级。
 * 而这个场景的相机一直贴着地面、视距 0–1300m —— 在这个范围里散射积分**有闭式解**，
 * 烘 LUT 反而更差（多占显存、还要吃三线性插值的误差）。所以直接解析求值。
 *
 * 三件事凑成它：
 *
 *  1. **沿视线的空气柱**。密度按高度指数衰减，光学厚度不是 σ·d 而是
 *       ∫₀^d exp(-(y₀+t·ωy)/H) dt = H/ωy · (exp(-y₀/H) - exp(-y₁/H))
 *     这一项让山谷底浓、山脊顶清 —— 冬天山里最典型的样子。
 *
 *  2. **相函数**。瑞利 (1+cos²θ)，米氏用 g=0.76 的 Henyey-Greenstein。
 *     米氏强烈前向散射，所以顺着太阳看过去霾会发亮发白，背着看则冷而暗。
 *     这是「有空气」和「蒙了层灰」的区别。
 *
 *  3. **分通道消光**。瑞利按 λ⁻⁴ 分蓝绿红，远处暗的东西会偏蓝。
 *
 * 但**整体的明度和色调仍然由关键帧的 fogColor 决定** —— 相函数被归一化到
 * 「与太阳成 90° 时为 1」，只负责角度上的起伏。天空还是原来那套天空，
 * 这是当初说好要保住的。
 */

// 气溶胶的标高：霾贴着地面。这个值直接决定「山谷有多浑、山顶有多清」。
const RAY_FRAC = 0.26;                      // 消光里瑞利占的比例，其余算米氏
const RAY_RATIO = [0.428, 1.0, 2.441];      // β∝λ⁻⁴，对绿光归一

// 米氏相函数。纯单次散射的 HG 在 g=0.76 时，正对太阳的峰值是 90° 的 **143 倍** ——
// 物理上没错，但真实的霾里光散射了很多次，那个尖峰早被抹平了。第一版照搬 143 倍
// 的结果是顺光方向 150m 外全糊成一片纯白。所以降低 g，再和各向同性混一混
// （各向同性那一半正好就代表多次散射），峰值降到 ~10 倍。
const MIE_G = 0.62;
const MIE_MS = 0.45;                        // 各向同性（多次散射）占比
const ISO = 1 / (4 * Math.PI);
const HG90 = (1 - MIE_G * MIE_G) / (4 * Math.PI * Math.pow(1 + MIE_G * MIE_G, 1.5));
const P_R90 = 3 / (16 * Math.PI);
const P_M90 = (1 - MIE_MS) * HG90 + MIE_MS * ISO;
const BOOST_MAX = 7.0;                      // 再加一道保险，别让峰值把画面顶穿

export function createFog(scene, params) {
  // scene.fog 这个对象留着：syncLights 会写它的颜色，别的地方也可能读。
  // 真正生效的是下面的 fogNode（three 里 scene.fogNode 优先级更高）。
  scene.fog = new THREE.FogExp2(0xc6d6e6, params.fog);

  scene.fogNode = Fn(() => {
    const V = positionWorld.sub(cameraPosition);
    const dist = V.length().max(1e-4);
    const dir = V.div(dist);

    // ---- 1. 空气柱 ----
    const e0 = cameraPosition.y.div(U.hazeHeight).negate().exp();
    const e1 = positionWorld.y.div(U.hazeHeight).negate().exp();
    const wy = dir.y;
    const flat = dist.mul(e0);                                   // 水平视线的退化形式
    const slant = e0.sub(e1).mul(U.hazeHeight).div(wy.sign().mul(wy.abs().max(1e-4)));
    // ωy→0 时上式是 0/0，虽然极限正好等于 flat，但数值上会炸。
    // 所以两边都算，按 |ωy| 平滑地选 —— 交界处两式的差远小于一个色阶。
    const air = mix(slant, flat, float(1).sub(smoothstep(0.0, 0.02, wy.abs()))).max(0);

    // ---- 2. 消光 ----
    const sM = U.hazeSigma.mul(1 - RAY_FRAC);
    const sR = vec3(...RAY_RATIO).mul(U.hazeSigma.mul(RAY_FRAC));
    const sT = sR.add(sM);
    const T = sT.mul(air).negate().exp();

    // ---- 3. 相函数 ----
    const ct = dir.dot(U.sunDir);
    const pR = ct.mul(ct).add(1.0).mul(P_R90);
    const dn = float(1 + MIE_G * MIE_G).sub(ct.mul(2 * MIE_G)).max(1e-4);
    const hg = float((1 - MIE_G * MIE_G) / (4 * Math.PI)).div(dn.mul(dn.sqrt()));
    const pM = hg.mul(1 - MIE_MS).add(ISO * MIE_MS);

    // 归一化到 90°：关键帧的 fogColor 继续决定明度和色调，
    // 相函数只在它周围做角度上的起伏
    const shape = sR.mul(pR).add(sM.mul(pM)).div(sT);
    const ref = luminance(sR.mul(P_R90).add(sM.mul(P_M90)).div(sT)).max(1e-5);
    const inscat = U.fogColor.mul(shape.div(ref).min(BOOST_MAX));

    return vec4(output.rgb.mul(T).add(inscat.mul(vec3(1).sub(T))), output.a);
  })();
}

export function createSky(scene) {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.side = THREE.BackSide;
  mat.fog = false;
  mat.depthWrite = false;
  mat.colorNode = Fn(() => skyColor(positionLocal.normalize()))();

  const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 48, 32), mat);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  scene.add(dome);
  return dome;
}

// ---------------------------------------------------------------- 环境光（IBL）

/**
 * 烘焙用的小球：和可见天空同一个着色器，只是地平线以下换成雪地的反弹，
 * 并且不做色调映射（环境贴图必须是线性 HDR）。
 */
export function createEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  let rt = null;

  // --- 程序化天空的烘焙球（默认源）---
  const skyMat = new THREE.MeshBasicNodeMaterial();
  skyMat.side = THREE.BackSide;
  skyMat.fog = false;
  skyMat.toneMapped = false;
  skyMat.colorNode = Fn(() => bakeColor(null))();

  const skyScene = new THREE.Scene();
  skyScene.add(makeDome(skyMat));

  // --- HDRI 的烘焙球（加载成功后才建）---
  let hdriScene = null;
  let hdri = null;          // { texture, avg:[r,g,b], sunAz }

  return {
    get hasHDRI() { return hdri !== null; },
    get info() { return hdri; },

    /**
     * 载入等距柱状 HDRI（.exr / .hdr）。
     * 载入后会扫一遍像素找最亮的方位角，用来把 HDRI 的太阳对到我们的平行光上 ——
     * 不对齐的话 HDRI 的高光方向和场景阴影方向会打架，是用 HDRI 最常见的穿帮。
     */
    async load(url) {
      const isEXR = /\.exr(\?|$)/i.test(url);
      const loaderObj = isEXR ? new EXRLoader() : new RGBELoader();
      const tex = await loaderObj.loadAsync(url);
      tex.mapping = THREE.EquirectangularReflectionMapping;

      hdri = { texture: tex, ...analyse(tex) };

      const mat = new THREE.MeshBasicNodeMaterial();
      mat.side = THREE.BackSide;
      mat.fog = false;
      mat.toneMapped = false;
      mat.colorNode = Fn(() => bakeColor(tex))();

      hdriScene = new THREE.Scene();
      hdriScene.add(makeDome(mat));
      return hdri;
    },

    /** 重烘环境贴图。只在天光/HDRI 参数变了才调用，每帧成本为零 */
    update(scene) {
      const src = (hdriScene && params.hdriMix > 0.001) ? hdriScene : skyScene;
      rt = pmrem.fromScene(src, 0, 0.1, 100, { size: 256, renderTarget: rt });
      scene.environment = rt.texture;
      scene.environmentIntensity = params.envLight;
    },

    dispose() { rt?.dispose(); pmrem.dispose(); hdri?.texture?.dispose(); },
  };
}

function makeDome(mat) {
  const d = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 32), mat);
  d.frustumCulled = false;
  return d;
}

/**
 * 烘焙用的颜色：程序化天空 ↔ HDRI 按 hdriMix 混合。
 * HDRI 会被 hdriTintCol 调向当前的天光配色，所以「时间 / 阴天」这些参数
 * 对 HDRI 一样有效 —— 这是为了满足「用 HDRI 但保留现有天空参数」。
 */
function bakeColor(hdriTex) {
  const dir = positionLocal.normalize();

  let c = skyColor(dir);

  if (hdriTex) {
    // 绕 Y 轴旋转采样方向
    const ca = U.hdriRot.cos();
    const sa = U.hdriRot.sin();
    const rd = vec3(
      dir.x.mul(ca).add(dir.z.mul(sa)),
      dir.y,
      dir.z.mul(ca).sub(dir.x.mul(sa)),
    );
    const h = texture(hdriTex, equirectUV(rd)).rgb.mul(U.hdriTintCol);
    c = mix(c, h, U.hdriMix);
  }

  // 地平线以下混一点「被天光照亮的雪原」：HDRI 自带的地面未必是雪，
  // 而场景里脚下确实是雪，这一项保证反弹上来的光是对的
  const below = float(1).sub(smoothstep(-0.06, 0.005, dir.y));
  return mix(c, U.groundRadiance, below.mul(0.75)).max(0);
}

/** 扫一遍 HDRI：平均色（用来做色调匹配）+ 最亮方位角（用来对齐太阳） */
function analyse(tex) {
  const img = tex.image;
  const data = img?.data;
  const w = img?.width | 0;
  const h = img?.height | 0;
  const avg = [0.18, 0.20, 0.24];
  if (!data || !w || !h) return { avg, sunAz: 0 };

  const half = tex.type === THREE.HalfFloatType;
  const get = half
    ? (i) => THREE.DataUtils.fromHalfFloat(data[i])
    : (i) => data[i];

  const step = Math.max(1, Math.floor(w / 512));   // 抽样，别真的扫四千万像素
  let sr = 0, sg = 0, sb = 0, n = 0;
  let best = -1, bestX = 0;

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = get(i), g = get(i + 1), b = get(i + 2);
      if (!Number.isFinite(r)) continue;
      sr += r; sg += g; sb += b; n++;
      // 只在地平线以上找太阳
      if (y < h * 0.5) {
        const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
        if (lum > best) { best = lum; bestX = x; }
      }
    }
  }
  if (n > 0) { avg[0] = sr / n; avg[1] = sg / n; avg[2] = sb / n; }

  // 等距柱状图：u=0 对应 -Z，向 +X 方向增大
  const u = bestX / w;
  const sunAz = (u * Math.PI * 2) - Math.PI;
  return { avg, sunAz };
}

// ---------------------------------------------------------------- 灯光

// 级联阴影。
//
// 一张图是没法同时满足两头的：近处要 2cm 的纹素才能看清树根的接触暗部，
// 远处要覆盖两三百米才能让整片林子有影子。之前扩到 ±110m / 4096² 是权宜之计，
// 结果是近处比原来还糙（5.4cm），110m 外照样什么都没有。
//
// CSM 把**相机视锥**按深度切成几段，每段单独拟合一张图，于是密度随距离自然下降。
// three 的 CSMShadowNode 能直接挂在节点管线上，而且逐级做了纹素吸附
// （相机一动阴影边缘不会沿着格子爬）和 bias 递增（远处的纹素大，需要更大的偏移）。
//
// 分段是自定的：默认的 practical 会把第一级切在 57m，那太远了 —— 近处的密度
// 还是提不上来。这里第一级只管 21m，把纹素压到 2cm 出头。
const SHADOW_MAP = 2048;               // 每一级的分辨率（4 级共 4×2048²，和之前一张 4096² 同量级）
const CASCADES = 4;
const SHADOW_FAR = 260;                // 再远的影子被霾吃掉了，不值得再切一级
const SPLITS = [0.08, 0.22, 0.48, 1];  // → 21 / 57 / 125 / 260 m
const SUN_DIST = 300;

export function createLights(scene, camera, renderer) {
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.castShadow = true;
  // 这个 shadow 是**模板**：CSM 会 clone 它给每一级，正交视锥的范围由 CSM 自己拟合
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 800;
  // bias 一律 0，深度偏置完全不用。
  //
  // 这一条踩了很久才想明白：shadow.bias 是加在**归一化深度**上的，而正交阴影
  // 相机的世界偏移 = bias × (far - near)。CSM 只设 left/right/top/bottom，
  // near/far 是从这个模板继承的 —— 原来 far=1400，于是
  //     第 0 级 −0.0006 × 1399 = −0.84 m
  //     第 3 级 −0.0024 × 1399 = −3.36 m   （CSM 还会按 bias × (级号+1) 放大）
  // 影子被整体推离物体好几米，全场都是「影子和脚不connected」的 peter-panning。
  //
  // 正确的做法是只用 normalBias：它的单位是**世界米**，跟深度范围无关，
  // 也跟级号无关，各级按自己的纹素大小给就行（见下面 CASCADE_NB）。
  sun.shadow.bias = 0;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  const csm = new CSMShadowNode(sun, {
    cascades: CASCADES,
    maxFar: SHADOW_FAR,
    mode: 'custom',
    customSplitsCallback: (n, near, far, target) => { for (const f of SPLITS) target.push(f); },
    lightMargin: 150,                  // 光源往后退这么多，别把高处的山头切掉
  });
  csm.fade = true;                     // 级与级之间交叉淡入，不然接缝是一条硬线
  sun.shadow.shadowNode = csm;
  sun.userData.csm = csm;

  // 手动把级联建出来，而不是等第一次材质编译时 setup() 顺带触发。
  // 这样各级的灯和 shadow 对象在返回之前就存在了，下面 bindGodrayShadow 才有东西可指。
  // _init 里第一件事就是 this.camera = camera，所以之后 setup() 不会重复初始化。
  csm._init({ camera, renderer });
  // 逐级的法线偏置按各自的纹素大小给：纹素越大，越需要沿法线推开才不长痘。
  // bias 保持 0（理由见上），CSM 的 bias × (级号+1) 因此也一直是 0。
  const CASCADE_NB = [0.035, 0.09, 0.20, 0.40];   // ≈ 各级纹素的 1.8 倍
  csm.lights.forEach((lw, i) => {
    lw.shadow.bias = 0;
    lw.shadow.normalBias = CASCADE_NB[i] ?? CASCADE_NB[CASCADE_NB.length - 1];
    scene.add(lw.target);
    scene.add(lw);
  });

  // 间接光主要由 scene.environment 承担，这两盏只是很轻的补充：
  // 半球光补一点环境贴图给不到的近处地面反弹，环境光防止背光面死黑
  const hemi = new THREE.HemisphereLight(0xbcd6f0, 0xdfe9f5, 0.14);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0x8fa6c4, 0.05);
  scene.add(amb);

  return { sun, hemi, amb, csm };
}

/**
 * 把太阳的 shadow 指向某一级级联，**只是为了体积光**。
 *
 * GodraysNode 会读 `light.shadow.map.depthTexture` 来判断行进途中有没有被挡住。
 * 但用了 CSM 之后太阳自己的 shadow 根本不再渲染，`sun.shadow.map` 永远是 null ——
 * 于是 godrays 那个 pass 每次编译都抛 `Cannot read properties of null`，
 * 被 three 捕获后退回一个默认材质。也就是说**体积光其实一直是坏的**，
 * 只是坏得很安静：开关它只有 2.3% 的像素有变化。
 *
 * （这个报错我先后猜过是 CSM 的初始化时序、是 fade、是某个场景物体，全错。
 *   最后靠 Debugger.setPauseOnExceptions('caught') 断在抛出点，才看见栈顶是
 *   GodraysNode.js:425。教训：与其读源码猜，不如直接断在抛出点上。）
 *
 * 修法是把太阳 shadow 的 map / camera / matrix 指到一级级联上。三者都是对象引用，
 * CSM 每帧原地更新它们，所以指一次就一直是活的。挑第 3 级（57–125m）：
 * 箱子够大，能同时罩住近处的树和中景；体积光本来就是低频的，10cm 的纹素绰绰有余。
 *
 * 必须在**创建后期管线之前**调用，而且那时级联的阴影图得已经分配好 ——
 * 所以 main.js 里先空跑一帧。
 */
export function bindGodrayShadow(lights, cascade = 2) {
  const lw = lights.csm?.lights?.[cascade];
  if (!lw || !lw.shadow.map) return false;
  lights.sun.shadow.map = lw.shadow.map;
  lights.sun.shadow.camera = lw.shadow.camera;
  lights.sun.shadow.matrix = lw.shadow.matrix;
  return true;
}

const _coolBounce = new THREE.Color(0xdde9fa);   // 雪面反弹的冷白
const _skyAvg = new THREE.Color();
const SNOW_ALBEDO = 0.85;

// HDRI 的统计信息（平均色 / 太阳方位），载入后由 main.js 塞进来
let envInfo = null;
export function setEnvInfo(info) { envInfo = info; }

// 太阳只需要摆出**方向**：视锥的位置和范围由 CSM 逐级拟合，
// 纹素吸附也是它自己做的，所以不再需要每帧把光源跟着相机搬。
function placeSun(lights) {
  const d = U.sunDir.value;
  lights.sun.position.set(d.x, Math.max(d.y, 0.04), d.z)
    .normalize().multiplyScalar(SUN_DIST);
  lights.sun.target.position.set(0, 0, 0);
  lights.sun.target.updateMatrixWorld();
}

/** refresh() 之后调用，把 uniform 的光照参数同步到真实灯光上 */
export function syncLights(scene, lights) {
  const d = U.sunDir.value;
  placeSun(lights);
  lights.sun.color.copy(U.sunColor.value);
  lights.sun.intensity = U.sunPower.value;
  lights.sun.castShadow = U.sunPower.value > 0.35;

  lights.hemi.color.copy(U.skyTop.value).lerp(U.skyHorizon.value, 0.22);
  lights.hemi.groundColor.copy(U.fogColor.value).lerp(_coolBounce, 0.70);
  lights.hemi.intensity = U.ambient.value * 0.14;

  lights.amb.color.copy(U.fogColor.value);
  lights.amb.intensity = 0.03 + params.overcast * 0.05;

  // 天空关键帧的配色是按「看起来对」调的显示色，不是物理辐亮度；
  // 直接当辐照度用会比太阳还亮好几倍，所以这里要有一个显式的换算系数。
  scene.environmentIntensity = params.envLight;

  // --- HDRI：色调跟随当前天光，方位跟随太阳 ---
  if (envInfo) {
    // 把 HDRI 的平均色调成当前天空的平均色，HDRI 的细节保留，
    // 但整体冷暖跟着「时间 / 阴天」走
    _skyAvg.copy(U.skyHorizon.value).lerp(U.skyTop.value, 0.35);
    const a = envInfo.avg;
    const ratio = (target, mean) => THREE.MathUtils.clamp(target / Math.max(mean, 1e-4), 0.05, 6);
    const k = params.hdriTint;
    U.hdriTintCol.value.set(
      THREE.MathUtils.lerp(1, ratio(_skyAvg.r, a[0]), k),
      THREE.MathUtils.lerp(1, ratio(_skyAvg.g, a[1]), k),
      THREE.MathUtils.lerp(1, ratio(_skyAvg.b, a[2]), k),
    );

    // 对齐太阳方位：HDRI 的高光方向要和场景阴影方向一致，不然会打架
    const sunAz = Math.atan2(d.x, -d.z);
    U.hdriRot.value = params.hdriFollowSun
      ? (sunAz - envInfo.sunAz)
      : THREE.MathUtils.degToRad(params.hdriRot);
  }

  // 雪地反弹的辐亮度：albedo × (天穹平均辐亮度 + 太阳直射辐照度/π)
  _skyAvg.copy(U.skyHorizon.value).lerp(U.skyTop.value, 0.35);
  const sunTerm = U.sunPower.value * Math.max(d.y, 0) / Math.PI;
  U.groundRadiance.value.set(
    SNOW_ALBEDO * (_skyAvg.r + U.sunColor.value.r * sunTerm),
    SNOW_ALBEDO * (_skyAvg.g + U.sunColor.value.g * sunTerm),
    SNOW_ALBEDO * (_skyAvg.b + U.sunColor.value.b * sunTerm),
  );

  if (scene.fog) scene.fog.color.copy(U.fogColor.value);
}
