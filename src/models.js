/**
 * models.js — 往场景里放外部模型（glTF / GLB）
 *
 * 做了三件事：
 *   1. 加载 glTF，支持 Draco 压缩
 *   2. 打开投影/受影，并让它进入 pre-pass（GTAO 的接触暗部靠这个）
 *   3. 可选地给模型「盖雪」—— 朝上的面按法线混进雪的颜色和粗糙度，
 *      贴图和法线贴图都保留
 *
 * 用法：
 *   import { loadModel } from './models.js';
 *   await loadModel(scene, 'assets/cabin.glb', { position: [3, 0, -2], scale: 1.4 });
 *
 * 也可以在浏览器控制台直接调：
 *   await __snow.loadModel('assets/cabin.glb', { scale: 2, snow: true })
 */

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import {
  Fn, float, vec3, vec4, mix, smoothstep, positionWorld, normalWorld, cameraPosition,
  materialColor, materialRoughness, mx_fractal_noise_float,
  varyingProperty, screenCoordinate,
} from 'three/tsl';

import { U } from './config.js';

const SNOW_TINT = [0.885, 0.918, 0.975];

let _loader = null;
function loader() {
  if (!_loader) {
    _loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/draco/');
    _loader.setDRACOLoader(draco);
  }
  return _loader;
}

/**
 * 把任意材质换成「会积雪」的节点材质。
 * 用 materialColor / materialRoughness 取值，所以基础贴图、颜色、
 * 粗糙度贴图都还在，只是朝上的面上叠一层雪。
 */
/**
 * 交错梯度噪声（Jorge Jimenez）。屏幕空间的抖动图案，配合 TRAA 时间上会被平均掉 ——
 * 所以「按抖动丢像素」看起来就是平滑的淡入淡出，而不是一片噪点。
 */
const ign = (p) => p.x.mul(0.06711056).add(p.y.mul(0.00583715)).fract()
  .mul(52.9829189).fract();

/**
 * @param {boolean} batched  这份材质是给 BatchedMesh 用的吗？
 *   是的话就接上 LOD 的抖动溶解：每实例的淡入淡出值存在 BatchedMesh 的
 *   颜色纹理的 alpha 通道里，three 在顶点阶段把它写进 `vBatchColor` 这个 varying，
 *   这里再读出来。非批处理的模型不能开 —— 那个 varying 根本没人写。
 */
export function snowyVersionOf(src, coatBias = 0, snowAmount = 1, batched = false) {
  const m = new THREE.MeshStandardNodeMaterial();

  // 常规属性照搬
  if (src.color) m.color.copy(src.color);
  m.map = src.map ?? null;
  m.normalMap = src.normalMap ?? null;
  if (src.normalScale && m.normalScale) m.normalScale.copy(src.normalScale);
  m.roughness = src.roughness ?? 1;
  m.metalness = src.metalness ?? 0;
  m.roughnessMap = src.roughnessMap ?? null;
  m.metalnessMap = src.metalnessMap ?? null;
  m.aoMap = src.aoMap ?? null;
  m.emissive?.copy?.(src.emissive ?? new THREE.Color(0));
  m.emissiveMap = src.emissiveMap ?? null;
  m.side = src.side;
  m.transparent = src.transparent;
  m.opacity = src.opacity;
  m.alphaTest = src.alphaTest;
  m.alphaMap = src.alphaMap ?? null;
  m.flatShading = src.flatShading;
  m.name = `${src.name || 'mat'}_snowy`;

  // 覆盖度：噪声只用来打碎边缘，频率要高、幅度要小 —— 低频大幅度会糊出霉斑
  const coverage = Fn(() => {
    const n = mx_fractal_noise_float(positionWorld.mul(11.0), 3, 2.3, 0.5, 1.0).mul(0.5).add(0.5);
    const up = normalWorld.y.add(n.sub(0.5).mul(0.16)).add(coatBias);
    return smoothstep(0.26, 0.62, up).mul(U.snowCoat.mul(snowAmount)).clamp(0, 1);
  })();

  // materialColor 是 vec4（颜色 × 贴图，含 alpha）。只能混 RGB ——
  // 直接和 vec3 混会把 alpha 一起推向 1，带镂空的植物/树叶整片会变成不透明的方块。
  const base = materialColor;
  m.colorNode = vec4(mix(base.rgb, vec3(...SNOW_TINT), coverage), base.a);
  m.roughnessNode = mix(materialRoughness, float(0.88), coverage);
  m.emissiveNode = Fn(() => {
    // 雪帽在阳光下有一点冷色透光
    const back = float(1).sub(normalWorld.dot(U.sunDir).clamp(0, 1)).pow(2.0);
    return vec3(0.30, 0.40, 0.58).mul(back).mul(coverage).mul(0.030).mul(U.sunPower);
  })();

  // 镂空植被在远处会「变稀」：每片针叶卡覆盖的像素越来越少，采样点落在
  // alpha 边缘之外的概率越来越大，而 alpha 测试是二值的 —— 整片叶子就这么没了。
  // 树在中景于是显得比近景瘦一圈。让阈值随距离降下来：边缘会糊一点点，
  // 但树的体量保住了。（正解是 alpha-to-coverage，那需要 MSAA，而 MSAA 和
  // 这里的 GTAO / TRAA 深度采样打架，见 main.js 里那段注释。）
  let cutoff = null;
  if (src.alphaTest > 0) {
    m.alphaTest = src.alphaTest;
    cutoff = mix(
      float(src.alphaTest), float(0.10),
      smoothstep(25.0, 130.0, cameraPosition.distance(positionWorld)),
    );
    m.alphaTestNode = cutoff;
  }

  if (batched) {
    // 每实例的淡入淡出值（0..1）
    const fade = varyingProperty('vec4', 'vBatchColor').w;

    // 抖动溶解：按屏幕位置丢像素，丢的比例正好是 1-fade。
    // maskNode 在阴影 pass 里也生效（three 会取 maskShadowNode || maskNode），
    // 所以淡出的树影子也跟着一起淡，不会出现「树没了影子还在」。
    m.maskNode = fade.greaterThan(ign(screenCoordinate.xy));

    // three 对 BatchedMesh 会做 colorNode = batchColor * colorNode，**alpha 也乘**。
    // 所以镂空材质的 alphaTest 阈值必须同步乘上 fade，否则 fade 一低于 cutoff
    // 整棵树会「啪」地一次性消失，抖动就白做了。
    if (cutoff) m.alphaTestNode = cutoff.mul(fade);
  }

  return m;
}

