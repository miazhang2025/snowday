/**
 * ui.js — 控制面板 + 快捷键 + 语言切换
 *
 * 面板完全由这里生成。任何一次改动都会 refresh() 一遍 uniform，
 * 再回调 actions.onChange() 让灯光 / 雾 / 辉光跟上。
 * 所有文案走 i18n.js，切换语言时只重刷文字、不重建 DOM，
 * 这样滑杆位置和面板滚动位置都不会跳。
 */

import { params, defaults, refresh, HAND, DAY_START, DAY_END } from './config.js';
import { MOLDS } from './molds.js';
import { t, getLang, otherLang, setLang, onLangChange, applyStatic } from './i18n.js';
import { openPhoto, closePhoto } from './photo.js';

const $ = (s) => document.querySelector(s);

const GROUPS = [
  {
    key: 'g.hand',
    rows: [
      { key: 'handSize', label: 's.handSize', min: 0.25, max: 2.6, step: 0.01, fmt: (v) => `${(v * 100).toFixed(0)} cm` },
      { key: 'press', label: 's.press', min: 0.05, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'pile', label: 's.pile', min: 0, max: 2.2, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'spray', label: 's.spray', min: 0, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
    ],
  },
  {
    // 模具的按钮由 initUI 插在滑杆前面（moldPicker 这个标记）
    key: 'g.mold',
    moldPicker: true,
    rows: [
      { key: 'moldSize', label: 's.moldSize', min: 0.18, max: 1.8, step: 0.01, fmt: (v) => `${(v * 100).toFixed(0)} cm` },
      { key: 'moldRot', label: 's.moldRot', min: 0, max: 360, step: 1, fmt: (v) => `${Math.round(v)}°` },
      { key: 'moldFirm', label: 's.moldFirm', min: 0, max: 1, step: 0.01, fmt: pct },
    ],
  },
  {
    key: 'g.snowfall',
    rows: [
      { key: 'intensity', label: 's.intensity', min: 0, max: 1, step: 0.01, fmt: pct },
      { key: 'flakeSize', label: 's.flakeSize', min: 0.15, max: 2.0, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'windSpeed', label: 's.windSpeed', min: 0, max: 4, step: 0.05, fmt: (v) => `${v.toFixed(2)} m/s` },
      { key: 'windDir', label: 's.windDir', min: 0, max: 360, step: 1, fmt: (v) => `${Math.round(v)}°` },
      { key: 'turbulence', label: 's.turbulence', min: 0, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
    ],
  },
  {
    key: 'g.accum',
    rows: [
      { key: 'depth', label: 's.depth', min: 0, max: 0.6, step: 0.005, fmt: (v) => `${(v * 100).toFixed(1)} cm` },
      { key: 'deposit', label: 's.deposit', min: 0, max: 1, step: 0.01, fmt: pct },
      { key: 'softness', label: 's.softness', min: 0, max: 1, step: 0.01, fmt: pct },
      { key: 'drift', label: 's.drift', min: 0, max: 1.2, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'cover', label: 's.cover', min: 0, max: 1, step: 0.01, fmt: pct },
      { key: 'crust', label: 's.crust', min: 0, max: 1, step: 0.01, fmt: pct },
      { key: 'strata', label: 's.strata', min: 0, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'crumble', label: 's.crumble', min: 0, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'sss', label: 's.sss', min: 0, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'sssDepth', label: 's.sssDepth', min: 0.2, max: 6, step: 0.05, fmt: (v) => `${v.toFixed(2)} m` },
    ],
  },
  {
    key: 'g.env',
    rows: [
      { key: 'timeOfDay', label: 's.timeOfDay', min: 0, max: 1, step: 0.002, fmt: clockLabel },
      { key: 'overcast', label: 's.overcast', min: 0, max: 1, step: 0.01, fmt: pct },
      { key: 'fog', label: 's.fog', min: 0, max: 0.012, step: 0.0001, fmt: (v) => v.toFixed(4) },
      { key: 'hazeHeight', label: 's.hazeHeight', min: 30, max: 900, step: 5, fmt: (v) => `${v | 0}m` },
      { key: 'envLight', label: 's.envLight', min: 0, max: 1.0, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'hdriMix', label: 's.hdriMix', min: 0, max: 1, step: 0.01, fmt: pct },
      { key: 'hdriTint', label: 's.hdriTint', min: 0, max: 1, step: 0.01, fmt: pct },
      { key: 'sparkle', label: 's.sparkle', min: 0, max: 1.6, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'crystals', label: 's.crystals', min: 0, max: 1, step: 0.01, fmt: pct },
      { key: 'bloom', label: 's.bloom', min: 0, max: 1.4, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'vignette', label: 's.vignette', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'lensBlur', label: 's.lensBlur', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
    ],
  },
];

function pct(v) { return `${Math.round(v * 100)}%`; }

function clockLabel(v) {
  const h = (DAY_START + v * (DAY_END - DAY_START)) % 24;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function initUI(actions) {
  const body = $('#uibody');
  const panel = $('#ui');

  const sliders = new Map();     // paramKey -> { input, paint, nameEl, labelKey }
  const groupEls = [];           // { el, key }
  const staticBtns = [];         // { el, key, shortcut }
  const modeBtns = [];
  const qualityBtns = [];
  let fallBtn = null;

  const commit = () => { refresh(); actions.onChange?.(); };

  const mkBtn = (key, shortcut, fn) => {
    const b = document.createElement('button');
    b.onclick = fn;
    staticBtns.push({ el: b, key, shortcut });
    return b;
  };
  const paintBtn = (rec) => {
    rec.el.innerHTML = rec.shortcut
      ? `${t(rec.key)}<span class="k">${rec.shortcut}</span>`
      : t(rec.key);
  };

  // ---------------------------------------------------------- 分组折叠
  //
  // 七组四十来个滑杆，一屏早就放不下了。每组标题整条都是热区，点一下收起。
  // 状态按组名存进 localStorage，刷新之后还是你上次留下的那个样子 ——
  // 只关心「手上拿着什么」的人不该每次进来都先滚过一遍降雪和环境。

  const GRP_KEY = 'snow.groups';
  let folded = new Set();
  try {
    const raw = localStorage.getItem(GRP_KEY);
    if (raw) folded = new Set(JSON.parse(raw));
  } catch { /* 隐私模式，或者存的是旧格式 —— 当作全展开 */ }

  const addGroup = (key) => {
    const el = document.createElement('div');
    el.className = 'grp';
    if (folded.has(key)) el.classList.add('collapsed');

    // 标题文字单独放一个 span：applyLang 只改它，箭头才不会被 textContent 抹掉
    const h = document.createElement('h3');
    const name = document.createElement('span');
    const caret = document.createElement('i');
    caret.className = 'caret';
    caret.textContent = '▾';
    h.append(name, caret);

    const toggle = () => {
      if (folded.has(key)) folded.delete(key); else folded.add(key);
      el.classList.toggle('collapsed', folded.has(key));
      try { localStorage.setItem(GRP_KEY, JSON.stringify([...folded])); } catch { /* 忽略 */ }
    };
    h.onclick = toggle;
    // 键盘也要能用。这里必须 stopPropagation —— 否则空格会一路冒泡到
    // window 上那个「开关降雪」的快捷键，收个面板顺手把雪停了。
    h.setAttribute('role', 'button');
    h.tabIndex = 0;
    h.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    };

    el.appendChild(h);
    groupEls.push({ el: name, key });
    body.appendChild(el);
    return el;
  };

  // ---------------------------------------------------------- 手势

  const gGroup = addGroup('g.gesture');
  const gBtns = document.createElement('div');
  gBtns.className = 'btns two';
  [[HAND.PUSH, 'm.push', '1'], [HAND.SMOOTH, 'm.smooth', '2'],
    [HAND.PILE, 'm.pile', '3'], [HAND.MOLD, 'm.mold', '4']]
    .forEach(([m, key, sc]) => {
      const b = mkBtn(key, sc, () => setMode(m));
      b.dataset.mode = m;
      modeBtns.push(b);
      gBtns.appendChild(b);
    });
  gGroup.appendChild(gBtns);

  function setMode(m) {
    params.mode = m;
    modeBtns.forEach((b) => b.classList.toggle('on', Number(b.dataset.mode) === m));
    commit();
  }

  // ---------------------------------------------------------- 模具选择
  //
  // 点一个模具就顺手切到模具模式 —— 不然得先按 4 再挑形状，白多一步。

  const moldBtns = [];

  function setMold(i) {
    params.mold = i;
    moldBtns.forEach((b) => b.classList.toggle('on', Number(b.dataset.mold) === i));
    if (params.mode !== HAND.MOLD) setMode(HAND.MOLD);
    else commit();
  }

  const buildMoldPicker = (el) => {
    const row = document.createElement('div');
    row.className = 'btns';
    row.style.marginBottom = '9px';
    row.classList.add('grid6');
    MOLDS.forEach((m, i) => {
      const b = mkBtn(m.key, '', () => setMold(i));
      b.dataset.mold = i;
      moldBtns.push(b);
      row.appendChild(b);
    });
    el.appendChild(row);
  };

  // ---------------------------------------------------------- 滑杆

  for (const g of GROUPS) {
    const el = addGroup(g.key);
    if (g.moldPicker) buildMoldPicker(el);

    for (const r of g.rows) {
      const row = document.createElement('div');
      row.className = 'row';

      const lbl = document.createElement('div');
      lbl.className = 'lbl';
      const nameEl = document.createElement('span');
      const val = document.createElement('b');
      lbl.append(nameEl, val);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = r.min; input.max = r.max; input.step = r.step;
      input.value = params[r.key];

      const paint = () => { val.textContent = r.fmt(params[r.key]); };
      input.addEventListener('input', () => {
        params[r.key] = parseFloat(input.value);
        paint();
        commit();
      });

      paint();
      row.append(lbl, input);
      el.appendChild(row);
      sliders.set(r.key, { input, paint, nameEl, labelKey: r.label });
    }
  }

  // ---------------------------------------------------------- 动作

  const aGroup = addGroup('g.actions');

  const a1 = document.createElement('div');
  a1.className = 'btns';
  a1.append(
    mkBtn('b.clear', 'C', () => actions.onFill(0)),
    mkBtn('b.fill', 'F', () => actions.onFill(params.depth)),
    mkBtn('b.resetView', 'R', () => actions.onResetView()),
  );

  const a2 = document.createElement('div');
  a2.className = 'btns two';
  a2.style.marginTop = '6px';
  fallBtn = mkBtn('b.pauseSnow', '', () => {
    params.falling = !params.falling;
    paintFallBtn();
    commit();
  });
  a2.append(fallBtn, mkBtn('b.defaults', '', () => resetAll()));

  // 后期开关（切换会重建一次管线，有极短的停顿）
  const fxBtns = [];
  const aFx = document.createElement('div');
  aFx.className = 'btns';
  aFx.style.marginTop = '6px';
  [['taa', 'b.taa'], ['ssao', 'b.ao'], ['rays', 'b.rays']].forEach(([key, label]) => {
    const b = mkBtn(label, '', () => {
      params[key] = !params[key];
      b.classList.toggle('on', params[key]);
      commit();
    });
    b.dataset.fx = key;
    fxBtns.push(b);
    aFx.appendChild(b);
  });

  const a3 = document.createElement('div');
  a3.className = 'btns';
  a3.style.marginTop = '6px';
  ['b.qLow', 'b.qMid', 'b.qHigh'].forEach((key, i) => {
    const b = mkBtn(key, '', () => setQuality(i));
    b.dataset.q = i;
    qualityBtns.push(b);
    a3.appendChild(b);
  });

  aGroup.append(a1, a2, aFx, a3);

  function paintFallBtn() {
    const rec = staticBtns.find((s) => s.el === fallBtn);
    rec.key = params.falling ? 'b.pauseSnow' : 'b.resumeSnow';
    paintBtn(rec);
    fallBtn.classList.toggle('on', !params.falling);
  }

  function setQuality(q) {
    params.quality = q;
    qualityBtns.forEach((b) => b.classList.toggle('on', Number(b.dataset.q) === q));
    commit();
    actions.onQuality?.(q);
  }

  function resetAll() {
    Object.assign(params, defaults);
    syncAll();
    commit();
    actions.onQuality?.(params.quality);
  }

  /** 把 params 的当前值刷回所有控件 */
  function syncAll() {
    for (const [key, s] of sliders) {
      s.input.value = params[key];
      s.paint();
    }
    modeBtns.forEach((b) => b.classList.toggle('on', Number(b.dataset.mode) === params.mode));
    moldBtns.forEach((b) => b.classList.toggle('on', Number(b.dataset.mold) === params.mold));
    qualityBtns.forEach((b) => b.classList.toggle('on', Number(b.dataset.q) === params.quality));
    fxBtns.forEach((b) => b.classList.toggle('on', params[b.dataset.fx]));
    paintFallBtn();
  }

  // ---------------------------------------------------------- 语言

  const langBtn = $('#langbtn');
  langBtn.onclick = () => setLang(otherLang());

  /** 只刷文字，不重建 DOM */
  function applyLang() {
    groupEls.forEach(({ el, key }) => { el.textContent = t(key); });
    sliders.forEach((s) => { s.nameEl.textContent = t(s.labelKey); });
    staticBtns.forEach(paintBtn);
    paintFallBtn();
    langBtn.textContent = t('panel.langLabel');
    actions.onLang?.(getLang());
  }
  onLangChange(applyLang);

  // ---------------------------------------------------------- 右上三个图标
  //
  //   #  操作说明     相机  拍照 → 预览     *  控制面板
  //
  // 同一时间只开一样。开了哪个，另外两个图标就收起来，剩下那个就是它的关闭键。
  // 状态写在 body[data-open] 上，CSS 靠它藏图标；panel / help 自己挂 .hidden。

  const help = $('#help');
  let opened = null;

  function setOpen(name) {
    if (opened === 'photo' && name !== 'photo') closePhoto();
    opened = name;
    panel.classList.toggle('hidden', name !== 'panel');
    help.classList.toggle('hidden', name !== 'help');
    if (name) document.body.dataset.open = name;
    else delete document.body.dataset.open;
  }
  const toggle = (name) => setOpen(opened === name ? null : name);

  /** 拍一张。快门要等几帧（让光标环的残影散掉），拿到画面之后
      main.js 回调过来，交给 photo.js 摆出预览页 —— 存不存由人在那里决定。
      按下快门的那一刻就算「开着相机」：面板、说明先收掉。 */
  let shooting = false;
  function doShot() {
    if (shooting) return;
    shooting = true;
    setOpen('photo');
    actions.onShot?.((blob) => {
      shooting = false;
      if (!blob) { setOpen(null); return; }
      openPhoto(blob, { onClose: () => { if (opened === 'photo') setOpen(null); } });
    });
  }

  $('#helpbtn').onclick = () => toggle('help');
  $('#panelbtn').onclick = () => toggle('panel');
  $('#shotbtn').onclick = () => {
    if (opened === 'photo') { if (!shooting) setOpen(null); }
    else doShot();
  };

  // ---------------------------------------------------------- 快捷键

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    // 落地页还没进去、或者正在看照片：这些键都不归面板管
    if (document.body.matches('.landing, .viewing')) return;
    const k = e.key.toLowerCase();
    const molding = params.mode === HAND.MOLD;
    if (k === '1') setMode(HAND.PUSH);
    else if (k === '2') setMode(HAND.SMOOTH);
    else if (k === '3') setMode(HAND.PILE);
    else if (k === '4') setMode(HAND.MOLD);
    else if (k === 'm') setMold((params.mold + 1) % MOLDS.length);
    else if (k === ',' || k === '<') { params.moldRot = (params.moldRot + 345) % 360; syncAll(); commit(); }
    else if (k === '.' || k === '>') { params.moldRot = (params.moldRot + 15) % 360; syncAll(); commit(); }
    else if (k === 'c') actions.onFill(0);
    else if (k === 'f') actions.onFill(params.depth);
    else if (k === 'r') actions.onResetView();
    else if (k === 'p') doShot();
    else if (k === 'h') toggle('panel');
    // 拿着模具的时候 [ ] 调的是模具大小 —— 手不在场上，调手掌没有意义
    else if (k === '[' && molding) { params.moldSize = Math.max(0.18, params.moldSize - 0.08); syncAll(); commit(); }
    else if (k === ']' && molding) { params.moldSize = Math.min(1.8, params.moldSize + 0.08); syncAll(); commit(); }
    else if (k === '[') { params.handSize = Math.max(0.25, params.handSize - 0.1); syncAll(); commit(); }
    else if (k === ']') { params.handSize = Math.min(2.6, params.handSize + 0.1); syncAll(); commit(); }
    else if (k === ' ') {
      e.preventDefault();
      params.falling = !params.falling;
      syncAll();
      commit();
    }
  });

  applyStatic();
  setOpen('panel');
  setMode(params.mode);
  setQuality(params.quality);
  syncAll();
  applyLang();

  return { syncAll, setMode, setMold, setQuality, applyLang };
}
