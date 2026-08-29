/**
 * ui.js — 控制面板 + 快捷键 + 语言切换
 *
 * 面板完全由这里生成。任何一次改动都会 refresh() 一遍 uniform，
 * 再回调 actions.onChange() 让灯光 / 雾 / 辉光跟上。
 * 所有文案走 i18n.js，切换语言时只重刷文字、不重建 DOM，
 * 这样滑杆位置和面板滚动位置都不会跳。
 */

import { params, defaults, refresh, HAND, DAY_START, DAY_END } from './config.js';
import { t, getLang, otherLang, setLang, onLangChange, applyStatic } from './i18n.js';

const $ = (s) => document.querySelector(s);

const GROUPS = [
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
    key: 'g.hand',
    rows: [
      { key: 'handSize', label: 's.handSize', min: 0.25, max: 2.6, step: 0.01, fmt: (v) => `${(v * 100).toFixed(0)} cm` },
      { key: 'press', label: 's.press', min: 0.05, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'pile', label: 's.pile', min: 0, max: 2.2, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'spray', label: 's.spray', min: 0, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
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

  const addGroup = (key) => {
    const el = document.createElement('div');
    el.className = 'grp';
    const h = document.createElement('h3');
    el.appendChild(h);
    groupEls.push({ el: h, key });
    body.appendChild(el);
    return el;
  };

  // ---------------------------------------------------------- 手势

  const gGroup = addGroup('g.gesture');
  const gBtns = document.createElement('div');
  gBtns.className = 'btns';
  [[HAND.PUSH, 'm.push', '1'], [HAND.SMOOTH, 'm.smooth', '2'], [HAND.PILE, 'm.pile', '3']]
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

  // ---------------------------------------------------------- 滑杆

  for (const g of GROUPS) {
    const el = addGroup(g.key);

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
    paintHint();
    actions.onLang?.(getLang());
  }
  onLangChange(applyLang);

  // ---------------------------------------------------------- 左下说明的折叠

  const hintWrap = $('#hintwrap');
  const hintBtn = $('#hinttoggle');
  const HINT_KEY = 'snow.hint';
  let hintOpen = true;
  try { hintOpen = localStorage.getItem(HINT_KEY) !== '0'; } catch { /* 隐私模式 */ }

  function paintHint() {
    hintWrap.classList.toggle('collapsed', !hintOpen);
    hintBtn.textContent = hintOpen ? t('hint.hide') : t('hint.show');
  }
  hintBtn.onclick = () => {
    hintOpen = !hintOpen;
    try { localStorage.setItem(HINT_KEY, hintOpen ? '1' : '0'); } catch { /* 忽略 */ }
    paintHint();
  };

  // ---------------------------------------------------------- 显隐

  const showBtn = $('#showui');
  const togglePanel = (v) => {
    panel.classList.toggle('hidden', !v);
    showBtn.classList.toggle('show', !v);
  };
  $('#hideui').onclick = () => togglePanel(false);
  showBtn.onclick = () => togglePanel(true);

  // ---------------------------------------------------------- 快捷键

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (k === '1') setMode(HAND.PUSH);
    else if (k === '2') setMode(HAND.SMOOTH);
    else if (k === '3') setMode(HAND.PILE);
    else if (k === 'c') actions.onFill(0);
    else if (k === 'f') actions.onFill(params.depth);
    else if (k === 'r') actions.onResetView();
    else if (k === 'h') togglePanel(panel.classList.contains('hidden'));
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
  setMode(params.mode);
  setQuality(params.quality);
  syncAll();
  applyLang();

  return { syncAll, setMode, applyLang };
}
