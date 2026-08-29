#!/usr/bin/env python3
"""
prep-ground.py — 把 Quixel 的地面 surface 压成上线用的两张图。

雪被推开之后露出来的地面，以前是一个常数深色 vec3(0.086,0.079,0.070)。
换成真的 PBR 地表之后，推痕的沟底、陡坡上挂不住雪的地方才有材质感。

输出两张而不是四张：

  ground_albedo.jpg   1024  基础色
  ground_nr.jpg       1024  R,G = 法线的 xy，B = 粗糙度

法线的 z 可以从 xy 反解（z = sqrt(1-x²-y²)），所以第三个通道空着，
正好塞粗糙度进去 —— 少一张贴图、少一次采样、少一个绑定。
但这么打包**必须关掉色度二次采样**（4:4:4），否则 JPEG 会把三个通道
当成颜色去压，法线和粗糙度会互相串味。

AO 图没用：这一套的 AO 几乎全白（平均 0.98），留着纯属浪费带宽。
Displacement 也没用：地面的高度由地形高度场决定，不需要再位移。

    python tools/prep-ground.py
"""

import os
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
SRC = 'assets/textures'
SET = 'pfqqmvp_4K'
SIZE = 1024


def load(name):
    return Image.open(f'{SRC}/{SET}_{name}.jpg').resize((SIZE, SIZE), Image.LANCZOS)


alb = load('Albedo').convert('RGB')
alb.save('assets/ground_albedo.jpg', 'JPEG', quality=88, subsampling=2,
         optimize=True, progressive=True)

nrm = load('Normal').convert('RGB')
rgh = load('Roughness').convert('L')
r, g, _ = nrm.split()
nr = Image.merge('RGB', (r, g, rgh))
nr.save('assets/ground_nr.jpg', 'JPEG', quality=92, subsampling=0,   # 4:4:4，不能串味
        optimize=True, progressive=True)

for f in ('assets/ground_albedo.jpg', 'assets/ground_nr.jpg'):
    print(f'  {f:28s} {SIZE}x{SIZE}  {os.path.getsize(f)/1e6:.2f} MB')

src_total = sum(os.path.getsize(f'{SRC}/{SET}_{n}.jpg')
                for n in ('Albedo', 'Normal', 'Roughness', 'AO', 'Displacement'))
out_total = sum(os.path.getsize(f) for f in
                ('assets/ground_albedo.jpg', 'assets/ground_nr.jpg'))
print(f'  源文件 {src_total/1e6:.1f} MB -> {out_total/1e6:.2f} MB')
