/**
 * gate.js — 进门之前看一眼：这台设备带不带得动
 *
 * 这个场景是实打实的 GPU 活：三级 448² 的雪场每帧跑形变、松弛、光线步进，
 * 三万片雪花、级联阴影、TRAA、GTAO…… 在带不动的设备上它不是「慢一点」，
 * 而是几秒一帧、手一动就卡死，第一印象全毁。所以在门口拦一下。
 *
 * 分两关：
 *
 *   1. 静态检查（checkDevice，启动场景**之前**）
 *        手机 / 平板          -> 直接拦，不给进（触屏也没法右键转视角、滚轮缩放）
 *        没有 WebGPU          -> 沿用原来那段提示
 *        软件渲染 / 兜底适配器 / GPU 能力不够 / CPU 太少 / 内存太小 -> 判为性能不足
 *      这一关不过就不初始化场景 —— 手机上把整套东西加载起来再卡死，比直接说明白糟得多。
 *
 *   2. 实测（measureFps，落地页上）
 *      落地页背后就是真场景在跑，拿它的帧率说话，比任何型号表都准。
 *      见 main.js 里的 runProbe：不够就先降画质再测一次，还不够才拦。
 *
 * 「性能不足」给一个「仍然进入」：判断会有误伤（比如测的那两秒刚好别的程序在抢 GPU），
 * 选了之后记在 localStorage 里，同一台机器下次不再拦。手机没有这个选项。
 */

const OVERRIDE_KEY = 'snow.gate.override';

export const MIN_FPS = 30;

export function isOverridden() {
  try { return localStorage.getItem(OVERRIDE_KEY) === '1'; } catch { return false; }
}

export function setOverride() {
  try { localStorage.setItem(OVERRIDE_KEY, '1'); } catch { /* 隐私模式：这次放行就行 */ }
}

/** 手机 / 平板（含伪装成 Mac 的 iPad） */
function isMobile() {
  const ua = navigator.userAgent || '';
  if (navigator.userAgentData?.mobile) return true;
  if (/Android|iPhone|iPod|iPad|Mobile|Windows Phone|BlackBerry|Opera Mini|Silk/i.test(ua)) return true;
  // iPadOS 13+ 默认报桌面版 Safari 的 UA，只能靠触点数认出来
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  // 没有任何「精确指针」（鼠标 / 触控板）的设备：纯触屏
  if (window.matchMedia && !matchMedia('(any-pointer: fine)').matches) return true;
  return false;
}

/** 软件光栅化器：能跑 WebGPU，但全靠 CPU 模拟，这个场景会是个位数帧率 */
const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|lavapipe|basic render|microsoft basic|warp/i;

/**
 * @returns {Promise<{ kind: 'ok'|'mobile'|'nogpu'|'weak', detail?: string }>}
 */
export async function checkDevice() {
  if (isMobile()) return { kind: 'mobile' };
  if (!navigator.gpu) return { kind: 'nogpu' };

  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch { /* 当成没有 */ }
  if (!adapter) return { kind: 'nogpu' };

  const info = adapter.info || {};
  const desc = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ');
  if (adapter.isFallbackAdapter || info.isFallbackAdapter || SOFTWARE_GPU.test(desc)) {
    return { kind: 'weak', detail: desc || 'software renderer' };
  }

  // 这些是场景真的要用到的：每个 pass 8 个 storage buffer（雪场的补格 pass 正好卡在 8）、
  // 256 线程的 workgroup、存得下 2048² 形变图的 buffer
  const L = adapter.limits;
  if (L.maxStorageBuffersPerShaderStage < 8 || L.maxComputeInvocationsPerWorkgroup < 256
    || L.maxStorageBufferBindingSize < 64 * 1024 * 1024) {
    return { kind: 'weak', detail: 'GPU limits' };
  }

  // CPU 和内存：雕塑的网格、射线、手的交互都在主线程上。拿不到这两个数（Safari / Firefox）就不管
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4) {
    return { kind: 'weak', detail: `${navigator.hardwareConcurrency} CPU threads` };
  }
  if (navigator.deviceMemory && navigator.deviceMemory < 4) {
    return { kind: 'weak', detail: `${navigator.deviceMemory} GB RAM` };
  }
  return { kind: 'ok' };
}

/**
 * 量一段时间的帧率（取帧间隔的中位数，不怕偶尔一两帧的长卡顿）。
 * 标签页被切到后台时 rAF 会被节流、两秒里只出了寥寥几帧（主线程被别的活卡住），
 * 这两种量出来的数都不作数 —— 返回 null，由调用方决定要不要重量。
 */
export function measureFps(ms = 2000) {
  return new Promise((resolve) => {
    const dts = [];
    let last = 0;
    let start = 0;
    const tick = (now) => {
      if (document.hidden) { resolve(null); return; }
      if (last) dts.push(now - last);
      else start = now;
      last = now;
      if (now - start < ms) requestAnimationFrame(tick);
      else {
        // 两秒里连 10 帧都没有：不是 GPU 慢，是主线程被什么卡住了（加载、编译……），不作数
        if (dts.length < 10) { resolve(null); return; }
        dts.sort((a, b) => a - b);
        resolve(1000 / dts[dts.length >> 1]);
      }
    };
    requestAnimationFrame(tick);
  });
}
