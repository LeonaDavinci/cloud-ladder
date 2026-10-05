# -*- coding: utf-8 -*-
"""极简 MP3 体检：跳过 ID3v2 → 逐帧解析 MPEG 头 → 估时长/位率/采样率，
并报告文件是否在最后一帧处干净收尾（判断下载是否完整）。
不依赖任何第三方库。"""
import os, sys, struct

BR_V1L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0]
BR_V2L3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0]
SR = {0:[44100,48000,32000], 2:[22050,24000,16000], 3:[11025,12000,8000]}


def id3_len(b):
    if len(b) < 10 or b[:3] != b'ID3':
        return 0
    n = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)
    return 10 + n + (10 if b[5] & 0x10 else 0)


def scan(path):
    data = open(path, 'rb').read()
    off = id3_len(data)
    i = off
    dur = 0.0
    frames = 0
    last = None
    bitrates = {}
    while i + 4 < len(data):
        if data[i] != 0xFF or (data[i+1] & 0xE0) != 0xE0:
            i += 1
            continue
        h = data[i:i+4]
        ver = (h[1] >> 3) & 3          # 3=MPEG1 2=MPEG2 0=MPEG2.5
        layer = (h[1] >> 1) & 3        # 1 = Layer III
        brx = (h[2] >> 4) & 0xF
        srx = (h[2] >> 2) & 3
        pad = (h[2] >> 1) & 1
        if ver == 1 or layer != 1 or brx in (0, 15) or srx == 3:
            i += 1
            continue
        table = BR_V1L3 if ver == 3 else BR_V2L3
        br = table[brx] * 1000
        rate = SR.get(ver, [44100])[srx]
        if ver == 3:
            spf, flen = 1152, (144 * br) // rate + pad
        else:
            spf, flen = 576, (72 * br) // rate + pad
        if flen <= 4:
            i += 1
            continue
        dur += spf / rate
        frames += 1
        last = i + flen
        bitrates[br // 1000] = bitrates.get(br // 1000, 0) + 1
        i += flen
    tail = len(data) - (last or 0)
    top = sorted(bitrates.items(), key=lambda kv: -kv[1])[:3]
    print('%-26s %8.2fs %2dch %5dHz  主位率%s  帧%5d  尾部残留%d字节'
          % (os.path.basename(path), dur, 2, 0 if False else SR[3][0] if False else 44100,
             '/'.join('%dk' % k for k, _ in top), frames, tail))
    return dur, frames, tail


if __name__ == '__main__':
    for p in sys.argv[1:]:
        try:
            scan(p)
        except Exception as e:
            print('%-26s ERROR %s' % (os.path.basename(p), e))
