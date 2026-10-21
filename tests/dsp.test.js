// 박동 검출 알고리즘 테스트 — `node --test tests/` 로 실행해요.
const test = require('node:test');
const assert = require('node:assert');
const { PulseProcessor } = require('../app/heart-sensor.js');
const { synth, score, rng } = require('./synth.js');

function run(o, level = 3, onSample) {
  const s = synth(Object.assign({ seconds: 60 }, o)), p = new PulseProcessor(100, level);
  const steps = (o.dcSteps || []).map(([t]) => Math.round(t * 100));
  const det = [], ok = [];
  for (let n = 0; n < s.x.length; n++) {
    if (steps.includes(n)) p.restart();
    const b = p.push(s.x[n], s.x[n] * 0.7);
    if (b) { det.push(b.idx / 100); if (b.ok) ok.push(b); }
  }
  return { s, p, det, ok };
}

const cases = [
  ['평상시 72 BPM', { hr: 72 }],
  ['느린 심박 45 BPM', { hr: 45 }],
  ['빠른 심박 150 BPM', { hr: 150 }],
  ['심박이 65→120으로 오름', { hr: t => 65 + 55 * Math.min(1, t / 40) }],
  ['아주 약한 맥박 (관류지수 0.1%)', { hr: 75, pi: 0.001, noise: 25 }],
  ['약하고 잡음 많음', { hr: 75, pi: 0.002, noise: 60 }],
  ['이완기 물결이 큼 (중복맥)', { hr: 55, dicrotic: 0.8 }],
  ['느린 심박 + 중복맥', { hr: 40, dicrotic: 0.6 }],
  ['호흡 출렁임 1%', { hr: 70, pi: 0.004, wander: 1 }],
  ['심박 변이가 큼', { hr: 70, hrv: 0.12 }],
  ['조기 박동', { hr: 70, premature: [10.3, 25.2, 40.1] }]
];

for (const level of [1, 3, 5]) {
  for (const [name, o] of cases) {
    test(`민감도 ${level} · ${name}`, () => {
      const { s, det } = run(o, level);
      const sc = score(det, s.beats, { to: 59 });
      assert.ok(sc.se >= 0.94, `놓친 박동이 많아요: Se ${(sc.se * 100).toFixed(1)}%`);
      assert.ok(sc.ppv >= 0.97, `잘못 센 박동이 많아요: PPV ${(sc.ppv * 100).toFixed(1)}%`);
    });
  }
}

test('움직임 구간 밖에서는 정확하고, 움직이는 동안 박동을 지어내지 않아요', () => {
  const o = { hr: 75, motion: [[15, 18, 0.15], [35, 39, 0.08]] };
  const { s, det } = run(o);
  const clean = score(det, s.beats, { to: 59, exclude: [[14.5, 21], [34.5, 42]] });
  assert.ok(clean.se >= 0.97 && clean.ppv >= 0.99, JSON.stringify(clean));
  assert.ok(score(det, s.beats, { to: 59 }).ppv >= 0.95);
});

test('LED 밝기가 바뀌어도 2초 안에 다시 박동을 잡아요', () => {
  const { s, det } = run({ hr: 75, dcSteps: [[20, 1.5], [40, 0.6]] });
  const sc = score(det, s.beats, { to: 59, exclude: [[19.6, 22], [39.6, 42]] });
  assert.ok(sc.se >= 0.99 && sc.ppv >= 0.99, JSON.stringify(sc));
});

test('박동 간격(RR)을 10ms 안쪽 오차로 재요', () => {
  const { s, p } = run({ hr: 68, hrv: 0.06 });
  const truth = s.beats;
  const errs = [];
  for (const b of p.beats) {
    if (b.rr == null) continue;
    const t = b.idx / 100;
    const i = truth.findIndex(x => Math.abs(x - (t + 0.024)) < 0.1);
    if (i > 0) errs.push(Math.abs(b.rr * 10 - (truth[i] - truth[i - 1]) * 1000));
  }
  errs.sort((a, b) => a - b);
  assert.ok(errs.length > 20);
  assert.ok(errs[errs.length >> 1] < 10, `RR 오차 중앙값 ${errs[errs.length >> 1]}ms`);
});

