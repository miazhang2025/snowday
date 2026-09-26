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
    'doc.title': 'Snow Day · Build a Snowman — WebGPU',
    'brand.name': 'Snow Day',
    'brand.sub': 'Realtime Snow · WebGPU',
    'brand.blurb': 'Push the snow around, press a snowman out of a mold, build a castle. '
      + 'Every flake, footprint and shadow is simulated live on your GPU.',

    'boot.tip': 'Letting it snow — starting WebGPU',
    'boot.nogpu': 'This page needs <b>WebGPU</b>.<br/>Open it in Chrome / Edge 113+ or Safari 18+, '
      + 'and make sure hardware acceleration is on.<br/>'
      + '<span style="opacity:.7">Firefox needs dom.webgpu.enabled in about:config.</span>',
    'boot.failed': 'Startup failed: ',
    'boot.lost': 'The GPU device was lost unexpectedly ({0}). Please reload the page.',

    'panel.title': 'Control',
    'panel.hide': 'Collapse (H)',
    'panel.show': 'Open controls',
    'panel.toggle': 'Show / hide controls (H)',
    'panel.lang': 'Switch to Chinese',
    'panel.langLabel': '中文',
    'hint.toggle': 'Show / hide controls',
    'hint.show': 'Controls',
    'hint.hide': 'Hide',
    'hint.photo': 'Take a photo (P)',
    'b.photo': '◉ Photo',
    'b.photoSaved': '✓ Saved',

    'land.enter': 'Enter (↵)',
    'land.foot': 'A quiet place to play in the snow · live on WebGPU',

    'shot.title': 'Snapshot',
    'shot.save': 'Save PNG',
    'shot.share': 'Share',
    'shot.again': 'Keep playing',
    'shot.close': 'Close (Esc)',

    'hint.html': ''
      + '<div class="hk"><span><em>Drag</em></span><b>push snow</b></div>'
      + '<div class="hk"><span><em>Click</em></span><b>handprint</b></div>'
      + '<div class="hk"><span><em>Right-drag</em></span><b>orbit</b></div>'
      + '<div class="hk"><span><em>Middle</em></span><b>pan</b></div>'
      + '<div class="hk"><span><em>Wheel</em></span><b>zoom</b></div>'
      + '<div class="hk"><span><em>Mold</em></span><b>click to press · drag for a row · stack on top</b></div>'
      + '<div class="hk"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><b>walk</b></div>'
      + '<div class="hk"><span><kbd>Q</kbd><kbd>E</kbd></span><b>down / up</b></div>'
      + '<div class="hk"><span><kbd>shift</kbd></span><b>sprint</b></div>'
      + '<div class="hk"><span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd></span><b>push / smooth / pile</b></div>'
      + '<div class="hk"><span><kbd>4</kbd></span><b>mold</b></div>'
      + '<div class="hk"><span><kbd>M</kbd></span><b>next mold</b></div>'
      + '<div class="hk"><span><kbd>,</kbd><kbd>.</kbd></span><b>turn mold</b></div>'
      + '<div class="hk"><span><kbd>[</kbd><kbd>]</kbd></span><b>size</b></div>'
      + '<div class="hk"><span><kbd>C</kbd></span><b>clear</b></div>'
      + '<div class="hk"><span><kbd>F</kbd></span><b>fill</b></div>'
      + '<div class="hk"><span><kbd>space</kbd></span><b>snowfall on / off</b></div>'
      + '<div class="hk"><span><kbd>P</kbd></span><b>photo</b></div>'
      + '<div class="hk"><span><kbd>H</kbd></span><b>control panel</b></div>',

    'g.gesture': 'Gesture',
    'g.snowfall': 'Snowfall',
    'g.accum': 'Accumulation',
    'g.hand': 'Hand',
    'g.mold': 'Snow molds',
    'g.env': 'Environment',
    'g.actions': 'Actions',

    'm.push': 'Push',
    'm.smooth': 'Smooth',
    'm.pile': 'Pile',
    'm.mold': 'Mold',

    'mold.ball': 'Ball',
    'mold.tower': 'Tower',
    'mold.wall': 'Wall',
    'mold.igloo': 'Igloo',
    'mold.spire': 'Spire',
    'mold.star': 'Star',

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
    's.moldSize': 'Mold size',
    's.moldRot': 'Facing',
    's.moldFirm': 'Packing',
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
    'doc.title': '下雪天 · 堆个雪人 —— WebGPU',
    'brand.name': 'Snow Day',   // 品牌名，中英一致
    'brand.sub': '实时降雪 · WebGPU',
    'brand.blurb': '推推雪，用模具扣个雪人，再搭座城堡。'
      + '每一片雪、每一道脚印、每一块阴影，都是显卡当场算出来的。',

    'boot.tip': '正在落雪 —— 启动 WebGPU',
    'boot.nogpu': '这个页面需要 <b>WebGPU</b>。<br/>请用 Chrome / Edge 113+ 或 Safari 18+ 打开，'
      + '并确认没有关闭硬件加速。<br/>'
      + '<span style="opacity:.7">Firefox 需要在 about:config 里开启 dom.webgpu.enabled。</span>',
    'boot.failed': '初始化失败：',
    'boot.lost': 'GPU 设备意外丢失（{0}）。请刷新页面重试。',

    'panel.title': '控制面板',
    'panel.hide': '收起 (H)',
    'panel.show': '展开控制面板',
    'panel.toggle': '展开 / 收起控制面板（H）',
    'panel.lang': '切换到英文',
    'panel.langLabel': 'EN',
    'hint.toggle': '展开 / 收起操作说明',
    'hint.show': '操作说明',
    'hint.hide': '收起',
    'hint.photo': '拍照（P）',
    'b.photo': '◉ 拍照',
    'b.photoSaved': '✓ 已保存',

    'land.enter': '进入（回车）',
    'land.foot': '一个安静玩雪的地方 · WebGPU 实时渲染',

    'shot.title': '拍下的这一张',
    'shot.save': '保存 PNG',
    'shot.share': '分享',
    'shot.again': '继续玩',
    'shot.close': '关闭（Esc）',

    'hint.html': ''
      + '<div class="hk"><span><em>左键拖动</em></span><b>推雪</b></div>'
      + '<div class="hk"><span><em>轻点</em></span><b>手印</b></div>'
      + '<div class="hk"><span><em>右键拖动</em></span><b>转视角</b></div>'
      + '<div class="hk"><span><em>中键</em></span><b>平移</b></div>'
      + '<div class="hk"><span><em>滚轮</em></span><b>缩放</b></div>'
      + '<div class="hk"><span><em>模具</em></span><b>点一下扣一坨 · 拖着连成一排 · 扣在上面往上摞</b></div>'
      + '<div class="hk"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><b>走动</b></div>'
      + '<div class="hk"><span><kbd>Q</kbd><kbd>E</kbd></span><b>降 / 升</b></div>'
      + '<div class="hk"><span><kbd>shift</kbd></span><b>加速</b></div>'
      + '<div class="hk"><span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd></span><b>推雪 / 抚平 / 堆雪</b></div>'
      + '<div class="hk"><span><kbd>4</kbd></span><b>模具</b></div>'
      + '<div class="hk"><span><kbd>M</kbd></span><b>换模具</b></div>'
      + '<div class="hk"><span><kbd>,</kbd><kbd>.</kbd></span><b>模具转向</b></div>'
      + '<div class="hk"><span><kbd>[</kbd><kbd>]</kbd></span><b>大小</b></div>'
      + '<div class="hk"><span><kbd>C</kbd></span><b>清空</b></div>'
      + '<div class="hk"><span><kbd>F</kbd></span><b>铺满</b></div>'
      + '<div class="hk"><span><kbd>space</kbd></span><b>开关降雪</b></div>'
      + '<div class="hk"><span><kbd>P</kbd></span><b>拍照</b></div>'
      + '<div class="hk"><span><kbd>H</kbd></span><b>控制面板</b></div>',

    'g.gesture': '手势',
    'g.snowfall': '降雪',
    'g.accum': '积雪',
    'g.hand': '手',
    'g.mold': '雪模具',
    'g.env': '环境',
    'g.actions': '操作',

    'm.push': '推雪',
    'm.smooth': '抚平',
    'm.pile': '堆雪',
    'm.mold': '模具',

    'mold.ball': '雪球',
    'mold.tower': '塔楼',
    'mold.wall': '城墙',
    'mold.igloo': '雪屋',
    'mold.spire': '尖塔',
    'mold.star': '星形',

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
    's.moldSize': '模具大小',
    's.moldRot': '朝向',
    's.moldFirm': '压实程度',
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
