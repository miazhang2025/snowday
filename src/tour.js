/**
 * tour.js — 新手指引
 *
 * 没有卡片、没有按钮，只有浮在场景里的一行字和一个动画，一步一件事：
 *
 *   1 推雪      雪面上一个手掌大小的圆圈贴着地来回滑 —— 「按住，拖」
 *   2 换成模具  一个箭头指着面板里的「模具」（面板收着就先指右上角的雪花）
 *   3 放雪人    切过去之后，雪面上一个呼吸的圆圈 —— 「点一下」
 *   4 拍照      箭头指着右上角的相机
 *
 * 每一步在你**真的做了**之后自己淡出、换下一步。底下只留一个很小的「跳过指引」。
 * 走完或跳过之后记在 localStorage，下次不再出现；操作说明面板里可以重看。
 *
 * 圆圈是逐帧投影的：在雪面上取一个点、沿镜头的左右方向来回，
 * 再把「点 ± 手掌半径」投到屏幕上得到椭圆的长短轴 —— 所以它是真的「躺在」雪面上，
 * 远近、俯仰都对，和你真正按下去时雪面上那圈光标一样大。
 */

import * as THREE from 'three/webgpu';
import { HAND, params, U } from './config.js';
import { t, onLangChange } from './i18n.js';

const DONE_KEY = 'snow.tour.done';
const SNOWMAN = 1;                 // MOLDS 里雪人的下标

export function tourDone() {
  try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return false; }
}

function markDone() {
  try { localStorage.setItem(DONE_KEY, '1'); } catch { /* 隐私模式：这次看完就算 */ }
}

const STEPS = ['push', 'menu', 'place', 'photo'];

/**
 * @param {object} deps
 * @param {object} deps.interaction  interaction.js 的返回值
 * @param {object} deps.ui           ui.js 的返回值（第 3 步要换成雪人）
 * @param {THREE.Camera} deps.camera
 */
