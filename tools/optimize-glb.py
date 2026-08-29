#!/usr/bin/env python3
"""
optimize-glb.py — 把 Quixel / Poly Haven 那类「8K 贴图直接塞进 glb」的资产压到能上网的大小。

这类资产 99% 的体积都在贴图上，几何往往只有几百到几万个三角形。所以做三件事：
  1. 按用途分别降分辨率并重新编码
  2. 丢掉引擎用不到的贴图（比如我们的材质路径不读 specular）
  3. 顺手修常见的资产问题：
       - normalTexture 位置上放的其实是灰度 Bump（解出来的法线是废的），可以用 --set-normal 换掉
       - 植被的 alphaMode=BLEND 换成 MASK，才能写深度、进 pre-pass、正常投影

用法：
    python tools/optimize-glb.py assets/tree.glb assets/tree.opt.glb \\
        --albedo 2048 --orm 1024 \\
        --set-normal assets/textures/Aset_wood_stump_L_rfxaw_8K_Normal_LOD0.jpg --normal 2048

    python tools/optimize-glb.py assets/plant.glb assets/plant.opt.glb \\
        --albedo 2048 --orm 512 --mask 0.5 \\
        --set-normal assets/textures/Billboard_8K_Normal.jpg --normal 2048
"""

import argparse
import io
import json
import os
import struct
import sys

from PIL import Image

Image.MAX_IMAGE_PIXELS = None

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942

# 材质里我们关心的贴图槽位；顺序决定报告里的排列
SLOTS = ('baseColor', 'normal', 'orm', 'occlusion', 'emissive')


def read_glb(path):
    raw = open(path, 'rb').read()
    magic, ver, total = struct.unpack('<4sII', raw[:12])
    if magic != b'glTF':
        sys.exit(f'{path} 不是 glb')
    off, chunks = 12, {}
    while off < total:
        clen, ctype = struct.unpack('<II', raw[off:off + 8])
        off += 8
        chunks[ctype] = raw[off:off + clen]
        off += clen
    return json.loads(chunks[JSON_CHUNK].decode('utf-8')), chunks.get(BIN_CHUNK, b'')


def write_glb(path, J, blob):
    js = json.dumps(J, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    blob = bytes(blob) + b'\x00' * ((4 - len(blob) % 4) % 4)
    out = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(blob))
    out += struct.pack('<II', len(js), JSON_CHUNK) + js
    out += struct.pack('<II', len(blob), BIN_CHUNK) + blob
    open(path, 'wb').write(out)


