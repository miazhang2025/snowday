/**
 * landing.js — 进场前的落地页
 *
 * 加载完的场景就是落地页的背景：镜头绕着玩雪区慢慢转，雪照常下，
 * 上面只盖一层标题和 ENTER。点进去之后镜头停转、HUD 和面板淡进来。
 *
 * 落地页期间 body 上挂着 .landing —— 各处快捷键看到它就不接键，
 * 画布也被整层盖住，手不会在雪上留印子。
 */

export function initLanding(controls, { onEnter } = {}) {
  const root = document.getElementById('landing');
  const btn = document.getElementById('enterbtn');

  controls.autoRotate = true;
  controls.autoRotateSpeed = -0.35;     // 很慢，一圈差不多三分钟

  let entered = false;
  let blocked = false;
  const enter = () => {
    if (entered || blocked) return;
    entered = true;
    controls.autoRotate = false;
    root.classList.add('leaving', 'gone');
    document.body.classList.remove('landing');
    removeEventListener('keydown', onKey);
    stopTitle();
    onEnter?.();
    // 淡出结束后整层拿掉，免得还挡着画布的命中
    setTimeout(() => { root.style.display = 'none'; }, 1200);
  };

  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(); }
  };

  const stopTitle = initTitleFx();
  btn.onclick = enter;
  addEventListener('keydown', onKey);
  btn.focus({ preventScroll: true });

  /**
   * 实测帧率不够：把 ENTER 换成一段说明 + 「仍然进入」。
   * onAnyway 在点了「仍然进入」之后调（main.js 记下这台机器的选择）。
   */
  function block(html, onAnyway) {
    if (entered) return;
    blocked = true;
    document.getElementById('ldgatemsg').innerHTML = html;
    root.classList.add('blocked');
    document.getElementById('ldgateany').onclick = () => {
      onAnyway?.();
      blocked = false;
      root.classList.remove('blocked');
      enter();
    };
  }

  return { enter, block, get entered() { return entered; } };
}

/**
 * 标题的小互动：
 *   - 鼠标移动时整块标题朝鼠标那边微微倾斜（带点惯性，不是硬跟）
 *   - 点一下标题：弹一下，再从点的位置撒出一把小雪花
 */
function initTitleFx() {
  const tilt = document.getElementById('ldtilt');
  const title = document.getElementById('ldtitle');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
  const onMove = (e) => {
    tx = (e.clientX / innerWidth - 0.5) * 2;
    ty = (e.clientY / innerHeight - 0.5) * 2;
  };
  const tick = () => {
    cx += (tx - cx) * 0.07;
    cy += (ty - cy) * 0.07;
    tilt.style.transform =
      `translate3d(${cx * 14}px, ${cy * 8}px, 0) rotateY(${cx * 9}deg) rotateX(${-cy * 7}deg)`;
    raf = requestAnimationFrame(tick);
  };
  if (!reduce) {
    addEventListener('pointermove', onMove);
    raf = requestAnimationFrame(tick);
  }

  const burst = (x, y) => {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + Math.random() * 0.5;
      const d = 60 + Math.random() * 70;
      const el = document.createElement('i');
      el.className = 'ld-star';
      el.style.setProperty('--x0', `${x - 11}px`);
      el.style.setProperty('--y0', `${y - 11}px`);
      el.style.setProperty('--x1', `${x - 11 + Math.cos(a) * d}px`);
      el.style.setProperty('--y1', `${y - 11 + Math.sin(a) * d}px`);
      el.style.setProperty('--r', `${(Math.random() - 0.5) * 360}deg`);
      el.addEventListener('animationend', () => el.remove());
      document.body.appendChild(el);
    }
  };

  tilt.onclick = (e) => {
    // 重启 boing：先摘掉再强制回流，连点也能每次都弹
    title.classList.remove('boing');
    void title.offsetWidth;
    title.classList.add('boing');
    if (!reduce) burst(e.clientX, e.clientY);
  };
  title.addEventListener('animationend', (e) => {
    if (e.animationName === 'titleIn') title.classList.add('ready');
    if (e.animationName === 'boing') title.classList.remove('boing');
  });

  return () => {
    removeEventListener('pointermove', onMove);
    cancelAnimationFrame(raf);
  };
}