export function createTour({ interaction, ui, camera }) {
  const root = document.getElementById('tour');
  const ring = document.getElementById('tgring');
  const arrow = document.getElementById('tgarrow');
  const text = document.getElementById('tgtext');
  const skip = document.getElementById('tgskip');
  const S = interaction.state;

  let step = -1;
  let raf = 0;
  let lastT = 0;
  let clock = 0;
  let leaving = 0;            // 这一步做到了、正在淡出的计时器
  let pushTime = 0;
  let placedAt = 0;

  // ---- 雪面上的锚点 ----
  const anchor = new THREE.Vector3();
  let hasAnchor = false;
  const right = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const _p = new THREE.Vector3();    // drawRing 内部用
  const _q = new THREE.Vector3();    // toScreen 内部用
  const slide = new THREE.Vector3(); // 第 1 步圆圈的当前位置

  /** 屏幕上「空着的那块」的中心偏下：右边是面板，别把圆圈画到面板底下 */
  function pickAnchor() {
    const panel = document.body.dataset.open === 'panel' ? 380 : 0;
    const sx = (innerWidth - panel) * 0.5;
    const sy = innerHeight * 0.64;
    hasAnchor = interaction.pickGround(sx, sy, anchor);
  }

  /** 世界点 -> 屏幕像素；在镜头背后返回 null */
  function toScreen(v, out) {
    _q.copy(v).project(camera);
    if (_q.z > 1) return null;
    out.x = (_q.x + 1) / 2 * innerWidth;
    out.y = (1 - _q.y) / 2 * innerHeight;
    return out;
  }

  const sc = { x: 0, y: 0 };
  const sa = { x: 0, y: 0 };
  const sb = { x: 0, y: 0 };

  /** 把圆圈画在雪面上的点 p 处（半径 = 手掌半径） */
  function drawRing(p) {
    const R = U.handRadius.value;
    if (!toScreen(p, sc)) { ring.style.opacity = 0; return null; }
    _p.copy(p).addScaledVector(right, R);
    const a = toScreen(_p, sa);
    _p.copy(p).addScaledVector(fwd, R);
    const b = toScreen(_p, sb);
    if (!a || !b) { ring.style.opacity = 0; return null; }
    const rx = Math.max(8, Math.hypot(sa.x - sc.x, sa.y - sc.y));
    const ry = Math.max(4, Math.hypot(sb.x - sc.x, sb.y - sc.y));
    ring.style.width = `${rx * 2}px`;
    ring.style.height = `${ry * 2}px`;
    ring.style.transform = `translate(${sc.x - rx}px, ${sc.y - ry}px)`;
    ring.style.opacity = '';
    return { x: sc.x, y: sc.y, ry };
  }

  /** 镜头的左右 / 前后方向，压到水平面上 */
  function groundAxes() {
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    right.set(-fwd.z, 0, fwd.x);
  }

  /** 箭头指着一个 DOM 元素。side = 'left'（箭头在它左边、朝右）或 'below'（在它下面、朝上） */
  let focusEl = null;
  function setFocus(el) {
    if (el === focusEl) return;
    focusEl?.classList.remove('tour-focus');
    focusEl = el || null;
    focusEl?.classList.add('tour-focus');
  }

  function pointAt(el, side) {
    setFocus(el);
    const r = el?.getBoundingClientRect();
    if (!r || r.width < 2) { arrow.style.opacity = 0; text.style.opacity = 0; return; }
    arrow.style.opacity = '';
    text.style.opacity = '';
    arrow.dataset.side = side;
    if (side === 'left') {
      // 目标在面板里的话，箭头停在面板外沿（对准那一行），别压在别的按钮上；
      // 具体是哪一个按钮由它自己的呼吸光圈标出来
      const panel = el.closest('#ui')?.getBoundingClientRect();
      const x = Math.min(r.left, panel ? panel.left : r.left) - 14, y = r.top + r.height / 2;
      arrow.style.transform = `translate(${x - 64}px, ${y - 14}px)`;
      text.dataset.align = 'right';
      text.style.transform = `translate(${x - 80}px, ${y}px) translate(-100%, -50%)`;
    } else {
      const x = r.left + r.width / 2, y = r.bottom + 10;
      arrow.style.transform = `translate(${x - 14}px, ${y}px)`;
      text.dataset.align = 'right';
      text.style.transform = `translate(${Math.min(x + 20, innerWidth - 16)}px, ${y + 72}px) translate(-100%, 0)`;
    }
  }

  function setText(a, b) {
    text.querySelector('.a').innerHTML = a;
    text.querySelector('.b').innerHTML = b || '';
  }

  // ---- 每一步：进场、每帧、做到了没有 ----

  const steps = {
    push: {
      enter() { pushTime = 0; pickAnchor(); setText(t('tour.push'), t('tour.push.k')); },
      frame(dt) {
        if (!hasAnchor) { pickAnchor(); return; }
        groundAxes();
        // 圆圈贴着雪面左右来回：两头慢、中间快，像手按住往前推
        const s = Math.sin(clock * (Math.PI / 1.4));
        slide.copy(anchor).addScaledVector(right, s * U.handRadius.value * 1.8);
        const c = drawRing(slide);
        if (!c) { pickAnchor(); return; }
        if (toScreen(anchor, sc)) placeTextUnder(sc.x, sc.y + c.ry + 26);
        if (S.engaged && params.mode !== HAND.MOLD) pushTime += dt;
      },
      done: () => pushTime > 0.6,
    },
    menu: {
      enter() {},
      frame() {
        // 面板开着：指「模具」；收着：先指右上角的雪花，让人把面板打开
        const open = document.body.dataset.open === 'panel';
        const btn = open ? document.querySelector('#uibody [data-mode="4"]') : document.getElementById('panelbtn');
        setText(t(open ? 'tour.menu' : 'tour.menu.open'), t(open ? 'tour.menu.k' : 'tour.menu.open.k'));
        pointAt(btn, open ? 'left' : 'below');
      },
      done: () => params.mode === HAND.MOLD,
    },
    place: {
      enter() {
        // 还拿着默认的雪球就换成雪人 —— 这一步说的是「放一个雪人」
        if (params.mold === 0) ui.setMold(SNOWMAN);
        placedAt = S.placedCount;
        pickAnchor();
        setText(t('tour.place'), t('tour.place.k'));
      },
      frame() {
        if (!hasAnchor) { pickAnchor(); return; }
        groundAxes();
        const c = drawRing(anchor);
        if (!c) { pickAnchor(); return; }
        placeTextUnder(c.x, c.y + c.ry + 26);
      },
      done: () => S.placedCount > placedAt,
    },
    photo: {
      enter() {
        // 面板开着的时候右上角只留它自己的图标，相机是收起来的 —— 先把面板收起
        if (document.body.dataset.open === 'panel') document.getElementById('panelbtn').click();
        setText(t('tour.photo'), t('tour.photo.k'));
      },
      frame() { pointAt(document.getElementById('shotbtn'), 'below'); },
      done: () => document.body.classList.contains('viewing'),
    },
  };

  function placeTextUnder(x, y) {
    text.dataset.align = 'center';
    text.style.transform = `translate(${x}px, ${y}px) translate(-50%, 0)`;
    text.style.opacity = '';
  }

  // ---- 流程 ----

  function show(i) {
    step = i;
    const k = STEPS[i];
    root.dataset.step = k;
    clock = 0;
    setFocus(null);
    steps[k].enter();
    skip.textContent = t('tour.skip');
    root.classList.remove('leave');
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
    lastT = now;
    if (step < 0) return;
    clock += dt;
    const s = steps[STEPS[step]];
    s.frame(dt);
    if (!leaving && s.done()) {
      // 做到了：这一步淡出，稍后下一步淡入
      root.classList.add('leave');
      leaving = setTimeout(() => {
        leaving = 0;
        if (step + 1 >= STEPS.length) finish(); else show(step + 1);
      }, 700);
    }
  }

  function finish() {
    markDone();
    clearTimeout(leaving);
    leaving = 0;
    step = -1;
    setFocus(null);
    root.classList.remove('open', 'leave');
    delete root.dataset.step;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function start() {
    clearTimeout(leaving);
    leaving = 0;
    root.classList.add('open');
    lastT = 0;
    if (!raf) raf = requestAnimationFrame(loop);
    show(0);
  }

  skip.onclick = finish;
  // 换语言：当前这一步的字重新取一遍（「换成模具」那一步每帧都在取，不用管）
  const LABEL = { push: 'tour.push', place: 'tour.place', photo: 'tour.photo' };
  onLangChange(() => {
    if (step < 0) return;
    const k = LABEL[STEPS[step]];
    if (k) setText(t(k), t(`${k}.k`));
    skip.textContent = t('tour.skip');
  });

  return { start, finish, get active() { return step >= 0; } };
}
