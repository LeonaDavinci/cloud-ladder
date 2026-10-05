/* ============================================================
   梦核 BGM 播放器 + 碰云星铃 + 落地「噗」
   ------------------------------------------------------------
   ① 播放刻意用原生 <audio> 元素，而不是 Web Audio 的 MediaElementSource。
      原因很实际：AudioContext 在「用户手势之前」是 suspended 状态，
      一旦把 <audio> 节点接进 Web Audio 图，整条链路就是哑的 ——
      元素的 currentTime 照样在走、进度条照样动，但一点声音都没有，
      而且「接进去」这个动作不可逆（一个元素只能建一次 source）。
      浏览器对 <audio>.play() 的自动播放拦截是完全另一回事：它拒绝得
      很干脆（Promise reject），手势一到重新 play() 就能出声。
   ② 曲目清单写在 config.json 的 audio.tracks 里（可增删、可调音量）。
      启动固定放 audio.default 指定那首（不写就是清单第一首）；
      file 写成 null 的条目走内置「程序化梦核 pad」兜底 ——
      文件缺失/断网时不会变成一片死寂。
   ③ 音效（碰云星铃、落地「噗」）单独一个 AudioContext，且**首次真正发声时才创建**：
      这样它天然发生在用户手势之后，不会踩到 suspended 的坑。
      两者共用这一路的总音量 SFX.volume；「噗」再乘自己的系数 SFX.poof。
      合成器全在 `poof()` / `bell()` 两个函数里，不依赖任何音频文件 ——
      所以小红书那种禁外部资源的容器里也一样出声。
   ============================================================ */

const clamp01 = v => v < 0 ? 0 : (v > 1 ? 1 : v);

/* 什么都没有时返回一个形状相同的空壳，调用方不用到处判空 */
function noopAudio(reason){
  const api = {
    ok:false, reason, state:'off', index:-1, title:'', tracks:[],
    start(){}, toggle(){}, next(){}, setVolume(){}, chime(){}, poof(){}, dispose(){}
  };
  return api;
}

