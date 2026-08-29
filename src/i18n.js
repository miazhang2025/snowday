/**
 * i18n.js — 中英文切换（默认英文）
 *
 * 用法：
 *   t('b.clear')                      取一条文案
 *   HTML 里写 data-i18n="key"          切换语言时自动填 innerHTML
 *   HTML 里写 data-i18n-title="key"    切换语言时自动填 title
 *   onLangChange(fn)                  面板这种动态生成的内容自己重刷
 */

const STORE_KEY = 'snow.lang';

const DICT = {
  en: {
    'doc.title': 'Snow · Realtime Snow — WebGPU / TSL',
    'brand.name': 'Comrade Noise',
    'brand.sub': 'Realtime Snow · WebGPU + TSL',

    'boot.tip': 'Starting the WebGPU pipeline',
    'boot.nogpu': 'This page needs <b>WebGPU</b>.<br/>Open it in Chrome / Edge 113+ or Safari 18+, '
      + 'and make sure hardware acceleration is on.<br/>'
      + '<span style="opacity:.7">Firefox needs dom.webgpu.enabled in about:config.</span>',
    'boot.failed': 'Startup failed: ',
    'boot.lost': 'The GPU device was lost unexpectedly ({0}). Please reload the page.',

    'panel.title': 'Control',
    'panel.hide': 'Collapse (H)',
    'panel.show': 'Open controls',
    'panel.lang': 'Switch to Chinese',
    'panel.langLabel': '中文',
    'hint.toggle': 'Show / hide controls',
    'hint.show': 'Controls',
    'hint.hide': 'Hide',

    'hint.html':
      '<em>Drag left</em> push snow &nbsp;·&nbsp; <em>Click</em> handprint &nbsp;·&nbsp; '
      + '<em>Right-drag</em> orbit &nbsp;·&nbsp; <em>Middle</em> pan &nbsp;·&nbsp; <em>Wheel</em> zoom<br/>'
      + '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk &nbsp; <kbd>Q</kbd><kbd>E</kbd> down / up '
      + '&nbsp; <kbd>shift</kbd> sprint<br/>'
      + '<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> push / smooth / pile &nbsp; <kbd>[</kbd><kbd>]</kbd> hand '
      + '&nbsp; <kbd>C</kbd> clear &nbsp; <kbd>F</kbd> fill &nbsp; <kbd>space</kbd> snowfall &nbsp; <kbd>H</kbd> panel',

    'g.gesture': 'Gesture',
    'g.snowfall': 'Snowfall',
    'g.accum': 'Accumulation',
    'g.hand': 'Hand',
    'g.env': 'Environment',
    'g.actions': 'Actions',

    'm.push': 'Push',
    'm.smooth': 'Smooth',
    'm.pile': 'Pile',

    's.intensity': 'Intensity',
    's.flakeSize': 'Flake size',
    's.windSpeed': 'Wind',
    's.windDir': 'Wind direction',
    's.turbulence': 'Turbulence',
    's.depth': 'Snow depth',
    's.deposit': 'Deposit rate',
    's.softness': 'Softness',
    's.drift': 'Wind drifts',
    's.cover': 'Fresh snow covers marks',
    's.crust': 'Wind crust',
    's.strata': 'Layer strata',
    's.crumble': 'Edge crumble',
    's.sss': 'Subsurface',
    's.sssDepth': 'Scatter path',
    's.handSize': 'Palm size',
    's.press': 'Press strength',
    's.pile': 'Push pile-up',
    's.spray': 'Powder spray',
    's.timeOfDay': 'Time of day',
    's.overcast': 'Overcast',
    's.fog': 'Fog',
    's.envLight': 'Ambient GI',
    's.hdriMix': 'HDRI amount',
    's.hdriTint': 'HDRI sky tint',
    's.sparkle': 'Sparkle',
    's.crystals': 'Ice crystals',
    's.bloom': 'Bloom',

    'b.clear': 'Clear',
    'b.fill': 'Fill',
    'b.resetView': 'Reset view',
    'b.pauseSnow': 'Pause snow',
    'b.resumeSnow': 'Resume snow',
    'b.defaults': 'Defaults',
    'b.taa': 'TAA',
    'b.ao': 'AO',
    'b.rays': 'Godrays',
    'b.qLow': 'Low',
    'b.qMid': 'Medium',
    'b.qHigh': 'High',

    'st.flakes': 'flakes',
    'st.grid': 'snow grid',
    'st.props': 'props',
    's.hazeHeight': 'Haze height',
    's.vignette': 'Vignette',
    's.lensBlur': 'Edge softness',
  },

  zh: {
    'doc.title': '雪 · Realtime Snow — WebGPU / TSL',
    'brand.name': 'Comrade Noise',   // 品牌名，中英一致
    'brand.sub': '实时雪景 · WebGPU + TSL',

    'boot.tip': '正在启动 WebGPU 渲染管线',
    'boot.nogpu': '这个页面需要 <b>WebGPU</b>。<br/>请用 Chrome / Edge 113+ 或 Safari 18+ 打开，'
      + '并确认没有关闭硬件加速。<br/>'
      + '<span style="opacity:.7">Firefox 需要在 about:config 里开启 dom.webgpu.enabled。</span>',
    'boot.failed': '初始化失败：',
    'boot.lost': 'GPU 设备意外丢失（{0}）。请刷新页面重试。',

    'panel.title': '控制面板',
    'panel.hide': '收起 (H)',
    'panel.show': '展开控制面板',
    'panel.lang': '切换到英文',
    'panel.langLabel': 'EN',
    'hint.toggle': '展开 / 收起操作说明',
    'hint.show': '操作说明',
    'hint.hide': '收起',

    'hint.html':
      '<em>左键拖动</em> 推雪 &nbsp;·&nbsp; <em>轻点</em> 手印 &nbsp;·&nbsp; <em>右键拖动</em> 转视角 '
      + '&nbsp;·&nbsp; <em>中键</em> 平移 &nbsp;·&nbsp; <em>滚轮</em> 缩放<br/>'
      + '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 走动 &nbsp; <kbd>Q</kbd><kbd>E</kbd> 升 / 降 '
      + '&nbsp; <kbd>shift</kbd> 加速<br/>'
      + '<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> 推雪 / 抚平 / 堆雪 &nbsp; <kbd>[</kbd><kbd>]</kbd> 手掌 '
      + '&nbsp; <kbd>C</kbd> 清空 &nbsp; <kbd>F</kbd> 铺满 &nbsp; <kbd>space</kbd> 降雪 &nbsp; <kbd>H</kbd> 面板',

    'g.gesture': '手势',
    'g.snowfall': '降雪',
    'g.accum': '积雪',
    'g.hand': '手',
    'g.env': '环境',
    'g.actions': '操作',

    'm.push': '推雪',
    'm.smooth': '抚平',
    'm.pile': '堆雪',

    's.intensity': '降雪强度',
    's.flakeSize': '雪花大小',
    's.windSpeed': '风力',
    's.windDir': '风向',
    's.turbulence': '湍流飘舞',
    's.depth': '积雪厚度',
    's.deposit': '堆积速度',
    's.softness': '雪的松软度',
    's.drift': '风吹雪起伏',
    's.cover': '新雪掩盖痕迹',
    's.crust': '风壳硬度',
    's.strata': '断面层理',
    's.crumble': '边缘破碎',
    's.sss': '次表面散射',
    's.sssDepth': '散射光程',
    's.handSize': '手掌大小',
    's.press': '按压力度',
    's.pile': '推雪堆积',
    's.spray': '扬起粉雪',
    's.timeOfDay': '时间',
    's.overcast': '阴天程度',
    's.fog': '雾浓度',
    's.envLight': '环境间接光',
    's.hdriMix': 'HDRI 占比',
    's.hdriTint': 'HDRI 天光染色',
    's.sparkle': '雪面闪烁',
    's.crystals': '表层冰晶',
    's.bloom': '辉光',

    'b.clear': '清空雪',
    'b.fill': '铺满雪',
    'b.resetView': '复位视角',
    'b.pauseSnow': '暂停降雪',
    'b.resumeSnow': '继续降雪',
    'b.defaults': '恢复默认',
    'b.taa': '时域抗锯齿',
    'b.ao': '接触遮蔽',
    'b.rays': '体积光轴',
    'b.qLow': '画质低',
    'b.qMid': '画质中',
    'b.qHigh': '画质高',

    'st.flakes': '雪花',
    'st.grid': '积雪网格',
    'st.props': '道具',
    's.hazeHeight': '霾的高度',
    's.vignette': '暗角',
    's.lensBlur': '四角虚化',
  },
};

export const LANGS = ['en', 'zh'];

let lang = 'en';
try {
  const saved = localStorage.getItem(STORE_KEY);
  if (saved && LANGS.includes(saved)) lang = saved;
} catch { /* 隐私模式下没有 localStorage，用默认值就好 */ }

const listeners = new Set();

/** 取一条文案，{0} {1} 会被后面的参数替换 */
export function t(key, ...args) {
  const s = DICT[lang]?.[key] ?? DICT.en[key] ?? key;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => args[i] ?? m) : s;
}

export const getLang = () => lang;
export const otherLang = () => (lang === 'en' ? 'zh' : 'en');

/** 把带 data-i18n / data-i18n-title 的静态节点刷一遍 */
export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.title = t('doc.title');
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}

export function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return;
  lang = next;
  try { localStorage.setItem(STORE_KEY, lang); } catch { /* 忽略 */ }
  applyStatic();
  listeners.forEach((fn) => fn(lang));
}

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
