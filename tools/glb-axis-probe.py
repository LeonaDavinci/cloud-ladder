# -*- coding: utf-8 -*-
"""离线量一个 GLB：装到场景里的「朝上轴、被面高度分位、床头在哪一端」。

为什么必须离线算：这两件事决定 scene.json 里的 `bed.model.topFrac` 与 `rotationY`，
用眼睛从截图上是猜不出来的（一张床翻 180° 还是一样像床），而反复改配置截图要几分钟一轮。

**必须把节点变换算进去。** 这是本脚本第一版最大的坑：只读 `node.translation /
rotation / scale` 会漏掉用 `matrix` 写的节点（GLTFExporter 就爱这么写），
于是「模型是不是 Y-up」会判错 —— 实测编辑过的 bed 模型：网格节点自带
`matrix = Rx(+90°)`，原始 POSITION 是 Z-up，装出来却是正的。
⇒ 所以下面按 glTF 规范优先取 `matrix`（**列主序**），否则用 TRS 合成，
   再把每个网格的顶点乘到「场景根」坐标系里量。

输出三件事：
  · 朝上轴 —— 面积加权投影最大的那根轴（一个躺平的床，朝上的总面积远大于侧向）
  · topFrac —— 朝上的面沿 up 轴的高度分布峰值 / 包围盒高度
    （run-time 就是用它把「被面」校准到 surfaceY 上的）
  · 床头朝向 —— 沿两个水平轴切段看「每段最高点」，高的那一端是床头板，
    据此决定 rotationY 该给 +90° 还是 -90°

用法：python tools/glb-axis-probe.py models/bed2.glb [more.glb ...]
"""
import json
import math
import struct
import sys

COMP = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2),
        5125: ('I', 4), 5126: ('f', 4)}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
AX = ['x', 'y', 'z']


def load(p):
    b = open(p, 'rb').read()
    if b[:4] != b'glTF':
        raise SystemExit('%s: 不是二进制 glTF' % p)
    total = struct.unpack('<I', b[8:12])[0]
    off, js, bins = 12, None, []
    while off < total:
        clen, ctype = struct.unpack('<I4s', b[off:off + 8])
        chunk = b[off + 8:off + 8 + clen]
        if ctype == b'JSON':
            js = json.loads(chunk.decode('utf-8'))
        else:
            bins.append(chunk)
        off += 8 + clen
    return js, b''.join(bins)


def read_accessor(js, blob, idx):
    a = js['accessors'][idx]
    bv = js['bufferViews'][a['bufferView']]
    fmt, size = COMP[a['componentType']]
    n = NCOMP[a['type']]
    stride = bv.get('byteStride') or size * n
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    return [struct.unpack_from('<' + fmt * n, blob, base + i * stride) for i in range(a['count'])]


# ---- 4x4（行主序）矩阵工具 -------------------------------------------------
def mat_identity():
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def mat_mul(a, b):
    o = [0.0] * 16
    for r in range(4):
        for c in range(4):
            o[r * 4 + c] = sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
    return o


def mat_from_gltf_colmajor(m):
    """glTF 的 matrix 是列主序：前 4 个数是第一列。"""
    return [m[0], m[4], m[8], m[12],
            m[1], m[5], m[9], m[13],
            m[2], m[6], m[10], m[14],
            m[3], m[7], m[11], m[15]]


def mat_from_trs(t, r, s):
    tx, ty, tz = t or (0, 0, 0)
    x, y, z, w = r or (0, 0, 0, 1)
    sx, sy, sz = s or (1, 1, 1)
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    return [
        (1 - 2 * (yy + zz)) * sx, 2 * (xy - wz) * sy, 2 * (xz + wy) * sz, tx,
        2 * (xy + wz) * sx, (1 - 2 * (xx + zz)) * sy, 2 * (yz - wx) * sz, ty,
        2 * (xz - wy) * sx, 2 * (yz + wx) * sy, (1 - 2 * (xx + yy)) * sz, tz,
        0, 0, 0, 1]


def node_matrix(n):
    if 'matrix' in n:
        return mat_from_gltf_colmajor(n['matrix']), 'matrix'
    return mat_from_trs(n.get('translation'), n.get('rotation'), n.get('scale')), 'trs'


def apply(m, p):
    x, y, z = p
    return (m[0] * x + m[1] * y + m[2] * z + m[3],
            m[4] * x + m[5] * y + m[6] * z + m[7],
            m[8] * x + m[9] * y + m[10] * z + m[11])