/**
 * 加载并放进场景。
 *
 * @param {THREE.Scene} scene
 * @param {string} url                    .glb / .gltf
 * @param {object} [opts]
 * @param {number[]} [opts.position]      [x,y,z]
 * @param {number}   [opts.scale]         统一缩放
 * @param {number}   [opts.rotationY]     绕 Y 轴旋转（弧度）
 * @param {boolean}  [opts.snow=true]     朝上的面是否盖雪
 * @param {number}   [opts.coatBias=0]    盖雪倾向：正值更容易积雪
 * @param {number}   [opts.snowAmount=1]  盖雪量倍率。屋顶这类想盖满的给 1.6 左右
 * @param {boolean}  [opts.shadows=true]  投影 / 受影
 * @param {boolean}  [opts.center=false]  是否把模型底面对齐到 y=0
 * @param {number}   [opts.targetHeight]  统一缩放到这个高度（米），会覆盖 scale
 * @param {Array}    [opts.instances]     给了就克隆多份：[[x, z, rotationY, scaleMul], ...]
 *                                        只下载解析一次，几何和材质共用
 * @param {Function} [opts.groundAt]      (x,z) => y。地面不是平的了，每份实例
 *                                        都要落在自己脚下那一点的地形高度上
 * @returns {Promise<THREE.Object3D>}
 */
export async function loadModel(scene, url, opts = {}) {
  const {
    position = [0, 0, 0], rotationY = 0,
    snow = true, coatBias = 0, snowAmount = 1, shadows = true, center = false,
    targetHeight = 0, instances = null, groundAt = null,
  } = opts;
  let { scale = 1 } = opts;

  const gltf = await loader().loadAsync(url);
  const root = gltf.scene;

  const swapped = new Map();     // 同一个材质只换一次，保住批次合并
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (shadows) { o.castShadow = true; o.receiveShadow = true; }

    if (snow) {
      const apply = (mat) => {
        if (!swapped.has(mat)) swapped.set(mat, snowyVersionOf(mat, coatBias, snowAmount));
        return swapped.get(mat);
      };
      o.material = Array.isArray(o.material) ? o.material.map(apply) : apply(o.material);
    }
  });

  // 统一到指定高度：先量原始包围盒再换算
  if (targetHeight > 0) {
    const h = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).y;
    if (h > 1e-6) scale = targetHeight / h;
  }

  // 多份实例：把 root 的原点挪到「包围盒底面中心」，之后每份只要摆位置就行
  if (instances && instances.length) {
    root.scale.setScalar(scale);
    const box = new THREE.Box3().setFromObject(root);
    const pivot = new THREE.Group();
    root.position.set(
      -(box.min.x + box.max.x) / 2,
      -box.min.y,
      -(box.min.z + box.max.z) / 2,
    );
    pivot.add(root);

    const group = new THREE.Group();
    group.name = `${url.split('/').pop()}_x${instances.length}`;
    for (const [x, z, ry = 0, mul = 1] of instances) {
      const c = pivot.clone(true);
      c.position.set(x, position[1] + (groundAt ? groundAt(x, z) : 0), z);
      c.rotation.y = ry;
      c.scale.setScalar(mul);
      group.add(c);
    }
    scene.add(group);
    return group;
  }

  root.scale.setScalar(scale);
  root.rotation.y = rotationY;

  if (center) {
    // 把包围盒底面贴到 y=0，省得手调高度
    const box = new THREE.Box3().setFromObject(root);
    root.position.set(
      position[0] - (box.min.x + box.max.x) / 2,
      position[1] - box.min.y,
      position[2] - (box.min.z + box.max.z) / 2,
    );
  } else {
    root.position.set(position[0], position[1], position[2]);
  }

  scene.add(root);
  return root;
}

/** 卸载并释放 */
export function unloadModel(scene, root) {
  scene.remove(root);
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => m?.dispose());
  });
}
