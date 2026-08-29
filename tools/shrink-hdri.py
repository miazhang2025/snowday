#!/usr/bin/env python3
"""
shrink-hdri.py — 把 Poly Haven 的 4K HDRI 压到上线用的尺寸。

这张 HDRI **只用来烘 PMREM 环境贴图**，从来不直接显示（天空穹顶是程序化的，
见 src/sky.js）。所以它需要的分辨率远低于直觉：

  实测把 4K / 2K / 1K / 512 分别喂进去、固定机位对比渲染结果 ——
  同一张 4K 连载两次的噪声底是 1.16（TAA + 风吹雪缓慢漂移），
  而 2K / 1K / 512 三者相对 4K 都是 ~2.1，彼此之间分辨不出来。
  也就是说 512 都够用；选 1K 只是给以后万一要直接显示留点余量。

  15.02 MB -> 1.42 MB

降采样必须用**盒式**（整数倍平均），不能用双线性：HDR 里太阳只占几个像素、
亮度是背景的上百倍，双线性会把那份能量丢掉，环境光会整体变暗。
盒式是逐字保能量的 —— 实测平均亮度偏差 0.00005%（那点残差来自 half 存储）。

    python tools/shrink-hdri.py
"""

import os, numpy as np, OpenEXR

src = 'assets/winter_lake_01_4k.exr'
with OpenEXR.File(src) as f:
    img = f.channels()['RGB'].pixels.astype(np.float32)
print('原图 %dx%d  峰值 %.1f  文件 %.2f MB'
      % (img.shape[1], img.shape[0], img.max(), os.path.getsize(src)/1e6))

def box(a, f):
    """整数倍盒式降采样。HDR 必须用盒式：它逐字保能量，双线性会把太阳那几个像素丢掉。"""
    h, w = a.shape[0] // f, a.shape[1] // f
    return a[:h*f, :w*f].reshape(h, f, w, f, 3).mean(axis=(1, 3))

base = img.mean(axis=(0, 1), dtype=np.float64)
for f, tag in ((4, '1k'),):
    out = box(img, f)
    dst = f'assets/winter_lake_{tag}.exr'
    # 每次都要新建 header：File 会把 dataWindow 写回这个 dict，复用会带着上一张的尺寸
    OpenEXR.File({'compression': OpenEXR.ZIP_COMPRESSION},
                 {'RGB': out.astype(np.float16)}).write(dst)
    m = out.astype(np.float16).astype(np.float64).mean(axis=(0, 1))
    print(f'  {out.shape[1]:5d}x{out.shape[0]:<5d} {os.path.getsize(dst)/1e6:6.2f} MB   '
          f'平均亮度偏差 {100*np.abs(m-base).max()/base.max():.5f}%   峰值 {out.max():6.1f}')