test('손가락 없이 잡음만 있으면 박동으로 인정하지 않아요', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const r = rng(seed), p = new PulseProcessor(100, 5);
    let ok = 0;
    for (let n = 0; n < 6000; n++) {
      let u = 0;
      for (let k = 0; k < 6; k++) u += r();
      const b = p.push(120000 + 28 * (u - 3), 90000);
      if (b && b.ok) ok++;
    }
    assert.ok(ok <= 6, `잡음에서 ${ok}개를 박동으로 인정했어요`);
  }
});

test('진짜 맥박은 7초 안에 인정돼요', () => {
  for (const o of [{ hr: 72 }, { hr: 45 }, { hr: 75, pi: 0.001, noise: 25 }]) {
    const { ok } = run(o);
    assert.ok(ok.length && ok[0].idx / 100 < 7, `첫 인정 ${ok.length ? (ok[0].idx / 100).toFixed(1) : '없음'}초`);
  }
});

// ───────── 실제 손가락에 가까운 신호 (호흡성 부정맥 등) ─────────
const { realppg } = require('./realppg.js');
const { StreamCore } = require('../app/heart-sensor.js');

function okFraction(sig, level = 3) {
  const p = new PulseProcessor(100, level);
  p.setFinger(true);
  let lastOk = -1e9, ok = 0, tot = 0;
  for (let n = 0; n < sig.ir.length; n++) {
    const b = p.push(sig.ir[n], sig.red[n]);
    if (b && b.ok) lastOk = b.idx;
    if (n >= 1000) { tot++; if (p.pulseOk && n - lastOk < 350) ok++; }
  }
  return ok / tot;
}

for (const o of [{ hr: 75, rsa: 0.2, fresp: 0.25 }, { hr: 95, rsa: 0.2, fresp: 0.25 }, { hr: 50, rsa: 0.2, fresp: 0.1 },
  { hr: 70, drift: 0.2, driftPeriod: 2 }, { hr: 65, dic: 0.8, rsa: 0.15 }, { hr: 70, ectopic: 0.1 }]) {
  test(`숨에 따라 박동 간격이 출렁여도 맥박으로 인정해요 ${JSON.stringify(o)}`, () => {
    for (const seed of [1, 2]) {
      const f = okFraction(realppg(Object.assign({ seconds: 60, seed }, o)));
      assert.ok(f >= 0.8, `맥박 인정 시간 ${(f * 100).toFixed(0)}%`);
    }
  });
}

test('세게 눌러 맥박이 없거나 손가락이 없으면 박동을 인정하지 않아요', () => {
  for (const [dc, sd] of [[120000, 28], [2000, 20]]) {
    for (const level of [1, 3, 5]) {
      const r = rng(level * 7 + dc), p = new PulseProcessor(100, level);
      let ok = 0;
      for (let n = 0; n < 6000; n++) {
        let u = 0;
        for (let k = 0; k < 6; k++) u += r();
        const b = p.push(dc + sd * (u - 3) * 1.4, dc * 0.75 + sd * (r() - 0.5));
        if (b && b.ok) ok++;
      }
      assert.ok(ok <= 2, `밝기 ${dc}, 민감도 ${level}: 잡음 ${ok}개를 박동으로 인정했어요`);
    }
  }
});

