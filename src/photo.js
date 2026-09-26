/**
 * photo.js — 拍照之后的预览页
 *
 * 快门按下之后不再直接下载，而是先把这一张摆出来给人看：
 * 满意再存，不满意关掉接着玩。存盘 / 分享都从这里走。
 *
 * 预览开着的时候 body 上挂 .viewing，ui.js 和 main.js 的快捷键看到它就不接键 ——
 * 不然在预览里按个 C，背后的雪就被清空了。
 */

import { t } from './i18n.js';

const $ = (s) => document.getElementById(s);

let els = null;
let current = null;          // { blob, url, name }
let savedTimer = 0;
let onClosed = null;       // ui.js 要知道预览关了，好把右上角的图标放回来

const p2 = (n) => String(n).padStart(2, '0');

function bind() {
  els = {
    root: $('photo'),
    img: $('phimg'),
    date: $('phdate'),
    save: $('phsave'),
    share: $('phshare'),
    close: $('phclose'),
    flash: $('flash'),
  };
  els.save.onclick = save;
  els.share.onclick = share;
  els.close.onclick = close;
  // 点相纸外面的空白处也算关
  els.root.addEventListener('click', (e) => { if (e.target === els.root) close(); });

  addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && e.target === document.body) { e.preventDefault(); save(); }
  });
}

export const isOpen = () => document.body.classList.contains('viewing');

/** 打开预览。blob 是 canvas.toBlob 拿到的 PNG；关掉时回调 onClose */
export function openPhoto(blob, { onClose } = {}) {
  if (!els) bind();
  onClosed = onClose || null;
  if (current) URL.revokeObjectURL(current.url);

  const d = new Date();
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
    + `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  current = { blob, url: URL.createObjectURL(blob), name: `snow-day-${stamp}.png` };

  els.img.src = current.url;
  els.date.textContent = `${d.getFullYear()}.${p2(d.getMonth() + 1)}.${p2(d.getDate())}`
    + `  ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  paintSave(false);

  // 只有真能分享文件的环境（多半是手机）才露出分享按钮
  const file = new File([blob], current.name, { type: 'image/png' });
  els.share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));

  // 先闪一下白，像按了快门；相纸稍后浮上来
  els.flash.classList.remove('pop');
  void els.flash.offsetWidth;
  els.flash.classList.add('pop');

  document.body.classList.add('viewing');
  els.root.classList.add('open');
  els.save.focus({ preventScroll: true });
}

export function closePhoto() { close(); }

function close() {
  if (!isOpen()) return;
  els.root.classList.remove('open');
  document.body.classList.remove('viewing');
  document.activeElement?.blur?.();
  // 等淡出结束再放掉图片，不然关的那一下相纸会先变空
  const done = current;
  current = null;
  setTimeout(() => { if (done) URL.revokeObjectURL(done.url); }, 500);
  const cb = onClosed;
  onClosed = null;
  cb?.();
}

function save() {
  if (!current) return;
  // 锚点必须真的挂进文档里再点。游离节点上的 download 在 Chrome 上多数时候
  // 能 work，但 Safari / Firefox 会直接吞掉，排查起来毫无线索（什么都不发生）。
  const a = document.createElement('a');
  a.href = current.url;
  a.download = current.name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  console.info(`[snow] 已保存 ${current.name}（${(current.blob.size / 1e6).toFixed(2)}MB）`);
  paintSave(true);
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => paintSave(false), 1600);
}

async function share() {
  if (!current) return;
  const file = new File([current.blob], current.name, { type: 'image/png' });
  try {
    await navigator.share({ files: [file], title: 'Snow Day' });
  } catch (e) {
    // 用户自己取消分享也会走到这里，不算错
    if (e.name !== 'AbortError') console.warn('[snow] 分享失败：', e.message || e);
  }
}

// 按钮是图片（文字画在图里），不能再改 textContent —— 那会把图冲掉。
// 「已保存」就让它停在悬停那张图上一会儿，提示文字换进 title。
function paintSave(saved) {
  els.save.classList.toggle('done', saved);
  els.save.title = t(saved ? 'b.photoSaved' : 'shot.save');
}
