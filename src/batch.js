/**
 * batch.js — 用 BatchedMesh 撒道具
 *
 * 之前每个实例都是一次 clone()，68 棵树石头就是 68 个独立的渲染对象。
 * 想在 400m 的场景里撒上千个道具，那条路是走不通的 —— 每个对象都要单独
 * 建绑定组、传矩阵、进渲染列表排序、逐个做视锥测试。
 *
 * BatchedMesh 把同材质的所有实例收进**一个**渲染对象：一次管线绑定、
 * 一次顶点/索引缓冲绑定、一张矩阵纹理，剔除和排序在一个紧凑的循环里做完。
 *
 * 关于绘制调用要说清楚：在 WebGPU 后端，three 对 BatchedMesh 走的是
 * 「一个 render pass 里循环 drawIndexed」，不是真正的 multiDraw，
 * 所以 renderer.info.render.drawCalls 仍然按可见实例数计。
 * 省掉的是**状态切换和 JS 侧的每对象开销**，不是 GPU 的 draw 条数。
 *
 * LOD 用两种简化，按材质自动挑：
 *
 *   封闭实体（石头、树桩）→ 顶点聚类
 *       按空间网格把顶点并成一个代表点。会在 UV 接缝上抹一点，
 *       但**不会破洞** —— 这对封闭物体是硬要求。
 *
 *   镂空卡片（松针、草）→ 按面积丢三角形
 *       只保留面积最大的那部分三角形。顶点属性一个字节都不动，
 *       所以 UV 和 alpha 边缘完全不会糊；代价是会「掉叶子」，
 *       而这恰恰是植被 LOD 该有的退化方式。
 *
 * 反过来用就都是灾难：聚类会把叶片卡糊成一团，丢三角形会把石头打穿。
 */

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

import { snowyVersionOf } from './models.js';

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

// ---------------------------------------------------------------- 几何压缩

/** 只保留被 keep 掩码选中的三角形，并把顶点重新紧凑编号 */
function compact(geo, keep, triCount) {
  const src = geo.getIndex().array;
  const remap = new Int32Array(geo.attributes.position.count).fill(-1);
  const idx = [];
  let next = 0;
  for (let t = 0; t < triCount; t++) {
    if (!keep[t]) continue;
    for (let k = 0; k < 3; k++) {
      const v = src[t * 3 + k];
      if (remap[v] < 0) remap[v] = next++;
      idx.push(remap[v]);
    }
  }

  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name];
    const dst = new a.array.constructor(next * a.itemSize);
    for (let v = 0; v < remap.length; v++) {
      const r = remap[v];
      if (r < 0) continue;
      for (let c = 0; c < a.itemSize; c++) dst[r * a.itemSize + c] = a.array[v * a.itemSize + c];
    }
    out.setAttribute(name, new THREE.BufferAttribute(dst, a.itemSize, a.normalized));
  }
  out.setIndex(new THREE.BufferAttribute(
    next > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  return out;
}

/** 按三角形面积保留前 ratio —— 给 alpha 镂空的植被用 */
function lodByArea(geo, ratio) {
  const idx = geo.getIndex().array;
  const pos = geo.attributes.position.array;
  const triCount = idx.length / 3;
  const area = new Float32Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    area[t] = cx * cx + cy * cy + cz * cz;      // 平方面积就够排序了
  }

  const order = Array.from({ length: triCount }, (_, i) => i)
    .sort((p, q) => area[q] - area[p]);
  const wanted = Math.max(1, Math.round(triCount * ratio));
  const keep = new Uint8Array(triCount);
  for (let i = 0; i < wanted; i++) keep[order[i]] = 1;

  return compact(geo, keep, triCount);
}