export function createAudio(A){
  const A0 = A || {};
  const cfg = {
    enabled:  (A0.enabled  !== undefined) ? A0.enabled  : true,
    autoplay: (A0.autoplay !== undefined) ? A0.autoplay : true,
    volume:   (A0.volume   !== undefined) ? A0.volume   : 0.55,
    fadeIn:   (A0.fadeIn   !== undefined) ? A0.fadeIn   : 3.2,
    fadeOut:  (A0.fadeOut  !== undefined) ? A0.fadeOut  : 0.8,
    loop:     (A0.loop     !== undefined) ? A0.loop     : true,
    base:     A0.base || './audio/'
  };
  const tracks = (A0.tracks || []).filter(t => t && (t.file || t.proc));
  if(!cfg.enabled || !tracks.length) return noopAudio('未配置曲目');
  /* 碰云音效（星铃）+ 落到床上那一下的「噗」。
     volume 是这一路的**总音量**（星铃与「噗」共用），poof 是「噗」自己的缩放系数。 */
  const SFX = Object.assign({ enabled:true, volume:0.3, minGap:0.12, root:440, poof:1.0 }, A0.sfx || {});

  /* ---------------- 播放器 ---------------- */
  const el = new Audio();
  el.preload = 'auto';
  el.loop = cfg.loop;
  el.crossOrigin = 'anonymous';
  el.volume = 0;

  let state = 'idle';          // idle | loading | playing | paused | blocked | proc | error
  let index = -1;
  let curGain = 1;             // 当前曲目自己的音量系数
  let fadeRaf = 0;
  let proc = null;             // 程序化兜底播放器
  let tried = 0;               // 连续加载失败次数（用来兜到程序化那首）

  const titleOf = i => (tracks[i] && (tracks[i].title || tracks[i].file)) || '梦核 BGM';

  /* 启动默认放哪一首。config 的 audio.default 可写「清单序号 / 文件名（可只写一段）/ 曲名」，
     解析不出来就退回清单第一首。以前启动是随机抽的 —— 现在固定，
     要换歌只有左上角的 ⏭。 */
  const defIndex = (() => {
    const d = A0.default;
    if(d === undefined || d === null || d === '') return 0;
    if(typeof d === 'number') return (d >= 0 && d < tracks.length) ? d : 0;
    const s = String(d).toLowerCase();
    const eq  = (t, k) => String(t[k] || '').toLowerCase() === s;
    const has = (t, k) => String(t[k] || '').toLowerCase().indexOf(s) >= 0;
    let i = tracks.findIndex(t => eq(t, 'file') || eq(t, 'title'));
    if(i < 0) i = tracks.findIndex(t => has(t, 'file') || has(t, 'title'));
    if(i < 0) i = parseInt(d, 10);
    return (i >= 0 && i < tracks.length) ? i : 0;
  })();

  /* ---------------- 音量渐变 ----------------
     <audio>.volume 只能靠 JS 一点点推，没有 CSS 过渡可用。
     用 rAF 推而不是 setInterval：切标签页时浏览器会停 rAF，
     音量就不会在后台偷偷走完（回来时再从当前值继续）。 */
  function rampTo(target, secs, then){
    cancelAnimationFrame(fadeRaf);
    const from = el.volume;
    if(!(secs > 0)){ el.volume = clamp01(target); if(then) then(); return; }
    const t0 = performance.now();
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / (secs * 1000));
      el.volume = clamp01(from + (target - from) * k);
      if(k < 1) fadeRaf = requestAnimationFrame(tick);
      else if(then) then();
    };
    fadeRaf = requestAnimationFrame(tick);
  }

  function setState(s){ state = s; render(); }

  /* ---------------- 选曲 / 播放 ---------------- */
  function pickRandom(avoid){
    if(tracks.length === 1) return 0;
    let i = index;
    for(let k = 0; k < 20 && (i === index || i === avoid); k++)
      i = Math.floor(Math.random() * tracks.length);
    return i;
  }

  function start(i){
    if(proc) { proc.stop(); proc = null; }
    if(i === undefined || i === null) i = defIndex;
    index = ((i % tracks.length) + tracks.length) % tracks.length;
    tried = 0;
    load();
  }

  function load(){
    const t = tracks[index];
    if(!t){ return; }
    if(!t.file){ return startProc(t); }          // 清单里就是程序化那首
    curGain = (t.gain !== undefined) ? t.gain : 1;
    setState('loading');
    el.src = cfg.base + t.file;
    el.volume = 0;
    el.load();
    play();
  }

  function play(){
    let p = null;
    try{ p = el.play(); }catch(e){ return onFail(e); }
    if(p && p.then) p.then(() => {
      /* 出声了：等真的开始播（readyState 够）再拉音量，免得先响一下再跳 */
      tried = 0;
      setState('playing');
      rampTo(cfg.volume * curGain, cfg.fadeIn);
    }).catch(err => {
      /* NotAllowedError = 自动播放被拦（不是错误，等手势即可）；
         其它（NotFound / 解码失败 / 404）⇒ 换下一首，全试完就兜到程序化。 */
      const name = (err && err.name) || '';
      if(name === 'NotAllowedError' || name === 'AbortError'){ setState('blocked'); armUnlock(); }
      else onFail(err);
    });
  }

  function onFail(err){
    console.warn('[bgm] 曲目加载/播放失败：', titleOf(index), err && (err.message || err));
    tried++;
    if(tried >= tracks.length) return startProc(tracks[0]);
    start((index + 1) % tracks.length);
  }

  el.addEventListener('ended', () => { if(!cfg.loop) next(); });
  el.addEventListener('error', () => { if(state === 'loading' || state === 'playing') onFail(el.error); });

  function next(){
    if(state === 'proc'){ if(proc) proc.stop(); proc = null; }
    if(state === 'playing') return rampTo(0, cfg.fadeOut, () => start(pickRandom(index)));
    start(pickRandom(index));
  }

  function toggle(){
    if(state === 'proc'){ proc && proc.setMuted(!proc.muted); return; }
    if(state === 'playing'){ rampTo(0, cfg.fadeOut, () => { el.pause(); setState('paused'); }); return; }
    if(state === 'paused' || state === 'blocked' || state === 'error' || state === 'idle'){
      if(!el.src) return start();
      setState('loading'); play();
    }
  }

  /* ---------------- 自动播放解锁 ----------------
     浏览器策略：没有用户手势就不给出声。这里挂一组一次性监听，
     手势一出现立刻重试；同时把按钮状态切成「点击播放」提示用户。 */
  let armed = false;
  function armUnlock(){
    if(armed) return;
    armed = true;
    const go = () => {
      window.removeEventListener('pointerdown', go, true);
      window.removeEventListener('keydown', go, true);
      window.removeEventListener('touchstart', go, true);
      armed = false;
      if(state === 'blocked') play();
    };
    window.addEventListener('pointerdown', go, true);
    window.addEventListener('keydown', go, true);
    window.addEventListener('touchstart', go, true);
  }

  /* ---------------- 程序化梦核 pad（兜底） ----------------
     两个变体：A = 漂浮小调 pad，B = 大调七和弦 + 稀疏星铃。
     只在文件全都放不出来时才用，所以不做花哨的自动化，
     只要「慢、糊、有磁带底噪」这三样对味即可。 */
  const CHORDS = {
    a: [[110.00,164.81,220.00,261.63,329.63], [87.31,130.81,174.61,220.00,329.63],
        [130.81,196.00,261.63,329.63,392.00], [98.00,146.83,196.00,246.94,329.63]],
    b: [[146.83,220.00,277.18,369.99], [110.00,164.81,220.00,277.18],
        [123.47,185.00,246.94,311.13], [130.81,196.00,246.94,329.63]]
  };
  const BELL = [0, 2, 4, 7, 9, 12, 14, 16];

  function startProc(t){
    const ctx = sfxCtx(true);
    if(!ctx) return;
    const variant = (t && t.proc === 'b') ? 'b' : 'a';
    const out = ctx.createGain(); out.gain.value = 0;
    const lp  = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1250; lp.Q.value = 0.3;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.037;
    const lfoA = ctx.createGain(); lfoA.gain.value = 380;
    lfo.connect(lfoA); lfoA.connect(lp.frequency); lfo.start();
    lp.connect(out); out.connect(ctx.destination);

    /* 磁带底噪 + 低频气流，音量极小，但正是「梦核」那层灰 */
    const hiss = noiseSrc(ctx, 4);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2600;
    const hg = ctx.createGain(); hg.gain.value = 0.010;
    hiss.connect(hp); hp.connect(hg); hg.connect(out); hiss.start();
    const air = noiseSrc(ctx, 6);
    const alp = ctx.createBiquadFilter(); alp.type = 'lowpass'; alp.frequency.value = 420;
    const ag = ctx.createGain(); ag.gain.value = 0.05;
    air.connect(alp); alp.connect(ag); ag.connect(out); air.start();

    const chords = CHORDS[variant];
    const dur = 13.0;
    let ci = 0, stopped = false;
    const voices = [];
    const playChord = (t0, freqs) => {
      freqs.forEach((f, k) => {
        [0, 5.5].forEach((cents, j) => {
          const o = ctx.createOscillator();
          o.type = (k === 0) ? 'sawtooth' : 'triangle';
          o.frequency.value = f;
          o.detune.value = cents;
          const g = ctx.createGain();
          const amp = (k === 0 ? 0.05 : 0.032) / (1 + j * 0.5);
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.linearRampToValueAtTime(amp, t0 + 3.2);
          g.gain.setValueAtTime(amp, t0 + dur - 4.4);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
          o.connect(g); g.connect(lp);
          o.start(t0); o.stop(t0 + dur + 0.1);
          voices.push(o);
        });
      });
    };
    const tick = () => {
      if(stopped) return;
      const t0 = ctx.currentTime + 0.08;
      playChord(t0, chords[ci % chords.length]);
      if(variant === 'b' && Math.random() < 0.85){
        const f = 440 * Math.pow(2, BELL[(Math.random() * BELL.length) | 0] / 12);
        bell(f, t0 + 3 + Math.random() * 6, 0.10, (Math.random() * 2 - 1) * 0.5, out);
      }
      ci++;
      proc.timer = setTimeout(tick, (dur - 3.2) * 1000);
    };
    proc = {
      muted: false, timer: 0,
      stop(){
        stopped = true; clearTimeout(proc.timer);
        const t0 = ctx.currentTime;
        out.gain.cancelScheduledValues(t0);
        out.gain.setValueAtTime(out.gain.value, t0);
        out.gain.linearRampToValueAtTime(0.0001, t0 + 1.2);
        setTimeout(() => {
          voices.forEach(o => { try{ o.stop(); }catch(_){} });
          try{ hiss.stop(); air.stop(); lfo.stop(); }catch(_){}
          try{ out.disconnect(); }catch(_){}
        }, 1500);
      }
    };
    setState('proc');
    const t0 = ctx.currentTime;
    out.gain.setValueAtTime(0.0001, t0);
    rampTo(0, 0);                            // 清掉 <audio> 那边的渐变
    out.gain.linearRampToValueAtTime(0.9 * cfg.volume, t0 + cfg.fadeIn);
    tick();
  }

  function noiseSrc(ctx, secs){
    const n = Math.floor(ctx.sampleRate * secs);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for(let i = 0; i < n; i++){ last = (last + (Math.random() * 2 - 1) * 0.28) * 0.86; d[i] = last; }
    const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
    return s;
  }

  /* ---------------- 碰云音效：星铃 ----------------
     三根分音（1 / 2.01 / 3.01 倍频）+ 一点点噪声「噗」。
     频点从五声音阶里随机取 ⇒ 怎么点都不会难听。 */
  const sfx = { ctx:null, master:null, last:0, poofs:0 };
  function sfxCtx(force){
    if(sfx.ctx) return sfx.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return null;
    try{
      sfx.ctx = new AC();
      sfx.master = sfx.ctx.createGain();
      sfx.master.gain.value = (SFX.volume !== undefined) ? SFX.volume : 0.3;
      sfx.master.connect(sfx.ctx.destination);
    }catch(e){
      /* 没有音频设备的环境（无头浏览器、极少数移动端）不该把场景带崩 */
      console.warn('[bgm] 音效不可用：', e && e.message);
      sfx.ctx = null; sfx.master = null;
    }
    return sfx.ctx;
  }

  function bell(f, t0, amp, pan, dest){
    const ctx = sfx.ctx; if(!ctx) return;
    const g = ctx.createGain(); g.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 0.4;
    let node = lp;
    if(ctx.createStereoPanner){
      const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0));
      lp.connect(p); node = p;
    }
    g.connect(lp); node.connect(dest || sfx.master);
    [[1, 1.0, 2.6], [2.01, 0.30, 1.7], [3.01, 0.13, 1.0]].forEach(([r, a, d]) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * r;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.linearRampToValueAtTime(amp * a, t0 + 0.012);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      o.connect(og); og.connect(g);
      o.start(t0); o.stop(t0 + d + 0.05);
    });
    g.gain.setValueAtTime(1, t0);
  }

  /* opt: { strength 0~1, pan -1~1, base 频率基准倍率 } */
  function chime(opt){
    if(!SFX.enabled || !cfg.enabled) return;
    const o = opt || {};
    const now = performance.now() / 1000;
    if(now - sfx.last < SFX.minGap) return;
    sfx.last = now;
    const ctx = sfxCtx();
    if(!ctx) return;
    if(ctx.state === 'suspended') ctx.resume();
    const semi = BELL[(Math.random() * BELL.length) | 0] - 12;
    const f = SFX.root * (o.base || 1) * Math.pow(2, semi / 12);
    const amp = Math.min(0.22, 0.06 + (o.strength !== undefined ? o.strength : 0.6) * 0.16);
    bell(f, ctx.currentTime + 0.01, amp, o.pan || 0);
  }

  /* ---------------- 落到床上那一下的「噗」 ----------------
     要的是「身体砸进被子」，不是鼓、也不是铃。所以只做两件事，且都在 0.3 秒内收干：
       ① 气声：一段自身就带衰减的白噪声，低通从 ~1.5kHz 迅速扫到 ~240Hz
          —— 起音是「噗」的气音，尾巴只剩闷响（不扫频的话就是一声「嘶」）。
       ② 体感：155Hz→72Hz 的正弦下滑，给一点「床垫被压下去」的低频。
     没有噪声尾巴、没有高频金属、没有混响 ⇒ 听起来是「闷」的，正好贴着床垫。
     和星铃不同，这一路**不做随机音高**：落地就是落地，每次同一个音，
     变量只有强度（跟着冲击速度走）与声像（跟着落点在画面里的左右走）。
     opt: { strength 0~1, pan -1~1 } */
  function poof(opt){
    if(!SFX.enabled || !cfg.enabled) return;
    const o = opt || {};
    const ctx = sfxCtx();
    if(!ctx) return;
    if(ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime + 0.004;
    const amp = clamp01(o.strength !== undefined ? o.strength : 0.7) * SFX.poof;
    if(amp <= 0.001) return;

    /* 输出段：声像这一级是可选的（极少数环境没有 createStereoPanner） */
    const out = ctx.createGain();
    out.gain.value = 1;
    let tail = out;
    if(ctx.createStereoPanner){
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan || 0));
      out.connect(p); tail = p;
    }
    tail.connect(sfx.master);

    /* ① 气声 */
    const n = Math.floor(ctx.sampleRate * 0.34);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for(let i = 0; i < n; i++){
      const k = i / n;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - k, 1.7);   // 自身就衰减，省一级包络
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.9;
    lp.frequency.setValueAtTime(1500, now);
    lp.frequency.exponentialRampToValueAtTime(240, now + 0.26);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, now);
    ng.gain.linearRampToValueAtTime(0.55 * amp, now + 0.008);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.30);
    src.connect(lp); lp.connect(ng); ng.connect(out);
    src.start(now); src.stop(now + 0.36);

    /* ② 体感 */
    const os = ctx.createOscillator(); os.type = 'sine';
    os.frequency.setValueAtTime(155, now);
    os.frequency.exponentialRampToValueAtTime(72, now + 0.22);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now);
    og.gain.linearRampToValueAtTime(0.42 * amp, now + 0.012);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
    os.connect(og); og.connect(out);
    os.start(now); os.stop(now + 0.30);

    sfx.poofs++;
  }

  /* ---------------- UI ---------------- */
  let host = null, btn = null, ttl = null, ico = null;
  /* 白色描边 SVG 图标：三角(播放) / 双竖条(暂停) / 双三角(换一首)。
     不用系统文字字形（▶ ⏭ 等），全部用 currentColor 描边，纯白。 */
  const ICON = {
    play:  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"><path d="M5.2 3.6 12.6 8 5.2 12.4Z"/></svg>',
    pause: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"><rect x="4.2" y="3.4" width="2.9" height="9.2" rx="0.7"/><rect x="9.0" y="3.4" width="2.9" height="9.2" rx="0.7"/></svg>',
    next:  '<svg viewBox="0 0 16 16" width="14" height="13" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M3 3.5 7.8 8 3 12.5Z"/><path d="M8.4 3.5 13.2 8 8.4 12.5Z"/></svg>'
  };
  function buildUI(){
    host = document.createElement('div');
    host.id = 'bgm';
    host.innerHTML =
      '<button class="bgm-btn" type="button">' +
        '<span class="bgm-ico"></span><span class="bgm-ttl"></span>' +
      '</button>' +
      '<button class="bgm-next" type="button" title="换一首" aria-label="换一首">' + ICON.next + '</button>';
    // 挂进左上角标题栏（#hud-tl）里，排在标题下方；拿不到容器才回落到 body
    (document.getElementById('hud-tl') || document.body).appendChild(host);
    btn = host.querySelector('.bgm-btn');
    ttl = host.querySelector('.bgm-ttl');
    ico = host.querySelector('.bgm-ico');
    btn.addEventListener('click', e => { e.preventDefault(); toggle(); });
    host.querySelector('.bgm-next').addEventListener('click', e => { e.preventDefault(); next(); });
  }
  const TIP = {
    idle:    ['play', '梦核 BGM'],
    loading: ['play', '正在载入'],
    blocked: ['play', '点击播放'],
    playing: ['pause', ''],
    paused:  ['play', '已暂停'],
    proc:    ['play', '内置梦核'],
    error:   ['play', '点击重试']
  };
  function render(){
    if(!host) return;
    const s = TIP[state] || TIP.idle;
    ico.innerHTML = ICON[s[0]] || ICON.play;
    ttl.textContent = (s[1] ? s[1] + ' · ' : '') + titleOf(index);
    host.className = state;
    host.title = state === 'playing'
      ? '正在播放：' + titleOf(index) + '（点击暂停 / ⏭ 换一首）'
      : '梦核 BGM：点击开始';
  }

  /* ---------------- 启动 ---------------- */
  buildUI();
  const api = {
    ok:true, el, tracks, chime, poof, start, next, toggle,
    get poofs(){ return sfx.poofs; },        // 「噗」实际发声次数（无头验证用）
    get state(){ return state; },
    get index(){ return index; },
    get title(){ return titleOf(index); },
    get blocked(){ return state === 'blocked'; },
    setVolume(v){
      cfg.volume = v;
      if(state === 'playing') rampTo(cfg.volume * curGain, 0.4);
      const m = sfx.master; if(m) m.gain.value = SFX.volume;
    },
    dispose(){ try{ el.pause(); el.src = ''; }catch(_){} if(proc) proc.stop(); }
  };
  window.__audio = api;

  if(cfg.autoplay){
    start();                                   // 按 audio.default 起（默认 bgm-1-everything）
    if(state === 'blocked') armUnlock();       // 被拦就先挂着，等第一次交互
  }else{
    render();
  }
  return api;
}