// 펌웨어가 보내는 줄 형식 그대로 StreamCore에 넣어요. ledAt: [[초, 배율]] 이 시각부터 LED 밝기가 배율만큼 바뀜
// ledAt 항목의 세 번째 값은 실제 빛의 변화 배율 (LED가 전류에 정확히 비례하지 않는 경우)
function stream(sig, { ledAt = [], fingerFlicker = [], corrupt = [] } = {}) {
  const core = new StreamCore(3), out = { beats: [], okAt: [] };
  let pa = 100, k = 1;
  core.line('#HELLO HeartSensor 1.0');
  core.line('#OK MAX30102 rev=3');
  for (let n = 0; n < sig.ir.length; n++) {
    const t = n / 100;
    for (const [at, f, real] of ledAt) if (Math.abs(t - at) < 0.005) { pa = Math.round(pa * f); k *= real ?? f; }
    const finger = !fingerFlicker.some(([a, b]) => t >= a && t < b);
    if (n % 50 === 0 || ledAt.some(([at]) => Math.abs(t - at) < 0.005)) core.line(`#STAT ${pa} ${pa} ${finger ? 1 : 0} 800 1`);
    let line = `${Math.round(sig.ir[n] * k)},${Math.round(sig.red[n] * k)}`;
    if (corrupt.some(at => Math.abs(t - at) < 0.005)) line = line.slice(0, 2) + line.slice(3);  // 글자 하나 빠짐
    const r = core.line(line);
    if (!r) continue;
    if (r.beat) { out.beats.push(r.beat.idx / 100); if (r.beat.ok) out.okAt.push(r.beat.idx / 100); }
  }
  return out;
}

test('LED 밝기가 바뀌어도 처음부터 다시 하지 않고 박동을 계속 잡아요', () => {
  const sig = realppg({ seconds: 40, seed: 3, hr: 72, rsa: 0.1 });
  const { okAt } = stream(sig, { ledAt: [[15, 1.3], [25, 0.6]] });  // 펌웨어는 밝기를 15만 근처로 맞추므로 포화(25만)까지 가지 않는 범위
  const after = okAt.filter(t => t > 12);
  let gap = 0;
  for (let i = 1; i < after.length; i++) gap = Math.max(gap, after[i] - after[i - 1]);
  assert.ok(after.length > 25, `인정된 박동 ${after.length}개`);
  assert.ok(gap < 1.6, `LED 변경 때 박동이 ${gap.toFixed(1)}초 끊겼어요`);
});

test('손가락 감지 신호가 잠깐 깜빡여도 맥박을 잡고 있으면 끊기지 않아요', () => {
  const sig = realppg({ seconds: 40, seed: 4, hr: 72, rsa: 0.1 });
  const { okAt } = stream(sig, { fingerFlicker: [[15, 15.4], [22, 22.6], [30, 30.3]] });
  const after = okAt.filter(t => t > 12);
  let gap = 0;
  for (let i = 1; i < after.length; i++) gap = Math.max(gap, after[i] - after[i - 1]);
  assert.ok(gap < 1.6, `손가락 신호가 깜빡일 때 박동이 ${gap.toFixed(1)}초 끊겼어요`);
});

const maxGap = (okAt, from) => {
  const a = okAt.filter(t => t > from);
  let g = 0;
  for (let i = 1; i < a.length; i++) g = Math.max(g, a[i] - a[i - 1]);
  return { gap: g, count: a.length };
};

test('LED 밝기가 전류와 정확히 비례하지 않아도 끊기지 않아요', () => {
  const sig = realppg({ seconds: 40, seed: 5, hr: 72, rsa: 0.1 });
  const { okAt } = stream(sig, { ledAt: [[15, 1.4, 1.2], [25, 0.6, 0.7]] });
  const { gap, count } = maxGap(okAt, 12);
  assert.ok(count > 25 && gap < 1.6, `박동 ${count}개, 최대 끊김 ${gap.toFixed(1)}초`);
});

test('전송 중 글자가 빠진 줄이 있어도 끊기지 않아요', () => {
  const sig = realppg({ seconds: 40, seed: 6, hr: 72, rsa: 0.1 });
  const { okAt } = stream(sig, { corrupt: [14.03, 18.51, 22.77, 27.2, 31.66] });
  const { gap, count } = maxGap(okAt, 12);
  assert.ok(count > 25 && gap < 1.6, `박동 ${count}개, 최대 끊김 ${gap.toFixed(1)}초`);
});