def walk(js, blob, node, parent_m, out):
    m, kind = node_matrix(node)
    world = mat_mul(parent_m, m)
    if 'mesh' in node:
        for prim in js['meshes'][node['mesh']]['primitives']:
            pos = read_accessor(js, blob, prim['attributes']['POSITION'])
            idx = ([i[0] for i in read_accessor(js, blob, prim['indices'])]
                   if 'indices' in prim else list(range(len(pos))))
            out.append(('node:%s(%s)' % (node.get('name', '?'), kind),
                        [apply(world, p) for p in pos], idx))
    for c in node.get('children', []):
        walk(js, blob, js['nodes'][c], world, out)


def tri_area_norm(a, b, c):
    u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    cr = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    L = math.sqrt(sum(k * k for k in cr)) or 1e-12
    return L / 2.0, (cr[0] / L, cr[1] / L, cr[2] / L)


def main(path):
    js, blob = load(path)
    roots = js['scenes'][js.get('scene', 0)]['nodes']
    parts = []
    for r in roots:
        walk(js, blob, js['nodes'][r], mat_identity(), parts)
    allpos = [p for _, ps, _ in parts for p in ps]
    lo = [min(p[k] for p in allpos) for k in range(3)]
    hi = [max(p[k] for p in allpos) for k in range(3)]
    dim = [hi[k] - lo[k] for k in range(3)]
    print('== %s' % path)
    print('   场景 %d 个根节点 · %d 个网格块 · %d 顶点'
          % (len(roots), len(parts), len(allpos)))
    for name, _, idx in parts:
        print('      %s  tris=%d' % (name, len(idx) // 3))
    print('   世界包围盒 min=[%.4f %.4f %.4f] max=[%.4f %.4f %.4f] dim=[%.4f %.4f %.4f]'
          % (lo[0], lo[1], lo[2], hi[0], hi[1], hi[2], dim[0], dim[1], dim[2]))

    area = [0.0, 0.0, 0.0]
    faces = []
    for _, pos, idx in parts:
        for t in range(0, len(idx) - 2, 3):
            a, b, c = pos[idx[t]], pos[idx[t + 1]], pos[idx[t + 2]]
            A, n = tri_area_norm(a, b, c)
            cen = ((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3)
            faces.append((A, n, cen))
            for k in range(3):
                area[k] += A * abs(n[k])
    tot = sum(area) or 1
    print('   面积加权投影 x=%.1f%% y=%.1f%% z=%.1f%%'
          % (area[0] / tot * 100, area[1] / tot * 100, area[2] / tot * 100))
    up = max(range(3), key=lambda k: area[k])
    rest = max((k for k in range(3) if k != up), key=lambda k: area[k])
    print('   ⇒ 朝上轴 = %s（%.1f%%，第二名 %s %.1f%%）'
          % (AX[up], area[up] / tot * 100, AX[rest], area[rest] / tot * 100))

    # 朝上的面：两个方向都算一遍，取「离包围盒顶更近」的那个当正方向，
    # 因为被面一定在床的上半部分 —— 这个判据不依赖法线环绕方向。
    for sign, tag in ((1, '+'), (-1, '-')):
        NB = 40
        hist = [0.0] * NB
        for A, n, cen in faces:
            if n[up] * sign < math.cos(math.radians(20)):
                continue
            k = min(NB - 1, int((cen[up] - lo[up]) / dim[up] * NB))
            hist[k] += A
        peak = max(range(NB), key=lambda k: hist[k])
        top3 = sorted(range(NB), key=lambda k: -hist[k])[:3]
        print('   %s%s 为上的朝上面高度分布：峰值 %.3f（%.1f%%）前三 %s'
              % (tag, AX[up], (peak + 0.5) / NB, hist[peak] / (sum(hist) or 1) * 100,
                 ['%.3f/%.1f%%' % (k / NB, hist[k] / (sum(hist) or 1) * 100) for k in top3]))

    horiz = [k for k in range(3) if k != up]
    for k in horiz:
        NS = 10
        tops = [lo[up] - 1e9] * NS
        for p in allpos:
            i = min(NS - 1, int((p[k] - lo[k]) / dim[k] * NS))
            if p[up] > tops[i]:
                tops[i] = p[up]
        print('   沿 %s 轴（%.3f）每段最高点(占高比)：%s'
              % (AX[k], dim[k], ' '.join('%.2f' % ((t - lo[up]) / dim[up]) for t in tops)))


if __name__ == '__main__':
    for p in sys.argv[1:]:
        main(p)
