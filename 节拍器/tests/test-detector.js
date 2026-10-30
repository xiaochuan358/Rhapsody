// 用合成的鼓点测试节拍检测：node tests/test-detector.js
const BeatDetector = require('../js/beat-detector.js');

const SR = 22050;

// 简单的伪随机数，保证每次结果一致
let seed = 1;
function rand() {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647 * 2 - 1;
}

function addKick(buf, t) {
  const start = Math.round(t * SR);
  for (let i = 0; i < SR * 0.25 && start + i < buf.length; i++) {
    const x = i / SR;
    const f = 50 + 100 * Math.exp(-x * 30);
    buf[start + i] += 0.9 * Math.sin(2 * Math.PI * f * x) * Math.exp(-x * 12);
  }
}

// 贝斯音：真实音乐里强拍上常有贝斯/和弦变化，一直持续到小节结束
function addBass(buf, t, freq, len) {
  const start = Math.round(t * SR);
  for (let i = 0; i < SR * len && start + i < buf.length; i++) {
    const x = i / SR;
    const fade = Math.min(1, x * 200, (len - x) * 50);
    buf[start + i] += 0.4 * (Math.sin(2 * Math.PI * freq * x) + 0.5 * Math.sin(4 * Math.PI * freq * x)) * fade * Math.exp(-x);
  }
}

function addNoise(buf, t, len, decay, amp, highpass) {
  const start = Math.round(t * SR);
  let prev = 0;
  for (let i = 0; i < SR * len && start + i < buf.length; i++) {
    const n = rand();
    const v = highpass ? n - prev : n;
    prev = n;
    buf[start + i] += amp * v * Math.exp(-(i / SR) * decay);
  }
}

// pattern: 每小节每拍的乐器，'k' 底鼓, 's' 军鼓, 'b' 贝斯；镲总是在八分音符上
function makeSong({ bpm, meter, bars, pattern, lead = 1.0 }) {
  const beat = 60 / bpm;
  const len = lead + bars * meter * beat + 1;
  const buf = new Float32Array(Math.ceil(len * SR));
  const truth = [];
  for (let b = 0; b < bars * meter; b++) {
    const t = lead + b * beat;
    truth.push(t);
    const what = pattern[b % meter];
    if (what.includes('k')) addKick(buf, t);
    if (what.includes('b')) addBass(buf, t, [55, 73, 62, 49][Math.floor(b / meter) % 4], meter * beat);
    if (what.includes('s')) addNoise(buf, t, 0.2, 25, 0.5, false);
    addNoise(buf, t, 0.05, 80, 0.2, true);
    addNoise(buf, t + beat / 2, 0.05, 80, 0.15, true);
  }
  // 一点持续的和弦垫底，模拟真实音乐
  for (let i = 0; i < buf.length; i++) {
    const x = i / SR;
    buf[i] += 0.05 * (Math.sin(2 * Math.PI * 220 * x) + Math.sin(2 * Math.PI * 277 * x) + Math.sin(2 * Math.PI * 330 * x));
  }
  return { buf, truth };
}

function check(name, song, expect) {
  const t0 = Date.now();
  const r = BeatDetector.analyze(song.buf, SR, { debug: process.env.DEBUG });
  const ms = Date.now() - t0;

  // 每个真实拍 ±20ms 内是否有检测到的拍
  let hit = 0;
  for (const t of song.truth) if (r.beats.some((b) => Math.abs(b - t) < 0.02)) hit++;
  const recall = hit / song.truth.length;

  const firstDown = r.beats[r.downbeat];
  // 强拍应落在每小节第一拍 (真实时间索引是 meter 的倍数)
  const idx = song.truth.findIndex((t) => Math.abs(t - firstDown) < 0.07);
  const downOk = idx >= 0 && idx % expect.meter === 0;

  const bpmOk = Math.abs(r.bpm - expect.bpm) < 0.5;
  const ok = bpmOk && recall > 0.9 && r.meter === expect.meter && downOk;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}: BPM ${r.bpm.toFixed(2)} (期望 ${expect.bpm}), ` +
    `拍号 ${r.meter}/4 (期望 ${expect.meter}/4), 强拍${downOk ? '正确' : '错误'}, ` +
    `命中 ${(recall * 100).toFixed(0)}%, 用时 ${ms}ms`
  );
  return ok;
}

const cases = [
  ['流行 4/4 128 BPM', makeSong({ bpm: 128, meter: 4, bars: 32, pattern: ['kb', 's', 'k', 's'] }), { bpm: 128, meter: 4 }],
  ['摇滚 4/4 96 BPM', makeSong({ bpm: 96, meter: 4, bars: 24, pattern: ['kb', 's', 'k', 's'] }), { bpm: 96, meter: 4 }],
  ['慢歌 4/4 72 BPM', makeSong({ bpm: 72, meter: 4, bars: 16, pattern: ['kb', 's', '', 's'] }), { bpm: 72, meter: 4 }],
  ['华尔兹 3/4 150 BPM', makeSong({ bpm: 150, meter: 3, bars: 40, pattern: ['kb', 's', 's'] }), { bpm: 150, meter: 3 }],
  ['舞曲 4/4 124 BPM (每拍底鼓)', makeSong({ bpm: 124, meter: 4, bars: 32, pattern: ['kb', 'ks', 'k', 'ks'] }), { bpm: 124, meter: 4 }],
  ['快歌 4/4 174 BPM', makeSong({ bpm: 174, meter: 4, bars: 48, pattern: ['kb', 's', 'k', 's'] }), { bpm: 174, meter: 4 }],
];

if (require.main === module) {
  let allOk = true;
  for (const [name, song, expect] of cases) allOk = check(name, song, expect) && allOk;
  process.exit(allOk ? 0 : 1);
}

module.exports = { makeSong, SR };