test('적색 LED가 고장 나 잡음만 나와도 적외선 채널로 맥박을 보여줘요', () => {
  for (const seed of [1, 2]) {
    const sig = realppg({ seconds: 90, seed, hr: 60, rsa: 0.18 }), r = rng(seed);
    const p = new PulseProcessor(100, 3);
    p.setFinger(true);
    let lastOk = -1e9, ok = 0, tot = 0, redActive = 0;
    for (let n = 0; n < sig.ir.length; n++) {
      const b = p.push(sig.ir[n], 1500 + 30 * (r() - 0.5));
      if (b && b.ok) lastOk = b.idx;
      if (n >= 1200) { tot++; if (p.pulseOk && n - lastOk < 350) ok++; if (p.active === 'red') redActive++; }
    }
    assert.ok(ok / tot >= 0.85, `맥박 인정 시간 ${(ok / tot * 100).toFixed(0)}%`);
    assert.ok(redActive / tot < 0.05, `고장 난 적색 채널을 ${(redActive / tot * 100).toFixed(0)}% 동안 썼어요`);
  }
});

test('아주 강한 맥박(관류지수 8%)도 움직임으로 오해하지 않아요', () => {
  for (const seed of [1, 2]) {
    const f = okFraction(realppg({ seconds: 60, seed, hr: 75, pi: 0.08, piRed: 0.08 }));
    assert.ok(f >= 0.85, `맥박 인정 시간 ${(f * 100).toFixed(0)}%`);
  }
});

test('이완기 물결이 커도 박동을 두 번 세지 않고 맞는 BPM을 보여줘요', () => {
  for (const seed of [1, 2, 3]) {
    const sig = realppg({ seconds: 90, seed, hr: 65, dic: 0.5, dicDelay: 0.34, sysFall: 0.085, rsa: 0.08, drift: 0.08 });
    const p = new PulseProcessor(100, 3);
    p.setFinger(true);
    let shown = 0, wrong = 0;
    for (let n = 0; n < sig.ir.length; n++) {
      const b = p.push(sig.ir[n], sig.red[n]);
      if (!b || !b.ok || b.rr == null || n < 1500) continue;
      const t = b.idx / 100, i = sig.beats.findIndex(x => Math.abs(x - t) < 0.2);
      if (i < 1) continue;
      shown++;
      const trr = (sig.beats[i] - sig.beats[i - 1]) * 100;
      if (Math.abs(b.rr - trr) > 0.2 * trr) wrong++;
    }
    assert.ok(shown > 40, `보여 준 박동 ${shown}개`);
    assert.ok(wrong / shown <= 0.1, `틀린 BPM ${(wrong / shown * 100).toFixed(0)}%`);
  }
});

// ───────── 부스처럼 여러 사람이 차례로 측정할 때 ─────────
// parts: [{ sig, finger }] 를 이어 붙여 펌웨어 형식으로 흘려보내요. finger=false 구간은 손가락 없는 잡음.
function sequence(parts, { ovfEvery = 0, ovfChronic = 0 } = {}) {
  const core = new StreamCore(3), r = rng(99), out = [];
  core.line('#OK MAX30102 rev=3');
  let n = 0;
  for (const part of parts) {
    const len = part.sig ? part.sig.ir.length : part.seconds * 100;
    for (let i = 0; i < len; i++, n++) {
      if (n % 50 === 0) core.line(`#STAT 100 100 ${part.sig ? 1 : 0} ${part.sig ? 800 : 20} 1`);
      if (ovfEvery && n % (ovfEvery * 100) === 0 && n > 0) { core.line('#OVF 8'); i += 8; n += 8; continue; }
      if (ovfChronic && r() < ovfChronic) core.line('#OVF 1');
      const ir = part.sig ? part.sig.ir[i] : 2000 + 40 * (r() - 0.5), red = part.sig ? part.sig.red[i] : 1500 + 40 * (r() - 0.5);
      const res = core.line(`${Math.round(ir)},${Math.round(red)}`);
      if (res && res.beat) out.push({ t: n / 100, ok: res.beat.ok, rr: res.beat.rr, part: parts.indexOf(part) });
    }
  }
  return { beats: out, core };
}

