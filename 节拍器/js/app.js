/* 自动节拍器 —— 界面、播放与节拍声调度 */
(function () {
  'use strict';

  const ANALYSIS_RATE = 22050;
  const LOOKAHEAD = 0.15;   // 提前多少秒安排节拍声
  const TICK_MS = 25;       // 调度器间隔

  const $ = (id) => document.getElementById(id);
  const el = {
    drop: $('drop'), file: $('file'), status: $('status'), player: $('player'),
    songName: $('songName'), bpm: $('bpm'), meter: $('meter'), pulse: $('pulse'),
    beatNum: $('beatNum'), dots: $('dots'), wave: $('wave'), cur: $('cur'), dur: $('dur'),
    play: $('play'), restart: $('restart'), clickToggle: $('clickToggle'), musicToggle: $('musicToggle'),
    musicVol: $('musicVol'), clickVol: $('clickVol'), sound: $('sound'),
    half: $('half'), double: $('double'), meterSel: $('meterSel'),
    downPrev: $('downPrev'), downNext: $('downNext'),
    offMinus: $('offMinus'), offPlus: $('offPlus'), offVal: $('offVal'),
    tap: $('tap'), tapHint: $('tapHint'), tapBpm: $('tapBpm'), tapMinus: $('tapMinus'), tapPlus: $('tapPlus'),
    tapMeter: $('tapMeter'), tapDots: $('tapDots'), metroToggle: $('metroToggle'), tapApply: $('tapApply'),
  };

  const state = {
    ctx: null, musicGain: null, clickGain: null,
    buffer: null,        // 原始音频
    mono: null,          // 22050Hz 单声道，用于分析和画波形
    env: null,           // 起音曲线缓存，调整速度时不用重新计算
    result: null,        // { bpm, beats, meter, downbeat }
    clicks: null,        // { normal, accent } AudioBuffer
    offset: 0,           // 节拍声偏移 (秒)
    clickOn: true, musicOn: true,
    playing: false, source: null, startAt: 0, pausedAt: 0,
    nextBeat: 0, timer: null,
  };

  // ---------- 音频基础 ----------
  function ensureContext() {
    if (state.ctx) return state.ctx;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    state.ctx = ctx;
    state.musicGain = ctx.createGain();
    state.clickGain = ctx.createGain();
    state.musicGain.connect(ctx.destination);
    state.clickGain.connect(ctx.destination);
    applyVolumes();
    buildClicks();
    return ctx;
  }

  function applyVolumes() {
    if (!state.ctx) return;
    state.musicGain.gain.value = state.musicOn ? +el.musicVol.value : 0;
    state.clickGain.gain.value = +el.clickVol.value;
  }

  // 用代码合成节拍声，不需要额外的音频文件
  function synth(duration, fn) {
    const ctx = state.ctx;
    const n = Math.round(ctx.sampleRate * duration);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = fn(i / ctx.sampleRate);
    return buf;
  }

  const SOUNDS = {
    wood: (accent) => {
      const f = accent ? 1250 : 850;
      return synth(0.08, (t) => 0.9 * Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 70));
    },
    beep: (accent) => {
      const f = accent ? 1760 : 1320;
      return synth(0.06, (t) => 0.6 * Math.sin(2 * Math.PI * f * t) * Math.min(1, t * 800) * Math.exp(-t * 40));
    },
    cowbell: (accent) => {
      const k = accent ? 1.25 : 1;
      return synth(0.25, (t) => {
        const a = Math.sign(Math.sin(2 * Math.PI * 540 * k * t));
        const b = Math.sign(Math.sin(2 * Math.PI * 800 * k * t));
        return 0.25 * (a + b) * Math.exp(-t * (t < 0.02 ? 20 : 14));
      });
    },
  };

  function buildClicks() {
    const make = SOUNDS[el.sound.value] || SOUNDS.wood;
    state.clicks = { normal: make(false), accent: make(true) };
  }

  function playClick(when, accent) {
    const src = state.ctx.createBufferSource();
    src.buffer = accent ? state.clicks.accent : state.clicks.normal;
    src.connect(state.clickGain);
    src.start(when);
  }

  // ---------- 读取与分析 ----------
  async function loadFile(file) {
    if (!file) return;
    stop();
    ensureContext();
    setStatus('正在读取 ' + file.name + ' …');
    try {
      const data = await file.arrayBuffer();
      const buffer = await state.ctx.decodeAudioData(data);
      setStatus('正在识别节拍…');

      // 转成 22050Hz 单声道再分析：速度快，节拍检测也不需要更高的采样率
      const len = Math.max(1, Math.ceil(buffer.duration * ANALYSIS_RATE));
      const off = new OfflineAudioContext(1, len, ANALYSIS_RATE);
      const src = off.createBufferSource();
      src.buffer = buffer;
      src.connect(off.destination);
      src.start();
      const rendered = await off.startRendering();
      const mono = rendered.getChannelData(0);

      await nextFrame(); // 让"正在识别"先显示出来
      const t0 = performance.now();
      const env = BeatDetector.onsetEnvelope(mono, ANALYSIS_RATE);
      const result = BeatDetector.analyze(mono, ANALYSIS_RATE, { envelope: env });
      console.log(`分析用时 ${Math.round(performance.now() - t0)}ms`, result);

      if (result.beats.length < 4) throw new Error('没有找到稳定的节拍，可能是纯人声、古典或太短的音频');

      Object.assign(state, { buffer, mono, env, result, pausedAt: 0 });
      el.songName.textContent = file.name.replace(/\.[^.]+$/, '');
      el.dur.textContent = fmtTime(buffer.duration);
      el.drop.classList.add('compact');
      el.drop.querySelector('.drop-main').textContent = '换一首歌';
      el.player.classList.remove('empty');
      setStatus('');
      renderResult();
    } catch (err) {
      console.error(err);
      setStatus('无法处理这个文件：' + (err && err.message ? err.message : err), true);
    }
  }

  function reanalyze(bpm) {
    if (!state.result) return;
    const wasPlaying = state.playing;
    if (wasPlaying) pause();
    state.result = BeatDetector.analyze(state.mono, ANALYSIS_RATE, { envelope: state.env, bpm });
    renderResult();
    if (wasPlaying) play();
  }

  // ---------- 播放 ----------
  function songTime() {
    return state.playing ? state.ctx.currentTime - state.startAt : state.pausedAt;
  }

  function play() {
    if (!state.buffer || state.playing) return;
    stopMetronome();
    const ctx = state.ctx;
    ctx.resume();
    if (state.pausedAt >= state.buffer.duration - 0.05) state.pausedAt = 0;

    const src = ctx.createBufferSource();
    src.buffer = state.buffer;
    src.connect(state.musicGain);
    const when = ctx.currentTime + 0.05;
    src.start(when, state.pausedAt);
    src.onended = () => {
      if (state.source === src && state.playing) { // 自然播放结束
        stopScheduler();
        state.playing = false;
        state.source = null;
        state.pausedAt = 0;
        updatePlayButton();
      }
    };

    state.source = src;
    state.startAt = when - state.pausedAt;
    state.playing = true;
    state.nextBeat = firstBeatAfter(state.pausedAt);
    stopScheduler();
    state.timer = setInterval(schedule, TICK_MS);
    schedule();
    updatePlayButton();
  }

  function pause() {
    if (!state.playing) return;
    state.pausedAt = Math.min(songTime(), state.buffer.duration);
    state.playing = false;
    stopScheduler();
    const src = state.source;
    state.source = null;
    try { src.stop(); } catch (e) { /* 已经停止 */ }
    updatePlayButton();
  }

  function stop() {
    pause();
    state.pausedAt = 0;
  }

  function seek(t) {
    if (!state.buffer) return;
    const was = state.playing;
    pause();
    state.pausedAt = Math.max(0, Math.min(t, state.buffer.duration - 0.01));
    if (was) play();
  }

  function stopScheduler() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  function firstBeatAfter(t) {
    const beats = state.result.beats;
    let lo = 0, hi = beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] + state.offset < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // 节拍声直接排进音频时钟，和音乐一样精确，不受页面卡顿影响
  function schedule() {
    const { ctx, result } = state;
    const horizon = ctx.currentTime + LOOKAHEAD;
    while (state.nextBeat < result.beats.length) {
      const i = state.nextBeat;
      const when = state.startAt + result.beats[i] + state.offset;
      if (when > horizon) break;
      if (state.clickOn && when >= ctx.currentTime - 0.005) playClick(Math.max(when, ctx.currentTime), beatInBar(i) === 0);
      state.nextBeat++;
    }
  }

  function beatInBar(i) {
    const { meter, downbeat } = state.result;
    return (((i - downbeat) % meter) + meter) % meter;
  }

  // ---------- 显示 ----------
  function renderResult() {
    const r = state.result;
    if (!r) return;
    const rounded = Math.round(r.bpm);
    el.bpm.textContent = Math.abs(r.bpm - rounded) < 0.05 ? String(rounded) : r.bpm.toFixed(1);
    el.meter.textContent = r.meter === 6 ? '6/8' : r.meter + '/4';
    el.meterSel.value = String(r.meter);
    el.dots.innerHTML = '';
    for (let i = 0; i < r.meter; i++) {
      const d = document.createElement('span');
      d.className = 'dot' + (i === 0 ? ' first' : '');
      el.dots.appendChild(d);
    }
    if (state.playing) state.nextBeat = firstBeatAfter(songTime() + LOOKAHEAD);
    drawWaveBase();
  }

  function updatePlayButton() {
    el.play.textContent = state.playing ? '❚❚ 暂停' : '▶ 播放';
    el.play.setAttribute('aria-label', state.playing ? '暂停' : '播放');
  }

  function setStatus(text, isError) {
    el.status.hidden = !text;
    el.status.textContent = text;
    el.status.classList.toggle('error', !!isError);
  }

  function fmtTime(s) {
    s = Math.max(0, s);
    return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // 波形底图 (未播放 / 已播放两种颜色)，只在尺寸或结果变化时重画
  const layers = { base: document.createElement('canvas'), played: document.createElement('canvas') };

  function drawWaveBase() {
    if (!state.mono) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(el.wave.clientWidth * dpr));
    const h = Math.max(1, Math.round(el.wave.clientHeight * dpr));
    el.wave.width = w;
    el.wave.height = h;

    const mono = state.mono;
    const peaks = new Float32Array(w);
    const per = mono.length / w;
    let max = 1e-6;
    for (let x = 0; x < w; x++) {
      let m = 0;
      const a = Math.floor(x * per), b = Math.min(mono.length, Math.floor((x + 1) * per));
      for (let i = a; i < b; i += 4) { const v = Math.abs(mono[i]); if (v > m) m = v; }
      peaks[x] = m;
      if (m > max) max = m;
    }

    const dur = state.buffer.duration;
    const r = state.result;
    const pxPerBeat = (w / dur) * (60 / r.bpm);

    for (const [layer, color] of [[layers.base, cssVar('--wave')], [layers.played, cssVar('--wave-played')]]) {
      layer.width = w;
      layer.height = h;
      const g = layer.getContext('2d');
      g.fillStyle = color;
      const mid = h / 2;
      for (let x = 0; x < w; x++) {
        const v = (peaks[x] / max) * (h * 0.42);
        g.fillRect(x, mid - v, 1, Math.max(1, v * 2));
      }
      // 节拍线：强拍贯穿，其他拍只画底部短刻度；太密时只画强拍
      r.beats.forEach((t, i) => {
        const x = Math.round(((t + state.offset) / dur) * w);
        const down = beatInBar(i) === 0;
        if (down) {
          g.fillStyle = cssVar('--accent');
          g.globalAlpha = 0.55;
          g.fillRect(x, 0, Math.max(1, dpr), h);
        } else if (pxPerBeat > 4 * dpr) {
          g.fillStyle = cssVar('--beat');
          g.globalAlpha = 0.7;
          g.fillRect(x, h - 10 * dpr, Math.max(1, dpr), 10 * dpr);
        }
      });
      g.globalAlpha = 1;
    }
  }

  let lastBeatShown = -1;
  function frame() {
    requestAnimationFrame(frame);
    drawMetronome();
    if (!state.result) return;

    // 扣掉输出延迟，让画面和耳朵听到的对上
    const latency = state.playing ? (state.ctx.outputLatency || state.ctx.baseLatency || 0) : 0;
    const t = songTime() - latency;
    const dur = state.buffer.duration;
    el.cur.textContent = fmtTime(Math.min(t, dur));

    // 波形 + 播放头
    const g = el.wave.getContext('2d');
    const w = el.wave.width, h = el.wave.height;
    const x = Math.max(0, Math.min(w, (t / dur) * w));
    g.clearRect(0, 0, w, h);
    g.drawImage(layers.base, 0, 0);
    if (x > 0) g.drawImage(layers.played, 0, 0, x, h, 0, 0, x, h);
    g.fillStyle = cssVar('--text');
    g.fillRect(Math.round(x), 0, Math.max(1, window.devicePixelRatio || 1), h);

    // 当前拍
    const i = firstBeatAfter(t + 1e-4) - 1;
    if (i < 0) {
      el.pulse.classList.remove('hit', 'down');
      return;
    }
    const pos = beatInBar(i);
    const since = t - (state.result.beats[i] + state.offset);
    const hit = state.playing && since < 0.1;
    el.pulse.classList.toggle('hit', hit);
    el.pulse.classList.toggle('down', hit && pos === 0);
    if (i !== lastBeatShown) {
      lastBeatShown = i;
      el.beatNum.textContent = String(pos + 1);
      Array.from(el.dots.children).forEach((d, k) => d.classList.toggle('on', k === pos));
    }
  }

  function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  }

  // ---------- 事件 ----------
  el.file.addEventListener('change', () => loadFile(el.file.files[0]));

  ['dragenter', 'dragover'].forEach((type) => window.addEventListener(type, (e) => {
    e.preventDefault();
    el.drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((type) => window.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'drop' || e.relatedTarget === null) el.drop.classList.remove('over');
  }));
  window.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  el.play.addEventListener('click', () => (state.playing ? pause() : play()));
  el.restart.addEventListener('click', () => seek(0));

  el.clickToggle.addEventListener('click', () => setToggle('clickOn', el.clickToggle, '节拍声'));
  el.musicToggle.addEventListener('click', () => setToggle('musicOn', el.musicToggle, '音乐'));
  function setToggle(key, btn, label) {
    state[key] = !state[key];
    btn.classList.toggle('on', state[key]);
    btn.setAttribute('aria-pressed', String(state[key]));
    btn.textContent = label + (state[key] ? ' 开' : ' 关');
    applyVolumes();
  }

  el.musicVol.addEventListener('input', applyVolumes);
  el.clickVol.addEventListener('input', applyVolumes);
  el.sound.addEventListener('change', () => {
    if (!state.ctx) return;
    buildClicks();
    playClick(state.ctx.currentTime, true); // 试听
  });

  el.wave.addEventListener('click', (e) => {
    if (!state.buffer) return;
    const rect = el.wave.getBoundingClientRect();
    seek(((e.clientX - rect.left) / rect.width) * state.buffer.duration);
  });

  el.half.addEventListener('click', () => reanalyze(state.result.bpm / 2));
  el.double.addEventListener('click', () => reanalyze(state.result.bpm * 2));
  el.meterSel.addEventListener('change', () => {
    if (!state.result) return;
    state.result.meter = +el.meterSel.value;
    state.result.downbeat %= state.result.meter;
    renderResult();
  });
  el.downPrev.addEventListener('click', () => shiftDownbeat(-1));
  el.downNext.addEventListener('click', () => shiftDownbeat(1));
  function shiftDownbeat(d) {
    if (!state.result) return;
    const m = state.result.meter;
    state.result.downbeat = (state.result.downbeat + d + m) % m;
    lastBeatShown = -1;
    renderResult();
  }

  el.offMinus.addEventListener('click', () => nudge(-0.01));
  el.offPlus.addEventListener('click', () => nudge(0.01));
  function nudge(d) {
    state.offset = Math.round((state.offset + d) * 1000) / 1000;
    el.offVal.textContent = Math.round(state.offset * 1000) + ' ms';
    renderResult();
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.code === 'KeyT') {
      if (!e.repeat) tap();
      return;
    }
    if (!state.buffer) return;
    if (e.code === 'Space') {
      e.preventDefault(); // 防止空格同时"按下"当前聚焦的按钮
      if (e.repeat) return;
      state.playing ? pause() : play();
    } else if (e.code === 'ArrowLeft') {
      seek(songTime() - 5);
    } else if (e.code === 'ArrowRight') {
      seek(songTime() + 5);
    } else if (e.code === 'KeyM') {
      setToggle('clickOn', el.clickToggle, '节拍声');
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && (e.target.tagName || '').toLowerCase() === 'button') e.preventDefault();
  });

  // ---------- 手动打拍 ----------
  const TAP_RESET = 2.0;  // 停顿超过 2 秒，重新开始计数
  const TAP_KEEP = 16;    // 只用最近 16 次点击
  const taps = [];        // { at: 音频时钟时间, song: 当时听到的歌曲位置或 null }
  const metro = { running: false, n: 0, nextTime: 0, timer: null, queue: [] };

  function latencyOf(ctx) {
    return ctx.outputLatency || ctx.baseLatency || 0;
  }

  function tapBpm() {
    const v = +el.tapBpm.value;
    return Math.max(30, Math.min(300, v || 120));
  }

  function tapMeter() {
    return +el.tapMeter.value;
  }

  // 对"第几次点击 → 点击时间"做直线拟合：斜率就是每拍时长，截距是第一拍的位置。
  // 比简单平均间隔更抗手抖。
  function fitTaps(key) {
    const n = taps.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    taps.forEach((tp, i) => { sx += i; sy += tp[key]; sxx += i * i; sxy += i * tp[key]; });
    const period = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return { period, first: (sy - period * sx) / n };
  }

  function tap() {
    const ctx = ensureContext();
    ctx.resume();
    const now = ctx.currentTime;
    if (taps.length && now - taps[taps.length - 1].at > TAP_RESET) taps.length = 0;
    // 记录"此刻听到的"歌曲位置，用来把拍子对齐到歌里
    const song = state.playing ? songTime() - latencyOf(ctx) : null;
    taps.push({ at: now, song });
    if (taps.length > TAP_KEEP) taps.shift();

    el.tap.classList.add('hit');
    setTimeout(() => el.tap.classList.remove('hit'), 90);

    if (taps.length < 2) {
      el.tapHint.textContent = '继续点…';
      return;
    }
    const { period, first } = fitTaps('at');
    if (!(period > 0)) return;
    el.tapBpm.value = (60 / period).toFixed(taps.length >= 6 ? 1 : 0);
    el.tapHint.textContent = `已点 ${taps.length} 下` + (taps.length < 4 ? '，多点几下会更准' : '');
    el.tapApply.hidden = !state.buffer;

    // 节拍器正在响：把它的拍点对齐到你点击的位置，第一下算作第一拍
    if (metro.running) {
      const p = 60 / tapBpm();
      const lat = latencyOf(ctx);
      const n = Math.ceil((ctx.currentTime + 0.03 + lat - first) / p);
      metro.n = n;
      metro.nextTime = first + n * p - lat;
    }
  }

  function startMetronome() {
    const ctx = ensureContext();
    ctx.resume();
    if (state.playing) pause();
    metro.running = true;
    metro.n = 0;
    metro.nextTime = ctx.currentTime + 0.05;
    metro.queue = [];
    metro.timer = setInterval(metroTick, TICK_MS);
    metroTick();
    el.metroToggle.textContent = '❚❚ 停止打拍';
  }

  function stopMetronome() {
    if (!metro.running) return;
    metro.running = false;
    clearInterval(metro.timer);
    metro.timer = null;
    metro.queue = [];
    el.metroToggle.textContent = '▶ 开始打拍';
    Array.from(el.tapDots.children).forEach((d) => d.classList.remove('on'));
  }

  function metroTick() {
    const ctx = state.ctx;
    const horizon = ctx.currentTime + LOOKAHEAD;
    while (metro.nextTime < horizon) {
      const pos = metro.n % tapMeter();
      if (metro.nextTime >= ctx.currentTime - 0.005) {
        playClick(Math.max(metro.nextTime, ctx.currentTime), pos === 0);
        metro.queue.push({ t: metro.nextTime, pos });
      }
      metro.n++;
      metro.nextTime += 60 / tapBpm(); // 每次都读当前速度，改 BPM 立刻生效
    }
  }

  function renderTapDots() {
    el.tapDots.innerHTML = '';
    for (let i = 0; i < tapMeter(); i++) {
      const d = document.createElement('span');
      d.className = 'dot' + (i === 0 ? ' first' : '');
      el.tapDots.appendChild(d);
    }
  }

  function drawMetronome() {
    if (!metro.running) return;
    const heard = state.ctx.currentTime - latencyOf(state.ctx);
    let cur = null;
    while (metro.queue.length && metro.queue[0].t <= heard) cur = metro.queue.shift();
    if (cur) Array.from(el.tapDots.children).forEach((d, k) => d.classList.toggle('on', k === cur.pos));
  }

  // 用手动速度重新跟踪这首歌的拍子 (仍然会贴合歌里的鼓点，不会越打越偏)，
  // 如果是边听边点的，第一下点击算作强拍。
  function applyTapsToSong() {
    if (!state.buffer) return;
    reanalyze(tapBpm());
    const r = state.result;
    r.meter = tapMeter();
    if (taps.length >= 2 && taps.every((tp) => tp.song !== null)) {
      const first = fitTaps('song').first;
      let best = 0;
      r.beats.forEach((b, i) => { if (Math.abs(b - first) < Math.abs(r.beats[best] - first)) best = i; });
      r.downbeat = best % r.meter;
    } else {
      r.downbeat %= r.meter;
    }
    lastBeatShown = -1;
    renderResult();
    el.tapHint.textContent = '已应用到这首歌，播放时节拍会按这个速度走';
  }

  el.tap.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // 按下就算，不等松开，延迟更小
    tap();
  });
  el.tap.addEventListener('keydown', (e) => {
    if (e.code === 'Enter') { e.preventDefault(); tap(); }
  });
  el.metroToggle.addEventListener('click', () => (metro.running ? stopMetronome() : startMetronome()));
  el.tapMinus.addEventListener('click', () => { el.tapBpm.value = Math.max(30, Math.round(tapBpm()) - 1); });
  el.tapPlus.addEventListener('click', () => { el.tapBpm.value = Math.min(300, Math.round(tapBpm()) + 1); });
  el.tapBpm.addEventListener('change', () => { el.tapBpm.value = tapBpm(); });
  el.tapMeter.addEventListener('change', renderTapDots);
  el.tapApply.addEventListener('click', applyTapsToSong);
  renderTapDots();

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawWaveBase, 100);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawWaveBase);

  requestAnimationFrame(frame);
})();
