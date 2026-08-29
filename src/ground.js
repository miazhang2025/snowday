/**
 * ground.js — 雪底下的地面材质
 *
 * 雪被推开之后露出来的那一层，以前是一个常数深色。换成真的 PBR 地表之后，
 * 推痕的沟底、陡坡上挂不住雪的地方，才有材质感而不是一片死黑。
 *
 * 两张图（见 tools/prep-ground.py）：
 *   ground_albedo.jpg   基础色
 *   ground_nr.jpg       R,G = 法线的 xy，B = 粗糙度
 *
 * 法线的 z 从 xy 反解，第三个通道正好塞粗糙度 —— 少一张贴图、少一次采样。
 *
 * UV 用**世界 xz 平面投影**，不是三平面。地面绝大多数时候是接近水平的
 * （沟底、缓坡），陡壁上会有拉伸，但这套贴图是细颗粒的土，
 * 拉伸细噪声远不如拉伸砖缝那么刺眼 —— 换三平面要三倍采样，不值。
 */

import * as THREE from 'three/webgpu';
import { texture, float, vec2, vec3 } from 'three/tsl';

/** 一次平铺覆盖多少米。太大看不清颗粒，太小平铺感明显。 */
const TILE = 1.75;

function load(url, srgb) {
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  // 地面几乎总是被斜着看的，各向异性过滤对它的收益比对任何别的贴图都大
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const albedoTex = load('assets/ground_albedo.jpg', true);
const nrTex = load('assets/ground_nr.jpg', false);

const guv = (xz) => xz.div(TILE);

/** 基础色 */
export const groundAlbedo = (xz) => vec3(texture(albedoTex, guv(xz)));

/** vec2(法线.x, 法线.y)，已经从 0..1 映射回 -1..1 */
export const groundNormalXY = (xz) => {
  const nr = texture(nrTex, guv(xz));
  return vec2(nr.r, nr.g).mul(2.0).sub(1.0);
};

/** 粗糙度（打包在 nr 图的 B 通道） */
export const groundRough = (xz) => float(texture(nrTex, guv(xz)).b);
