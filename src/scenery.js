/**
 * scenery.js — 场景陈设
 *
 * 几棵松树、几块石头、一段木栅栏 —— 它们提供尺度感和长长的投影，
 * 这是雪景「写实」感的一大半来源。所有物体的朝上表面都会自动积雪。
 *
 * 远景雪原已经搬去 snowfield.js 了：地面现在是「地形 + clipmap 积雪」，
 * 不再需要单独的一张远景平面。这里只剩下摆件，而摆件要贴着地形放。
 */

import * as THREE from 'three/webgpu';
import {
  Fn, float, vec3, mix, smoothstep,
  positionWorld, normalWorld, mx_fractal_noise_float,
} from 'three/tsl';

import { U, GROUND } from './config.js';
import { terrainY } from './terrain.js';

// ---------------------------------------------------------------- 随机

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 给石头用的确定性 3D 值噪声（同一坐标必定同一结果，避免非索引几何体撕裂） */
function noise3(x, y, z) {
  const h = (i, j, k) => {
    let n = i * 374761393 + j * 668265263 + k * 2147483647;
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const sx = x - fx, sy = y - fy, sz = z - fz;
  const u = sx * sx * (3 - 2 * sx), v = sy * sy * (3 - 2 * sy), w = sz * sz * (3 - 2 * sz);
  const lerp = (a, b, t) => a + (b - a) * t;
  const c = (i, j, k) => h(fx + i, fy + j, fz + k);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

// ---------------------------------------------------------------- 会积雪的材质

/**
 * 朝上的表面自动盖雪。coatBias 越大越容易积雪（松针 > 树皮 > 石头）。
 */
function snowyMaterial(baseHex, roughness, coatBias = 0) {
  const base = new THREE.Color(baseHex);   // 构造函数只接受一个参数，颜色空间走默认 sRGB
  const m = new THREE.MeshStandardNodeMaterial();

  const coverage = Fn(() => {
    // 噪声只用来打碎边缘，频率要高、幅度要小 —— 低频大幅度会在雪帽上糊出霉斑
    const n = mx_fractal_noise_float(positionWorld.mul(11.0), 3, 2.3, 0.5, 1.0).mul(0.5).add(0.5);
    const up = normalWorld.y.add(n.sub(0.5).mul(0.16)).add(coatBias);
    // 明确朝上的面盖实，侧面才做过渡
    return smoothstep(0.26, 0.62, up).mul(U.snowCoat).clamp(0, 1);
  })();

  m.colorNode = mix(vec3(base.r, base.g, base.b), vec3(0.885, 0.918, 0.975), coverage);
  m.roughnessNode = mix(float(roughness), float(0.88), coverage);
  m.metalnessNode = float(0);
  m.emissiveNode = Fn(() => {
    // 雪帽在阳光下也有一点点冷色透光
    const back = float(1).sub(normalWorld.dot(U.sunDir).clamp(0, 1)).pow(2.0);
    return vec3(0.30, 0.40, 0.58).mul(back).mul(coverage).mul(0.030).mul(U.sunPower);
  })();

  return m;
}

// ---------------------------------------------------------------- 松树

function makePine(bark, needle, h, rng) {
  const g = new THREE.Group();

  const trunkH = h * 0.34;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.020, h * 0.035, trunkH, 7), bark);
  trunk.position.y = trunkH * 0.5;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  g.add(trunk);

  const tiers = 4;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const r = h * (0.30 - 0.19 * t) * (0.9 + rng() * 0.2);
    const ch = h * (0.34 - 0.10 * t);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, ch, 9), needle);
    cone.position.y = trunkH * 0.65 + t * (h * 0.60) + ch * 0.35;
    cone.rotation.y = rng() * Math.PI;
    cone.castShadow = true;
    cone.receiveShadow = true;
    g.add(cone);
  }
  return g;
}

// ---------------------------------------------------------------- 石头