test('앞사람이 손가락을 떼고 다른 사람이 올리면 새 사람의 맥박을 바로 제대로 재요', () => {
  for (const seed of [1, 2, 3]) {
    const A = realppg({ seconds: 30, seed, hr: 50, pi: 0.025 }), B = realppg({ seconds: 30, seed: seed + 10, hr: 110, pi: 0.006, dic: 0.6 });
    const { beats } = sequence([{ sig: A }, { seconds: 3 }, { sig: B }]);
    const ghost = beats.filter(b => b.part === 1 && b.ok && b.t > 31);
    assert.strictEqual(ghost.length, 0, `손가락이 없는데 ${ghost.length}개를 박동으로 보여줬어요`);
    const bOk = beats.filter(b => b.part === 2 && b.ok && b.rr != null);
    const first = bOk.length ? bOk[0].t - 33 : Infinity;
    // 약한 맥박에서 박동을 가끔 놓치는 건 있을 수 있지만, 앞사람 기준이 남아 처음부터 절반 BPM이 이어지면 안 돼요
    const isHalf = b => b.rr > 1.6 * 100 * 60 / 110;
    let run = 0, worst = 0;
    for (const b of bOk.filter(b => b.t < bOk[0].t + 8)) { run = isHalf(b) ? run + 1 : 0; worst = Math.max(worst, run); }
    const halfShare = bOk.filter(isHalf).length / bOk.length;
    assert.ok(first < 10, `새 사람의 첫 박동까지 ${first.toFixed(1)}초`);
    assert.ok(worst <= 1, `새 사람에게 처음부터 절반 BPM을 ${worst}번 연속으로 보여줬어요`);
    assert.ok(halfShare <= 0.1, `절반 BPM 비율 ${(halfShare * 100).toFixed(0)}%`);
  }
});

test('손가락을 세게 눌러 맥동이 갑자기 작아져도 곧 다시 잡아요', () => {
  for (const seed of [1, 2]) {
    const strong = realppg({ seconds: 30, seed, hr: 72, pi: 0.025 }), weak = realppg({ seconds: 30, seed: seed + 5, hr: 72, pi: 0.003 });
    const { beats } = sequence([{ sig: strong }, { sig: weak }]);
    const ok = beats.filter(b => b.part === 1 && b.ok).map(b => b.t);
    let gap = ok.length ? ok[0] - 30 : 30;
    for (let i = 1; i < ok.length; i++) gap = Math.max(gap, ok[i] - ok[i - 1]);
    assert.ok(gap < 9, `맥동이 작아진 뒤 박동이 ${gap.toFixed(1)}초 동안 끊겼어요`);
  }
});

// 실제 센서 기록(원신호_20261021_232946): 넘치지 않았는데도 샘플 10개 중 9개 앞에 '#OVF 1'이 붙어 왔어요
test('센서가 거의 샘플마다 #OVF 1을 보내도 맥박을 잡아요', () => {
  for (const seed of [1, 2, 3]) {
    const sig = realppg({ seconds: 60, seed, hr: 88, pi: 0.005 });
    const { beats } = sequence([{ sig }], { ovfChronic: 0.89 });
    const ok = beats.filter(b => b.ok);
    const first = ok.length ? ok[0].t : Infinity;
    const right = ok.filter(b => b.rr && Math.abs(60 * 100 / b.rr - 88) < 0.2 * 88).length;
    assert.ok(first < 12, `첫 박동까지 ${first.toFixed(1)}초`);
    assert.ok(ok.length > 60 && right / ok.length > 0.85, `박동 ${ok.length}개, BPM이 맞는 비율 ${(right / ok.length * 100).toFixed(0)}%`);
  }
});

test('샘플 몇 개가 빠져도(#OVF) 처음부터 다시 하지 않아요', () => {
  const sig = realppg({ seconds: 60, seed: 4, hr: 72 });
  const { beats } = sequence([{ sig }], { ovfEvery: 5 });
  const ok = beats.filter(b => b.ok && b.t > 12).map(b => b.t);
  let gap = 0;
  for (let i = 1; i < ok.length; i++) gap = Math.max(gap, ok[i] - ok[i - 1]);
  assert.ok(ok.length > 35 && gap < 3, `박동 ${ok.length}개, 최대 끊김 ${gap.toFixed(1)}초`);
});