def encode(im, kind, size):
    """按用途选编码。ORM 和法线的通道各自独立，必须关掉色度二次采样。"""
    w, h = im.size
    if size and (w > size or h > size):
        im = im.resize((min(size, w), min(size, h)), Image.LANCZOS)
    buf = io.BytesIO()
    has_alpha = im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info)
    if kind == 'baseColor' and has_alpha:
        im.convert('RGBA').save(buf, 'PNG', optimize=True)
        return buf.getvalue(), 'image/png', im.size
    sub = 0 if kind in ('normal', 'orm', 'occlusion') else 2   # 4:4:4 vs 4:2:0
    q = {'normal': 92, 'orm': 90, 'occlusion': 90}.get(kind, 88)
    im.convert('RGB').save(buf, 'JPEG', quality=q, subsampling=sub, optimize=True, progressive=True)
    return buf.getvalue(), 'image/jpeg', im.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--albedo', type=int, default=2048)
    ap.add_argument('--normal', type=int, default=1024)
    ap.add_argument('--orm', type=int, default=512)
    ap.add_argument('--set-normal', metavar='FILE', help='用这张外部贴图替换/补上 normalTexture')
    ap.add_argument('--mask', type=float, metavar='CUTOFF', help='alphaMode BLEND -> MASK，给定 cutoff')
    ap.add_argument('--keep-ext', action='append', default=[],
                    help='保留某个材质扩展（默认全部丢弃，因为我们的材质路径不读）')
    a = ap.parse_args()

    J, BIN = read_glb(a.src)
    bv = J.get('bufferViews', [])

    def view(i):
        v = bv[i]
        o = v.get('byteOffset', 0)
        return BIN[o:o + v['byteLength']]

    def img_bytes(image_index):
        im = J['images'][image_index]
        return view(im['bufferView']) if 'bufferView' in im else b''

    loose_normal = None
    if a.set_normal:
        loose_normal = open(a.set_normal, 'rb').read()

    # ---- 1. 找出每个材质用到的贴图槽位 ----
    wanted = {}     # key -> (kind, size, source_bytes)   key 用来去重
    mat_slots = []  # [(material, {slot: key})]
    for mt in J.get('materials', []):
        pbr = mt.setdefault('pbrMetallicRoughness', {})
        slots = {}

        def take(slot, holder, name, size):
            if name not in holder:
                return
            ti = holder[name]['index']
            ii = J['textures'][ti]['source']
            key = (slot, ii)
            wanted[key] = (slot, size, img_bytes(ii))
            slots[slot] = key

        take('baseColor', pbr, 'baseColorTexture', a.albedo)
        take('orm', pbr, 'metallicRoughnessTexture', a.orm)
        take('emissive', mt, 'emissiveTexture', a.albedo)

        # occlusion 经常和 metallicRoughness 共用一张（R=AO G=rough B=metal），
        # 共用时不要重复编码，直接指向同一张
        if 'occlusionTexture' in mt:
            oi = mt['occlusionTexture']['index']
            if 'metallicRoughnessTexture' in pbr and oi == pbr['metallicRoughnessTexture']['index']:
                slots['occlusion'] = slots['orm']
            else:
                take('occlusion', mt, 'occlusionTexture', a.orm)
        if loose_normal is not None:
            key = ('normal', '__loose__')
            wanted[key] = ('normal', a.normal, loose_normal)
            slots['normal'] = key
        else:
            take('normal', mt, 'normalTexture', a.normal)

        # 扩展默认全丢（specular / sheen / transmission 等我们的材质路径都不读）
        for name in list(mt.get('extensions', {})):
            if name not in a.keep_ext:
                mt['extensions'].pop(name)
        if not mt.get('extensions'):
            mt.pop('extensions', None)

        if a.mask is not None and mt.get('alphaMode') == 'BLEND':
            mt['alphaMode'] = 'MASK'
            mt['alphaCutoff'] = a.mask

        mat_slots.append((mt, slots))

    J['extensionsUsed'] = [e for e in J.get('extensionsUsed', []) if e in a.keep_ext]
    if not J['extensionsUsed']:
        J.pop('extensionsUsed', None)
    J.pop('extensionsRequired', None)

    # ---- 2. 编码 ----
    print(f'{os.path.basename(a.src)}  {os.path.getsize(a.src)/1e6:.1f} MB')
    encoded = {}
    for key, (kind, size, data) in wanted.items():
        src_im = Image.open(io.BytesIO(data))
        w0, h0 = src_im.size
        blob, mime, (w1, h1) = encode(src_im, kind, size)
        encoded[key] = (blob, mime)
        tag = '(外部)' if key[1] == '__loose__' else ''
        print(f'  {kind:9s}{tag:6s} {w0}x{h0} -> {w1}x{h1}   '
              f'{len(data)/1e6:6.2f} -> {len(blob)/1e6:5.2f} MB  {mime.split("/")[1]}')

    # ---- 3. 重建 images / textures / bufferViews ----
    new_bv, blob = [], bytearray()

    def push(data, extra=None):
        while len(blob) % 4:
            blob.append(0)
        v = {'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)}
        if extra:
            v.update(extra)
        blob.extend(data)
        new_bv.append(v)
        return len(new_bv) - 1

    acc_remap = {}
    for acc in J.get('accessors', []):
        if 'bufferView' in acc and acc['bufferView'] not in acc_remap:
            acc_remap[acc['bufferView']] = None
    for old in sorted(acc_remap):
        extra = {k: bv[old][k] for k in ('byteStride', 'target') if k in bv[old]}
        acc_remap[old] = push(view(old), extra)
    for acc in J.get('accessors', []):
        if 'bufferView' in acc:
            acc['bufferView'] = acc_remap[acc['bufferView']]

    images, textures, tex_of = [], [], {}
    for key, (data, mime) in encoded.items():
        images.append({'name': f'{key[0]}', 'mimeType': mime, 'bufferView': push(data)})
        textures.append({'source': len(images) - 1})
        tex_of[key] = len(textures) - 1

    for mt, slots in mat_slots:
        pbr = mt['pbrMetallicRoughness']
        if 'baseColor' in slots:
            pbr['baseColorTexture']['index'] = tex_of[slots['baseColor']]
        if 'orm' in slots:
            pbr['metallicRoughnessTexture']['index'] = tex_of[slots['orm']]
        if 'emissive' in slots:
            mt['emissiveTexture']['index'] = tex_of[slots['emissive']]
        if 'occlusion' in slots:
            mt['occlusionTexture']['index'] = tex_of[slots['occlusion']]
        elif 'occlusionTexture' in mt:
            mt.pop('occlusionTexture')
        if 'normal' in slots:
            mt.setdefault('normalTexture', {})['index'] = tex_of[slots['normal']]
        elif 'normalTexture' in mt:
            mt.pop('normalTexture')

    J['images'], J['textures'] = images, textures
    J['bufferViews'] = new_bv
    J['buffers'] = [{'byteLength': len(blob)}]
    J.pop('samplers', None)   # 采样器索引已失效，让 glTF 用默认值

    write_glb(a.dst, J, blob)
    print(f'  -> {os.path.basename(a.dst)}  {os.path.getsize(a.dst)/1e6:.2f} MB  '
          f'(原来的 {os.path.getsize(a.src)/os.path.getsize(a.dst):.0f} 分之一)\n')


if __name__ == '__main__':
    main()