function makeRock(mat, r, seed) {
  const geo = new THREE.IcosahedronGeometry(r, 2);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = noise3(v.x * 2.4 + seed, v.y * 2.4 + seed, v.z * 2.4 + seed);
    const n2 = noise3(v.x * 6.0 - seed, v.y * 6.0 - seed, v.z * 6.0 - seed);
    const k = 1 + (n - 0.5) * 0.46 + (n2 - 0.5) * 0.16;
    v.multiplyScalar(k);
    v.y *= 0.72;                     // 压扁一点，更像埋在雪里的卵石
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------- 栅栏

function makeFence(wood, rng) {
  const g = new THREE.Group();
  const postGeo = new THREE.BoxGeometry(0.10, 1.15, 0.10);
  const railGeo = new THREE.BoxGeometry(1.62, 0.075, 0.045);

  for (let i = 0; i < 13; i++) {
    const x = -9.6 + i * 1.6;
    const post = new THREE.Mesh(postGeo, wood);
    post.position.set(x, 0.55, 0);
    post.rotation.z = (rng() - 0.5) * 0.05;
    post.rotation.y = (rng() - 0.5) * 0.2;
    post.castShadow = true;
    post.receiveShadow = true;
    g.add(post);

    if (i < 12) {
      for (const y of [0.42, 0.84]) {
        const rail = new THREE.Mesh(railGeo, wood);
        rail.position.set(x + 0.8, y + (rng() - 0.5) * 0.03, 0);
        rail.rotation.z = (rng() - 0.5) * 0.03;
        rail.castShadow = true;
        rail.receiveShadow = true;
        g.add(rail);
      }
    }
  }
  return g;
}

// ---------------------------------------------------------------- 组装

/**
 * 程序化陈设。松树和石头默认开着；放了真模型之后由 main.js 关掉，
 * 想换回程序化版本把开关打开就行。
 */
export function createScenery(scene, { pines = true, rocks = true, fence = true } = {}) {
  const rng = mulberry32(20260828);

  const bark = snowyMaterial(0x3a2c22, 0.92, -0.08);
  const needle = snowyMaterial(0x27452f, 0.86, 0.13);
  const stone = snowyMaterial(0x4a4a4e, 0.95, 0.02);
  const wood = snowyMaterial(0x51392a, 0.90, 0.04);

  const props = new THREE.Group();
  const R0 = GROUND * 0.44;   // 中心留空，方便玩雪

  // 松树林：内圈几棵大的，外圈散布
  for (let i = 0; pines && i < 22; i++) {
    const near = i < 7;
    const ang = rng() * Math.PI * 2;
    const rad = near ? R0 + rng() * 5 : R0 + 7 + rng() * 34;
    const h = (near ? 3.2 : 2.4) + rng() * (near ? 2.6 : 4.4);
    const tree = makePine(bark, needle, h, rng);
    const tx = Math.cos(ang) * rad, tz = Math.sin(ang) * rad;
    tree.position.set(tx, terrainY(tx, tz) - 0.05, tz);
    tree.rotation.y = rng() * Math.PI * 2;
    props.add(tree);
  }

  // 石头
  for (let i = 0; rocks && i < 14; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = 3.5 + rng() * (GROUND * 0.62);
    const r = 0.22 + rng() * 0.62;
    const rock = makeRock(stone, r, i * 3.7);
    const rx = Math.cos(ang) * rad, rz = Math.sin(ang) * rad;
    rock.position.set(rx, terrainY(rx, rz) + r * 0.30, rz);
    rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    props.add(rock);
  }

  // 栅栏：放在场地北边，斜阳会拉出很长的影子
  if (fence) {
    const f = makeFence(wood, rng);
    const fz = -GROUND * 0.40;
    f.position.set(0.6, terrainY(0.6, fz) - 0.04, fz);
    f.rotation.y = 0.06;
    props.add(f);
  }

  scene.add(props);
  return props;
}
