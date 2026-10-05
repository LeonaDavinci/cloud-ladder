/* 一次性补丁：投影幕布的视频声音（放大 1.5 倍 + 跟幕布一起开合）。
   每处 old 必须**恰好**命中一次，全中才写。 */
import fs from 'node:fs';

const F = 'model.js';
/* model.js 是 CRLF，main.js / audio.js / index.html 是 LF —— 统一按 LF 匹配，
   写完再按原样还原，免得把整个文件换成另一种行尾（git 会报一整片假改动）。 */
const CRLF = fs.readFileSync(F, 'utf8').includes('\r\n');
let s = fs.readFileSync(F, 'utf8').replace(/\r\n/g, '\n');
const OLD = [], NEW = [];
const rep = (o, n) => { OLD.push(o); NEW.push(n); };

/* ---- 1. 视频声音：WebAudio 增益（<video>.volume 上限就是 1，放大只能走增益节点） ---- */
rep(
`  /* 屏幕总亮度 = 视频亮度 × (brightness + emissive) + 点光源打上来的那点漫反射。`,
`  /* ---- 视频声音：放大 1.5 倍（screen.volumeGain） ----
     2026-10-05 用户要求「直接放视频的声音 + 声音放大 50%」。<video>.volume 上限就是 1，
     想真的放大只能过一路 WebAudio 增益节点。
     ⚠ 一旦 createMediaElementSource 接上，这段音频就**只**走这条图 —— 上下文要是
     suspended，整段就静音了。所以这条链只在「点看电视」那个用户手势里现建 / resume，
     并且留兜底：resume 后仍未 running 就拆掉链路退回元素直出（少赚那 50%，但不哑）。 */
  let vaCtx = null, vaSrc = null, vaGain = null;
  const VA_GAIN = +(S.volumeGain !== undefined ? S.volumeGain : 1.5);
  function tvAudioOn(on){
    if(!videoEl) return false;
    try{
      if(on){
        videoEl.muted = false;
        videoEl.volume = 1;
        if(!vaCtx){
          const AC = window.AudioContext || window.webkitAudioContext;
          if(AC){
            vaCtx = new AC();
            vaSrc = vaCtx.createMediaElementSource(videoEl);
            vaGain = vaCtx.createGain();
            vaGain.gain.value = VA_GAIN;
            vaSrc.connect(vaGain);
            vaGain.connect(vaCtx.destination);
          }
        }
        if(vaCtx && vaCtx.state === 'suspended') vaCtx.resume().catch(()=>{});
        if(vaCtx && vaCtx.state !== 'running'){   // 起不来 ⇒ 增益这条路会闷掉，退回直出
          try{ vaSrc.disconnect(); vaGain.disconnect(); }catch(_){}
          vaCtx = vaSrc = vaGain = null;
          return false;
        }
        return true;
      }
      /* 关：先摘增益再静音（元素静音后，WebAudio 那条路不一定跟着停） */
      try{ if(vaGain) vaGain.disconnect(); }catch(_){}
      try{ if(vaSrc)  vaSrc.disconnect();  }catch(_){}
      vaGain = vaSrc = null;
      videoEl.muted = true;
    }catch(e){ /* 建不出来也别掀构建：元素保持未静音，浏览器自己直出 */ }
    return false;
  }
  group.userData.tvAudio = tvAudioOn;

  /* 屏幕总亮度 = 视频亮度 × (brightness + emissive) + 点光源打上来的那点漫反射。`);

/* ---- 2. 幕布开合时同步开合声音 ---- */
rep(
`      else { videoEl.pause(); }
    }
  };`,
`      else { videoEl.pause(); }
    }
    tvAudioOn(v);
  };`);

let ok = true;
OLD.forEach((o, i) => {
  const n = s.split(o).length - 1;
  if(n !== 1){ console.error(`✗ [${i}] 命中 ${n} 次（应为 1）：\n${o.slice(0, 90)}…`); ok = false; }
});
if(!ok){ console.error('ABORT：一处没精确命中，文件未改。'); process.exit(1); }
s = OLD.reduce((acc, o, i) => acc.replace(o, NEW[i]), s);
if(CRLF) s = s.replace(/\n/g, '\r\n');
fs.writeFileSync(F, s, 'utf8');
console.log('✓ model.js 补丁写入成功');
