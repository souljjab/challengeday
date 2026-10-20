// 테스트용 가짜 PPG(광혈류) 신호 생성기 — MAX30102 원신호 모양을 흉내 내요.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(r) { let u = 0, v = 0; while (!u) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/**
 * opts: seconds, fs, hr (number or fn(t)), hrv, pi (맥동 크기, 0.01 = 1%), dc, noise (counts),
 *       dicrotic (0~1), motion [[t0,t1,strength]], dcSteps [[t, factor]], premature [t,...], seed
 * 반환: { x: Float64Array (원신호), beats: [정답 박동 시각(초)], dcSteps }
 */
function synth(o) {
  const fs = o.fs || 100, T = o.seconds || 60, N = Math.round(T * fs), r = rng(o.seed || 1);
  const hrAt = typeof o.hr === 'function' ? o.hr : () => (o.hr || 72);
  const hrv = o.hrv ?? 0.04, pi = o.pi ?? 0.012, dc0 = o.dc ?? 150000, noise = o.noise ?? 20;
  const dic = o.dicrotic ?? 0.35;
  const beats = [];
  let t = 0.3 + r() * 0.5;
  const prem = (o.premature || []).slice();
  while (t < T + 2) {
    beats.push(t);
    let rr = 60 / hrAt(t) * (1 + hrv * Math.sin(2 * Math.PI * t / 4.5) + hrv * 0.4 * gauss(r));
    if (prem.length && t + rr > prem[0]) { prem.shift(); rr *= 0.65; }
    t += rr;
  }
  const x = new Float64Array(N);
  let walk = 0, mot = 0, motV = 0, bi = 0;
  for (let n = 0; n < N; n++) {
    const tt = n / fs;
    while (bi < beats.length - 1 && beats[bi + 1] <= tt) bi++;
    let ac = 0;
    for (let k = Math.max(0, bi - 2); k <= bi + 1 && k < beats.length; k++) {
      const d = tt - beats[k];
      if (d < -0.5 || d > 1.5) continue;
      ac += Math.exp(-0.5 * ((d - 0.2) / 0.06) ** 2) + dic * Math.exp(-0.5 * ((d - 0.45) / 0.09) ** 2);
    }
    const resp = 1 + 0.15 * Math.sin(2 * Math.PI * 0.25 * tt);
    walk += gauss(r) * 0.00002; walk *= 0.999;
    let dc = dc0 * (1 + 0.003 * (o.wander ?? 0.3) / 0.3 * Math.sin(2 * Math.PI * 0.25 * tt + 1) + walk);
    for (const [ts, f] of o.dcSteps || []) if (tt >= ts) dc *= f;
    let m = 0;
    for (const [a, b, s] of o.motion || []) if (tt >= a && tt < b) m = s;
    if (m) { motV += gauss(r) * 0.03 - mot * 0.02; mot += motV * 0.1; } else { mot *= 0.95; motV = 0; }
    let v = dc * (1 - pi * resp * ac + (m || mot !== 0 ? mot * (m || 0.05) : 0)) + noise * gauss(r);
    x[n] = Math.max(0, Math.min(262143, v));
  }
  return { x, beats: beats.filter(b => b + 0.2 < T).map(b => b + 0.2), fs };
}

// 검출 결과를 정답과 비교: 일정한 지연을 빼고 ±150ms 안이면 맞힌 것으로 셈
function score(det, truth, opts = {}) {
  const tol = opts.tol ?? 0.15, from = opts.from ?? 3, excl = opts.exclude || [];
  const to = opts.to ?? Infinity;
  const keep = t => t >= from && t <= to && !excl.some(([a, b]) => t >= a && t <= b);
  const T = truth.filter(keep);
  const near = d => { let best = null; for (const t of truth) if (best == null || Math.abs(t - d) < Math.abs(best - d)) best = t; return best; };
  const offs = det.map(d => d - near(d)).filter(v => Math.abs(v) < 0.3).sort((a, b) => a - b);
  const off = offs.length ? offs[offs.length >> 1] : 0;
  const D = det.map(d => d - off).filter(keep);
  const used = new Set(); let tp = 0;
  for (const d of D) {
    let bi = -1, bd = 1e9;
    T.forEach((t, i) => { const e = Math.abs(t - d); if (e < bd && !used.has(i)) { bd = e; bi = i; } });
    if (bi >= 0 && bd <= tol) { used.add(bi); tp++; }
  }
  return { se: T.length ? tp / T.length : 1, ppv: D.length ? tp / D.length : 1, tp, fn: T.length - tp, fp: D.length - tp, offset: off };
}

module.exports = { synth, score, rng };
