/**
 * beat-detector.js
 * 纯 JavaScript 的节拍检测：输入单声道 PCM，输出 BPM、每一拍的时间、拍号与强拍位置。
 *
 * 流程：
 *   1. 短时傅里叶变换 (STFT) → 对数幅度谱
 *   2. 频谱通量 (spectral flux) → 起音强度曲线 (onset envelope)
 *   3. 自相关 + 以 120 BPM 为中心的先验 → 估计速度
 *   4. 动态规划节拍跟踪 (Ellis, 2007) → 每一拍的具体位置
 *   5. 节拍强度的周期性 (3 或 4) → 拍号与强拍 (第一拍)
 *
 * 浏览器中挂在 window.BeatDetector，Node 中可 require()。
 */
(function (root) {
  'use strict';

  const N_FFT = 1024;
  const HOP = 256;
  const LOW_BAND_HZ = 200; // 低频带 (底鼓、贝斯)，用于判断强拍
  const BODY_BAND_HZ = 1500; // 鼓和乐器的"主体"频段，不含镲的高频，用于判断倍速/半速

  // ---------- FFT (基 2，原地) ----------
  function makeFFT(n) {
    const levels = Math.log2(n) | 0;
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    return function fft(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >>> 1;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let k = 0; k < half; k++) {
            const a = start + k;
            const b = a + half;
            const wr = cos[k * step];
            const wi = sin[k * step];
            const xr = re[b] * wr - im[b] * wi;
            const xi = re[b] * wi + im[b] * wr;
            re[b] = re[a] - xr; im[b] = im[a] - xi;
            re[a] += xr; im[a] += xi;
          }
        }
      }
    };
  }

  // ---------- 小工具 ----------
  function mean(a) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return a.length ? s / a.length : 0;
  }

  function std(a) {
    const m = mean(a);
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return a.length ? Math.sqrt(s / a.length) : 0;
  }

  function median(arr) {
    if (!arr.length) return 0;
    const s = Array.from(arr).sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // 减去滑动平均并半波整流，去掉响度缓慢变化的影响
  function detrend(x, win) {
    const n = x.length;
    const out = new Float32Array(n);
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
    const h = win >> 1;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - h);
      const b = Math.min(n, i + h + 1);
      const v = x[i] - (prefix[b] - prefix[a]) / (b - a);
      out[i] = v > 0 ? v : 0;
    }
    return out;
  }

  function smooth(x, sigma) {
    const half = Math.ceil(sigma * 3);
    const k = [];
    let ks = 0;
    for (let i = -half; i <= half; i++) { const v = Math.exp(-0.5 * (i / sigma) * (i / sigma)); k.push(v); ks += v; }
    const out = new Float32Array(x.length);
    for (let t = 0; t < x.length; t++) {
      let s = 0;
      for (let i = -half; i <= half; i++) {
        const j = t + i;
        if (j >= 0 && j < x.length) s += x[j] * k[i + half];
      }
      out[t] = s / ks;
    }
    return out;
  }

  function normalize(x) {
    const s = std(x) || 1;
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i] / s;
    return out;
  }

  // ---------- 1+2. 起音强度曲线 ----------
  function onsetEnvelope(samples, sampleRate) {
    const fft = makeFFT(N_FFT);
    const win = new Float64Array(N_FFT);
    for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);

    const nBins = N_FFT / 2 + 1;
    const lowBins = Math.max(2, Math.round((LOW_BAND_HZ * N_FFT) / sampleRate));
    const bodyBins = Math.round((BODY_BAND_HZ * N_FFT) / sampleRate);
    const nFrames = Math.max(1, Math.floor((samples.length - N_FFT) / HOP) + 1);

    const full = new Float32Array(nFrames);
    const low = new Float32Array(nFrames);
    const body = new Float32Array(nFrames);
    const rms = new Float32Array(nFrames);
    // 每帧 1500Hz 以下的对数频谱，用来发现和弦/贝斯的变化 (常发生在小节第一拍)
    const spec = new Float32Array(nFrames * bodyBins);

    const re = new Float64Array(N_FFT);
    const im = new Float64Array(N_FFT);
    let prev = new Float32Array(nBins);
    let cur = new Float32Array(nBins);

    for (let f = 0; f < nFrames; f++) {
      const off = f * HOP;
      let e = 0;
      for (let i = 0; i < N_FFT; i++) {
        const s = samples[off + i] || 0;
        e += s * s;
        re[i] = s * win[i];
        im[i] = 0;
      }
      rms[f] = Math.sqrt(e / N_FFT);
      fft(re, im);

      let fluxAll = 0;
      let fluxLow = 0;
      let fluxBody = 0;
      for (let k = 0; k < nBins; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        cur[k] = Math.log1p(100 * mag);
        if (k >= 1 && k <= bodyBins) spec[f * bodyBins + k - 1] = cur[k];
        if (f > 0) {
          const d = cur[k] - prev[k];
          if (d > 0) {
            fluxAll += d;
            if (k >= 1 && k <= lowBins) fluxLow += d;
            if (k >= 1 && k <= bodyBins) fluxBody += d;
          }
        }
      }
      full[f] = fluxAll;
      low[f] = fluxLow;
      body[f] = fluxBody;
      const t = prev; prev = cur; cur = t;
    }

    const fps = sampleRate / HOP;
    const trendWin = Math.round(fps * 0.5);
    return {
      fps,
      onset: normalize(detrend(full, trendWin)),
      lowOnset: normalize(detrend(low, trendWin)),
      bodyOnset: normalize(detrend(body, trendWin)),
      rms,
      spec,
      specBins: bodyBins,
    };
  }

  // ---------- 3. 速度估计 ----------
  function estimateTempo(onset, fps, opts) {
    const minBpm = opts.minBpm || 50;
    const maxBpm = opts.maxBpm || 220;
    const prior = opts.priorBpm || 120;
    const minLag = Math.max(1, Math.floor((60 * fps) / maxBpm));
    const maxLag = Math.min(onset.length - 1, Math.ceil((60 * fps) / minBpm));
    const HARMONICS = 4;

    // 起音峰值很尖，周期不是整数帧时自相关会忽高忽低，先平滑一下
    const x = smooth(onset, 2);
    const n = x.length;
    const maxAc = Math.min(n - 1, maxLag * HARMONICS + 2);
    const ac = new Float64Array(maxAc + 2);
    for (let lag = 1; lag <= maxAc; lag++) {
      let s = 0;
      for (let t = 0; t + lag < n; t++) s += x[t] * x[t + lag];
      ac[lag] = s / (n - lag);
    }
    const acAt = (l) => {
      const i = Math.floor(l);
      if (i + 1 > maxAc) return 0;
      return ac[i] + (ac[i + 1] - ac[i]) * (l - i);
    };

    // 梳状打分：真正的拍子周期在 1、2、3、4 倍处也都应该相关性高，
    // 这能减少把八分音符 (镲) 当成拍子的"倍速"错误
    const comb = new Float64Array(maxLag + 2);
    for (let lag = Math.max(1, minLag - 1); lag <= maxLag + 1; lag++) {
      let s = 0;
      for (let k = 1; k <= HARMONICS; k++) s += acAt(lag * k) / k;
      comb[lag] = s;
    }

    let best = -Infinity;
    let bestLag = minLag;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = (60 * fps) / lag;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / prior), 2)); // 一个八度的标准差
      const score = comb[lag] * w;
      if (score > best) { best = score; bestLag = lag; }
    }
    const curve = comb;

    // 抛物线插值得到小数周期，BPM 更精确
    let lag = bestLag;
    const y0 = curve[bestLag - 1], y1 = curve[bestLag], y2 = curve[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom < 0) {
      const shift = (0.5 * (y0 - y2)) / denom;
      if (Math.abs(shift) < 1) lag += shift;
    }
    return (60 * fps) / lag;
  }

  // ---------- 4. 动态规划节拍跟踪 ----------
  function trackBeats(onset, fps, bpm, tightness) {
    const n = onset.length;
    const period = (60 * fps) / bpm;
    tightness = tightness || 100;

    // 用高斯窗平滑起音曲线，作为每一帧"适合放一拍"的得分
    const sigma = period / 32;
    const half = Math.max(1, Math.ceil(sigma * 4));
    const kernel = [];
    for (let i = -half; i <= half; i++) kernel.push(Math.exp(-0.5 * (i / sigma) * (i / sigma)));
    const local = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      let s = 0;
      for (let k = -half; k <= half; k++) {
        const j = t + k;
        if (j >= 0 && j < n) s += onset[j] * kernel[k + half];
      }
      local[t] = s;
    }

    const score = new Float64Array(n);
    const back = new Int32Array(n).fill(-1);
    const lo = Math.round(2 * period);
    const hi = Math.max(1, Math.round(period / 2));
    for (let t = 0; t < n; t++) {
      let bestVal = 0;
      let bestPrev = -1;
      for (let p = t - lo; p <= t - hi; p++) {
        if (p < 0) continue;
        const r = Math.log((t - p) / period);
        const v = score[p] - tightness * r * r;
        if (bestPrev < 0 || v > bestVal) { bestVal = v; bestPrev = p; }
      }
      score[t] = local[t] + (bestPrev >= 0 ? bestVal : 0);
      back[t] = bestPrev;
    }

    // 在最后一个周期里找得分最高的帧作为最后一拍，然后回溯
    let last = n - 1;
    let bestEnd = -Infinity;
    for (let t = Math.max(0, n - Math.ceil(period)); t < n; t++) {
      if (score[t] > bestEnd) { bestEnd = score[t]; last = t; }
    }
    const frames = [];
    for (let t = last; t >= 0; t = back[t]) frames.push(t);
    frames.reverse();

    // 去掉开头和结尾处起音很弱的拍 (静音/淡入淡出)
    let sq = 0;
    for (const f of frames) sq += local[f] * local[f];
    const thr = 0.5 * Math.sqrt(sq / Math.max(1, frames.length));
    let a = 0, b = frames.length;
    while (a < b && local[frames[a]] < thr) a++;
    while (b > a && local[frames[b - 1]] < thr) b--;
    return frames.slice(a, b);
  }

  // ---------- 5. 拍号与强拍 ----------
  // 每一拍到下一拍之间的平均频谱，与上一段比较：变化越大越可能是新小节的开始
  function harmonicChange(beatFrames, spec, bins) {
    const n = beatFrames.length;
    const segs = [];
    for (let i = 0; i < n; i++) {
      const a = beatFrames[i];
      const b = i + 1 < n ? beatFrames[i + 1] : a + (a - (beatFrames[i - 1] || 0));
      const v = new Float64Array(bins);
      let cnt = 0;
      for (let f = a; f < b && f * bins < spec.length; f++, cnt++) {
        for (let k = 0; k < bins; k++) v[k] += spec[f * bins + k];
      }
      if (cnt) for (let k = 0; k < bins; k++) v[k] /= cnt;
      segs.push(v);
    }
    const out = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      let dot = 0, na = 0, nb = 0;
      for (let k = 0; k < bins; k++) {
        dot += segs[i][k] * segs[i - 1][k];
        na += segs[i][k] * segs[i][k];
        nb += segs[i - 1][k] * segs[i - 1][k];
      }
      out[i] = na && nb ? 1 - dot / Math.sqrt(na * nb) : 0;
    }
    return out;
  }

  function analyzeMeter(beatFrames, env) {
    const n = beatFrames.length;
    if (n < 8) return { meter: 4, downbeat: 0, confidence: 0 };

    // 每一拍的低频起音 (底鼓、贝斯常落在强拍)。
    // 不用全频段：军鼓的"反拍" (2、4 拍) 往往最响，会把强拍判反。
    const strength = new Float32Array(n);
    for (let i = 0; i < n; i++) strength[i] = peakNear(env.lowOnset, beatFrames[i]);
    // 起音强度 + 和声变化，两种线索各占一半
    const hc = harmonicChange(beatFrames, env.spec, env.specBins);
    const a = normalize(strength);
    const b = normalize(hc);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = a[i] + b[i];

    function bestPhase(m) {
      let best = { contrast: -Infinity, phase: 0 };
      for (let ph = 0; ph < m; ph++) {
        let on = 0, nOn = 0, off = 0, nOff = 0;
        for (let i = 0; i < n; i++) {
          if ((i - ph) % m === 0) { on += s[i]; nOn++; } else { off += s[i]; nOff++; }
        }
        const c = on / Math.max(1, nOn) - off / Math.max(1, nOff);
        if (c > best.contrast) best = { contrast: c, phase: ph };
      }
      return best;
    }

    const four = bestPhase(4);
    const three = bestPhase(3);
    // 4/4 远比 3/4 常见，3/4 需要明显更强的证据
    const pick = three.contrast > four.contrast * 1.25 && three.contrast > 0.3 ? { meter: 3, r: three } : { meter: 4, r: four };
    return {
      meter: pick.meter,
      downbeat: pick.r.phase,
      confidence: Math.max(0, Math.min(1, pick.r.contrast / 1.5)),
    };
  }

  // 取某帧附近 (±2 帧) 的最大值
  function peakNear(x, f) {
    let m = 0;
    for (let k = -2; k <= 2; k++) {
      const j = Math.round(f) + k;
      if (j >= 0 && j < x.length && x[j] > m) m = x[j];
    }
    return m;
  }

  // 倍速/半速纠正：
  //  - 两拍正中间的起音和拍点一样强 → 实际速度应翻倍 (把底鼓 1、3 拍当成了每一拍)
  //  - 拍点一强一弱交替且弱的明显很弱 → 弱的是八分音符，速度应减半
  function checkOctave(frames, onset, tempo, opts) {
    const minBpm = opts.minBpm || 50;
    const maxBpm = opts.maxBpm || 220;
    if (frames.length < 8) return { tempo };
    let onBeat = 0, mid = 0, even = 0, odd = 0;
    for (let i = 0; i < frames.length; i++) {
      const v = peakNear(onset, frames[i]);
      onBeat += v;
      if (i % 2) odd += v; else even += v;
      if (i + 1 < frames.length) mid += peakNear(onset, (frames[i] + frames[i + 1]) / 2);
    }
    onBeat /= frames.length;
    mid /= frames.length - 1;
    const midRatio = mid / (onBeat || 1);
    const altRatio = Math.min(even, odd) / (Math.max(even, odd) || 1);
    if (midRatio > 0.75 && tempo * 2 <= Math.min(maxBpm, 200)) return { tempo: tempo * 2, midRatio, altRatio };
    if (altRatio < 0.6 && tempo / 2 >= minBpm) return { tempo: tempo / 2, midRatio, altRatio };
    return { tempo, midRatio, altRatio };
  }

  // 实际 BPM：对"拍序号 → 时间"做直线拟合，斜率就是每拍时长。
  // 单个间隔只能精确到一帧 (约 12ms)，拟合整首歌可以做到小数点后一位。
  // 先剔除间隔明显异常的地方 (变速、漏拍)，只用稳定的那段。
  function fitBpm(beats) {
    if (beats.length < 4) return 0;
    const intervals = [];
    for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
    const med = median(intervals);
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < beats.length; i++) {
      const okPrev = i === 0 || Math.abs(intervals[i - 1] - med) < med * 0.1;
      const okNext = i === beats.length - 1 || Math.abs(intervals[i] - med) < med * 0.1;
      if (!okPrev && !okNext) continue;
      n++; sx += i; sy += beats[i]; sxx += i * i; sxy += i * beats[i];
    }
    const d = n * sxx - sx * sx;
    if (n < 4 || d === 0) return 60 / med;
    const slope = (n * sxy - sx * sy) / d;
    return slope > 0 ? 60 / slope : 60 / med;
  }

  // 帧只有约 12ms 的精度，拍点会前后抖几毫秒，听起来不够"稳"。
  // 用前后各几拍做直线拟合，把每一拍拉到拟合线上；这样仍然能跟随歌曲里缓慢的速度变化。
  function smoothBeats(beats, radius) {
    radius = radius || 4;
    const n = beats.length;
    if (n < 3) return beats;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - radius);
      const b = Math.min(n - 1, i + radius);
      // 窗口里间隔差太多 (漏拍、突然变速) 就不平滑
      let minGap = Infinity, maxGap = 0;
      for (let k = a + 1; k <= b; k++) {
        const g = beats[k] - beats[k - 1];
        if (g < minGap) minGap = g;
        if (g > maxGap) maxGap = g;
      }
      if (b - a < 2 || maxGap > minGap * 1.15) { out[i] = beats[i]; continue; }
      let c = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let k = a; k <= b; k++) { c++; sx += k; sy += beats[k]; sxx += k * k; sxy += k * beats[k]; }
      const slope = (c * sxy - sx * sy) / (c * sxx - sx * sx);
      out[i] = (sy - slope * sx) / c + slope * i;
    }
    return out;
  }

  /**
   * 主入口
   * @param {Float32Array} samples  单声道 PCM
   * @param {number} sampleRate     建议 22050
   * @param {object} [opts]         { bpm: 指定速度 (跳过估计), minBpm, maxBpm }
   */
  function analyze(samples, sampleRate, opts) {
    opts = opts || {};
    const env = opts.envelope || onsetEnvelope(samples, sampleRate);
    let tempo = opts.bpm || estimateTempo(env.onset, env.fps, opts);
    let frames = trackBeats(env.onset, env.fps, tempo);
    if (!opts.bpm) {
      const fixed = checkOctave(frames, env.bodyOnset, tempo, opts);
      if (opts.debug) console.log('octave check', tempo.toFixed(1), fixed);
      if (fixed.tempo !== tempo) {
        tempo = fixed.tempo;
        frames = trackBeats(env.onset, env.fps, tempo);
      }
    }
    // 帧序号 → 秒。多加一个 HOP：频谱通量是"这一帧减上一帧"，峰值比真实起音早约一帧 (用合成音频实测校准)
    const beats = smoothBeats(frames.map((f) => ((f + 1) * HOP + N_FFT / 2) / sampleRate));

    const bpm = fitBpm(beats) || tempo;

    const meter = analyzeMeter(frames, env);
    return {
      bpm,
      beats,
      meter: meter.meter,
      downbeat: meter.downbeat,
      meterConfidence: meter.confidence,
      envelope: env,
    };
  }

  const api = { analyze, onsetEnvelope, estimateTempo, trackBeats, analyzeMeter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BeatDetector = api;
})(typeof self !== 'undefined' ? self : this);
