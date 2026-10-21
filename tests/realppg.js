// 테스트용 현실적인 손끝 PPG 생성기 — 호흡성 부정맥, 중복맥, 압력 변화, 움직임, 조기 박동 등을 흉내 내요.
// Realistic fingertip reflectance PPG generator (raw MAX30102-like counts, IR + Red).
// Physiology modelled:
//  - beat timing: mean HR, respiratory sinus arrhythmia (RSA) as sinusoidal RR modulation at the breathing
//    frequency (breathing rate itself wanders +-15%), random beat-to-beat jitter, optional ectopic beats
//    (premature at 0.65-0.75 RR, compensatory pause, reduced amplitude)
//  - morphology: asymmetric-Gaussian systolic wave (fast rise, slower fall) + separate diastolic (reflected)
//    wave after a dicrotic notch; young subjects have a prominent diastolic wave (dic 0.4-0.8)
//  - amplitude: PI (AC/DC) with respiratory amplitude modulation and random beat-to-beat variation
//  - baseline: respiratory-induced intensity variation (RIIV), slow DC drift from finger pressure
//    (smooth random excursions of +-drift over seconds), small occasional movements
//  - noise: white ADC/shot noise in counts
'use strict';
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(r) { let u = 0, v = 0; while (!u) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const ag = (t, mu, sl, sr) => { const d = t - mu, s = d < 0 ? sl : sr; return Math.exp(-0.5 * (d / s) * (d / s)); };

/**
 * o: seconds, fs, hr, rsa (fractional RR swing, e.g. 0.15 = +-15%), fresp (Hz), jitter (fractional RR sd),
 *    pi (IR AC/DC, e.g. 0.01), piRed (default pi*0.55), dic (diastolic wave rel. amplitude), notch (0..1 deepness via systolic fall width),
 *    ampVar (beat-to-beat sd), ampResp (resp AM depth), riiv (resp baseline, fraction of DC), drift (pressure DC excursions, fraction),
 *    driftPeriod (s), motion: {rate (/s), size (fraction DC), dur (s)}, ectopic: [t...] or rate, dcIr, dcRed, noise (counts), seed
 * returns { ir, red, beats (true systolic-upstroke times, s), fs, rr }
 */
function realppg(o = {}) {
  const fs = o.fs || 100, T = o.seconds || 90, N = Math.round(T * fs), r = rng(o.seed || 1);
  const hr = o.hr || 70, rsa = o.rsa ?? 0.1, fresp0 = o.fresp ?? 0.25, jit = o.jitter ?? 0.02;
  const pi = o.pi ?? 0.01, piRed = o.piRed ?? pi * 0.55, dic = o.dic ?? 0.5;
  const ampVar = o.ampVar ?? 0.08, ampResp = o.ampResp ?? 0.12, riiv = o.riiv ?? 0.004;
  const drift = o.drift ?? 0.1, driftPeriod = o.driftPeriod ?? 6;
  const dcIr = o.dcIr ?? 150000, dcRed = o.dcRed ?? 130000, noise = o.noise ?? 25;
  const sysFall = o.sysFall ?? 0.085, sysRise = o.sysRise ?? 0.05, dicDelay = o.dicDelay ?? 0.24;  // seconds
  // respiration phase (breathing rate wanders)
  const respPh = new Float64Array(N + 1);
  { let ph = r() * 2 * Math.PI, f = fresp0; for (let n = 0; n <= N; n++) { respPh[n] = ph; if (n % fs === 0) f = fresp0 * (1 + 0.15 * gauss(r) * 0.5); ph += 2 * Math.PI * f / fs; } }
  const respAt = t => Math.sin(respPh[Math.min(N, Math.max(0, Math.round(t * fs)))]);
  // beats
  const beats = [], amps = [], rrList = [];
  let ect = Array.isArray(o.ectopic) ? o.ectopic.slice() : [];
  const ectRate = typeof o.ectopic === 'number' ? o.ectopic : 0;
  let t = 0.2 + r() * 0.6, pendingComp = 0;
  const rr0 = 60 / hr;
  while (t < T + 2) {
    // RSA: inspiration shortens RR. Use respiration phase lagged a bit.
    let rr = rr0 * (1 - rsa * respAt(t)) * (1 + jit * gauss(r));
    let a = 1 + ampVar * gauss(r);
    if (pendingComp) { rr = pendingComp; pendingComp = 0; }
    else if ((ect.length && t + rr > ect[0]) || (ectRate && r() < ectRate * rr)) {
      if (ect.length) ect.shift();
      const pre = rr * (0.65 + 0.1 * r());
      pendingComp = 2 * rr - pre;
      rr = pre;
    }
    beats.push(t); amps.push(Math.max(0.3, a));
    rrList.push(rr);
    t += rr;
  }
  // mark ectopic amplitude: beat that came early gets smaller amplitude (less filling)
  for (let k = 1; k < beats.length; k++) { const prev = beats[k] - beats[k - 1]; if (prev < 0.8 * rr0 * (1 - rsa)) amps[k] *= 0.55; }
  // pressure drift: smooth random excursions
  const dD = new Float64Array(N);
  { let cur = 0, from = 0, to = 0, t0 = 0, dur = 1; let next = 0;
    for (let n = 0; n < N; n++) { const tt = n / fs;
      if (tt >= next) { from = cur; to = drift * (2 * r() - 1); t0 = tt; dur = 1 + 2 * r(); next = tt + driftPeriod * (0.5 + r()); }
      const u = Math.min(1, (tt - t0) / dur); cur = from + (to - from) * (0.5 - 0.5 * Math.cos(Math.PI * u)); dD[n] = cur; } }
  // motion events
  const mot = new Float64Array(N);
  if (o.motion) {
    const { rate = 0.05, size = 0.02, dur = 0.4 } = o.motion; let tt = 0;
    const events = Array.isArray(o.motion.at) ? o.motion.at.slice() : null;
    while (true) {
      tt = events ? events.shift() : tt + -Math.log(1 - r()) / rate;
      if (tt == null || tt >= T) break;
      const s = size * (r() < 0.5 ? -1 : 1) * (0.5 + r()), d = dur * (0.6 + 0.8 * r());
      for (let n = Math.round(tt * fs); n < Math.min(N, Math.round((tt + d + 0.6) * fs)); n++) {
        const u = (n / fs - tt);
        mot[n] += u < d ? s * Math.sin(Math.PI * u / d) * (1 + 0.3 * Math.sin(2 * Math.PI * 3 * u)) : s * 0.3 * Math.exp(-(u - d) / 0.2) * 0; // bump
        if (u >= d) mot[n] += 0;
      }
    }
  }
  const ir = new Float64Array(N), red = new Float64Array(N);
  let bi = 0;
  // normalise pulse shape to unit peak-to-trough approx
  const shape = tau => ag(tau, 0.0 + sysRise * 2.6, sysRise, sysFall) + dic * ag(tau, sysRise * 2.6 + dicDelay, 0.045, 0.16);
  let pk = 0; for (let k = 0; k < 120; k++) pk = Math.max(pk, shape(k / 100));
  for (let n = 0; n < N; n++) {
    const tt = n / fs;
    while (bi < beats.length - 1 && beats[bi + 1] <= tt) bi++;
    let ac = 0;
    for (let k = Math.max(0, bi - 3); k <= bi + 1 && k < beats.length; k++) {
      const tau = tt - beats[k];
      if (tau < -0.3 || tau > 1.8) continue;
      ac += amps[k] * shape(tau) / pk;
    }
    const resp = respAt(tt);
    const am = 1 + ampResp * resp;
    const base = 1 + riiv * Math.sin(respPh[n] + 1.2) + dD[n] + mot[n];
    const nI = noise * gauss(r), nR = noise * 1.3 * gauss(r);
    ir[n] = Math.max(0, Math.min(262143, Math.round(dcIr * base * (1 - pi * am * ac) + nI)));
    red[n] = Math.max(0, Math.min(262143, Math.round(dcRed * base * (1 - piRed * am * ac) + nR)));
  }
  // truth = time of max upstroke slope (approx foot + sysRise*1.6)
  const up = sysRise * 2.6 - sysRise; // inflection of asymmetric gaussian rise = mu - sigma
  return { ir, red, beats: beats.map(b => b + up).filter(b => b < T - 0.5), fs, rr: rrList, amps };
}
module.exports = { realppg, rng, gauss };
