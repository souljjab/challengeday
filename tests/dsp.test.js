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