/** 顶点聚类 —— 给封闭实体用，绝不破洞 */
function lodByCluster(geo, ratio) {
  const pos = geo.attributes.position.array;
  const count = geo.attributes.position.count;
  const names = Object.keys(geo.attributes);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const ex = Math.max(maxX - minX, 1e-6);
  const ey = Math.max(maxY - minY, 1e-6);
  const ez = Math.max(maxZ - minZ, 1e-6);

  // 表面大致只占 n³ 网格里的 n² 个格子，所以格数按 sqrt(目标顶点数) 取
  const target = Math.max(8, Math.round(count * ratio));
  const n = Math.max(2, Math.round(Math.sqrt(target)));
  const big = Math.max(ex, ey, ez);
  const cell = big / n;
  const nx = Math.max(1, Math.ceil(ex / cell));
  const ny = Math.max(1, Math.ceil(ey / cell));

  const cellOf = (i) => {
    const cx = Math.min(nx - 1, Math.floor((pos[i * 3] - minX) / cell));
    const cy = Math.min(ny - 1, Math.floor((pos[i * 3 + 1] - minY) / cell));
    const cz = Math.floor((pos[i * 3 + 2] - minZ) / cell);
    return (cz * ny + cy) * nx + cx;
  };

  // 每个格子一个代表点，属性取平均
  const slot = new Map();
  const owner = new Int32Array(count);
  const sums = {};
  for (const nm of names) sums[nm] = [];
  const counts = [];

  for (let i = 0; i < count; i++) {
    const key = cellOf(i);
    let s = slot.get(key);
    if (s === undefined) {
      s = counts.length;
      slot.set(key, s);
      counts.push(0);
      for (const nm of names) {
        sums[nm].push(new Float64Array(geo.attributes[nm].itemSize));
      }
    }
    owner[i] = s;
    counts[s]++;
    for (const nm of names) {
      const a = geo.attributes[nm];
      const acc = sums[nm][s];
      for (let c = 0; c < a.itemSize; c++) acc[c] += a.array[i * a.itemSize + c];
    }
  }

  const out = new THREE.BufferGeometry();
  for (const nm of names) {
    const a = geo.attributes[nm];
    const dst = new Float32Array(counts.length * a.itemSize);
    for (let s = 0; s < counts.length; s++) {
      const acc = sums[nm][s];
      for (let c = 0; c < a.itemSize; c++) dst[s * a.itemSize + c] = acc[c] / counts[s];
    }
    // 法线/切线平均之后必须重新归一化；切线的 w 是手性，不能平均
    if (nm === 'normal' || nm === 'tangent') {
      for (let s = 0; s < counts.length; s++) {
        const o = s * a.itemSize;
        const l = Math.hypot(dst[o], dst[o + 1], dst[o + 2]) || 1;
        dst[o] /= l; dst[o + 1] /= l; dst[o + 2] /= l;
        if (a.itemSize === 4) dst[o + 3] = dst[o + 3] >= 0 ? 1 : -1;
      }
    }
    out.setAttribute(nm, new THREE.BufferAttribute(dst, a.itemSize, a.normalized));
  }

  // 重建索引，丢掉三个角并到一起的退化三角形
  const src = geo.getIndex().array;
  const idx = [];
  for (let t = 0; t < src.length / 3; t++) {
    const a = owner[src[t * 3]], b = owner[src[t * 3 + 1]], c = owner[src[t * 3 + 2]];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  out.setIndex(new THREE.BufferAttribute(
    counts.length > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  return out;
}

// ---------------------------------------------------------------- 装配

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _white = new THREE.Color(1, 1, 1);

/**
 * 载入一个 glb，把它的所有实例装进 BatchedMesh。
 *
 * @param {THREE.Scene} scene
 * @param {string} url
 * @param {object} opts
 * @param {Array}  opts.instances    [[x, z, rotationY, scaleMul], ...]
 * @param {number} opts.targetHeight 统一缩放到这个高度（米）
 * @param {Function} opts.groundAt   (x,z) => y，地面高度
 * @param {number[]} opts.lods       各级 LOD 的保留比例，第一项恒为 1。
 *                                默认五级：级差小了，每次切换的视觉跳变也小
 * @param {number} opts.coatBias     盖雪倾向
 * @param {number} opts.snowAmount   盖雪量倍率
 * @returns {Promise<{ update(camera): void, meshes: THREE.BatchedMesh[], stats: object }>}
 */
export async function batchModel(scene, url, opts = {}) {
  const {
    instances = [], targetHeight = 0, groundAt = null,
    lods = [1, 0.62, 0.38, 0.22, 0.12], coatBias = 0, snowAmount = 1,
  } = opts;

  const gltf = await loader().loadAsync(url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  const parts = [];
  root.traverse((o) => { if (o.isMesh) parts.push(o); });
  if (!parts.length) throw new Error(`${url}: 没有 mesh`);

  // 把 mesh 的世界矩阵烘进几何体，再统一缩放、把原点挪到包围盒底面中心 ——
  // 之后每个实例的矩阵就只剩「摆到哪、转多少、多大」
  const baked = parts.map((o) => {
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    return { geo: g, material: o.material };
  });

  const box = new THREE.Box3();
  for (const b of baked) { b.geo.computeBoundingBox(); box.union(b.geo.boundingBox); }
  const size = box.getSize(new THREE.Vector3());
  const scale = targetHeight > 0 && size.y > 1e-6 ? targetHeight / size.y : 1;
  _m.makeScale(scale, scale, scale).multiply(
    new THREE.Matrix4().makeTranslation(
      -(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2));
  for (const b of baked) b.geo.applyMatrix4(_m);

  const height = size.y * scale;

  // ---- 每种材质一个 BatchedMesh ----
  const meshes = [];
  const stats = { url, instances: instances.length, height, lodTris: [] };

  for (const { geo, material } of baked) {
    // 镂空卡片按面积丢三角形，封闭实体做顶点聚类 —— 反过来用都是灾难
    const cutout = material.alphaTest > 0 || material.transparent === true;
    const simplify = cutout ? lodByArea : lodByCluster;

    const levels = [geo];
    for (let i = 1; i < lods.length; i++) levels.push(simplify(geo, lods[i]));

    let maxV = 0, maxI = 0;
    for (const g of levels) {
      maxV += g.attributes.position.count;
      maxI += g.getIndex().count;
    }

    const mat = snowyVersionOf(material, coatBias, snowAmount, true);
    // 每个道具占**两个**槽位：LOD 切换时旧的淡出、新的淡入，中间那 0.3 秒两边都画。
    // 平时只有一个是可见的，所以代价只是矩阵纹理大了一倍（几百 KB）。
    const bm = new THREE.BatchedMesh(instances.length * 2, maxV, maxI, mat);
    bm.name = `${url.split('/').pop()}_batch`;
    bm.castShadow = true;
    bm.receiveShadow = true;
    bm.perObjectFrustumCulled = true;      // 默认就是开的，这里写出来是为了明确
    bm.sortObjects = true;

    const ids = levels.map((g) => bm.addGeometry(g));

    for (const [x, z, ry = 0, mul = 1] of instances) {
      _q.setFromAxisAngle(_up, ry);
      _p.set(x, groundAt ? groundAt(x, z) : 0, z);
      _s.setScalar(mul);
      _m.compose(_p, _q, _s);
      const a = bm.addInstance(ids[0]);
      const b = bm.addInstance(ids[0]);
      bm.setMatrixAt(a, _m);
      bm.setMatrixAt(b, _m);
      bm.setVisibleAt(b, false);          // b 是备用槽，只在转场时露面
    }
    // 建出每实例的颜色纹理：Float32、初值全 1，我们只用它的 alpha 当淡入淡出值。
    // 必须在材质编译之前存在，否则 batch() 不会写 vBatchColor 那个 varying，
    // 材质里的 maskNode 就会读到未初始化的值，整批道具直接消失。
    bm.setColorAt(0, _white);

    scene.add(bm);
    meshes.push({ bm, ids });
    stats.lodTris.push(levels.map((g) => g.getIndex().count / 3));
    stats.cutout = cutout;
  }

  // ---- 逐帧 LOD ----
  //
  // 判据是**屏幕上的高度占比** h/d，不是绝对距离：一棵 4m 的树和一丛 0.8m 的草
  // 用同一组阈值才公平，草会早得多地降级和消失，树能一直留到很远。
  const px = new Float32Array(instances.length);
  const pz = new Float32Array(instances.length);
  const mulOf = new Float32Array(instances.length);
  const jit = new Float32Array(instances.length);
  instances.forEach(([x, z, , mul = 1], i) => {
    px[i] = x; pz[i] = z; mulOf[i] = mul;
    // 每个实例的阈值抖 ±16%。不抖的话，相机一推近，同一片林子里的树会在
    // 同一瞬间集体降级 —— 那道「波」比单棵树的跳变显眼得多。
    jit[i] = 0.84 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.32;
  });

  // 阈值按**屏幕像素高度**折算，别凭感觉拍。1600x900 / 52° 竖直视场下
  //   px ≈ (h/d) * 450 / tan(26°) ≈ (h/d) * 923
  // 第一版拍了 0.075，等于 69px 就降级 —— 60m 外的树立刻掉掉三分之二的针叶卡，
  // 中景整片变稀，一眼看得出来。
  const nLod = lods.length;
  const LOD_K = [0.049, 0.030, 0.020, 0.013];   // 依次是降到第 1/2/3/4 级的阈值
  const CULL = 0.008;                            // ≈ 7 px，再小就不画了
  const FADE = 0.30;                             // 转场时长（秒）

  const lodOf = new Int8Array(instances.length);      // 当前活动槽显示的级别
  const act = new Uint8Array(instances.length);       // 活动槽是 a(0) 还是 b(1)
  const toLod = new Int8Array(instances.length);      // 转场目标级别，-1 = 正在剔除
  const t0 = new Float32Array(instances.length).fill(-1);  // 转场起始时刻，-1 = 没在转场
  const shown = new Uint8Array(instances.length).fill(1);

  const colData = meshes.map(({ bm }) => bm._colorsTexture.image.data);
  let colDirty = false;
  const setFade = (i, slot, a) => {
    const o = (i * 2 + slot) * 4 + 3;
    for (const d of colData) d[o] = a;
    colDirty = true;
  };
  const setVis = (i, slot, v) => { for (const { bm } of meshes) bm.setVisibleAt(i * 2 + slot, v); };
  const setGeo = (i, slot, lod) => {
    for (const { bm, ids } of meshes) bm.setGeometryIdAt(i * 2 + slot, ids[lod]);
  };
  for (let i = 0; i < instances.length; i++) setFade(i, 1, 0);

  stats.lodCount = new Array(nLod).fill(0);
  stats.hidden = 0;
  stats.fading = 0;

  const CHUNKS = 4;      // 分四帧轮流判定，摊平每帧的 CPU
  let phase = 0;

  function update(camera) {
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const n = instances.length;
    const now = performance.now() * 0.001;

    for (let i = phase; i < n; i += CHUNKS) {
      // --- 正在转场的先推进 ---
      if (t0[i] >= 0) {
        const t = (now - t0[i]) / FADE;
        const from = act[i], to = 1 - act[i];
        if (t >= 1) {
          t0[i] = -1;
          setFade(i, from, 0);
          setVis(i, from, false);
          if (toLod[i] < 0) {
            shown[i] = 0;
            setVis(i, to, false);
          } else {
            setFade(i, to, 1);
            act[i] = to;
            lodOf[i] = toLod[i];
            shown[i] = 1;
          }
        } else {
          setFade(i, from, 1 - t);
          if (toLod[i] >= 0) setFade(i, to, t);
          continue;                       // 转场期间不重新判定，免得来回抖
        }
      }

      // --- 判定目标级别 ---
      const dx = px[i] - cx, dz = pz[i] - cz;
      const d = Math.sqrt(dx * dx + dz * dz + cy * cy) || 1e-3;
      const k = (height * mulOf[i]) / d * jit[i];

      let want = 0;
      if (k < CULL) want = -1;
      else { while (want < nLod - 1 && k < LOD_K[want]) want++; }

      const cur = shown[i] ? lodOf[i] : -1;
      if (want === cur) continue;

      // 换级、剔除、重新出现，走的是同一条路：备用槽装上新几何体，两边交叉淡。
      // 「重新出现」时 from 那一槽本来就是隐藏且 fade=0 的，淡出等于没事发生。
      const to = 1 - act[i];
      toLod[i] = want;
      if (want >= 0) {
        setGeo(i, to, want);
        setFade(i, to, 0);
        setVis(i, to, true);
      }
      t0[i] = now;
    }
    phase = (phase + 1) % CHUNKS;

    if (colDirty) {
      for (const { bm } of meshes) bm._colorsTexture.needsUpdate = true;
      colDirty = false;
    }

    // 统计给 __snow 看的，不参与渲染
    const c = new Array(nLod).fill(0);
    let hid = 0, fad = 0;
    for (let i = 0; i < n; i++) {
      if (!shown[i]) hid++; else c[lodOf[i]]++;
      if (t0[i] >= 0) fad++;
    }
    stats.lodCount = c;
    stats.hidden = hid;
    stats.fading = fad;
  }

  return { update, meshes: meshes.map((m) => m.bm), stats };
}
