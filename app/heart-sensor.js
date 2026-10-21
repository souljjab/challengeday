/*
  heart-sensor.js — 아두이노 + MAX30102 심박 센서 연결과 신호 처리

  ┌ 신호 처리 (PpgChannel, PulseProcessor)
  │   센서 원신호 → 0.5~5Hz 대역 통과 필터 → 밝기(DC)로 나눠 % 단위로 정규화
  │   → 두 이동평균(짧은 창/긴 창)을 비교해 박동 구간을 찾고(Elgendi 방식)
  │   → 구간의 최고점을 박동 시각으로 사용(포물선 보간으로 10ms보다 정밀하게)
  │   → 움직임·너무 작은 신호·너무 빠른 반복(이중 검출)은 버려요.
  │   적외선(IR)과 적색(Red) 두 채널을 함께 분석해서 더 깨끗한 쪽을 써요.
  ├ 연결 (SerialLink, Hub)
  │   크롬/엣지의 Web Serial로 아두이노와 통신하고, 상태·힌트·설정 패널을 관리해요.
  └ 페이지 연결 (host, client)
      START.html이 연결을 하나만 유지하고, 안쪽 페이지가 바뀌어도 연결이 끊기지 않게
      postMessage로 박동·파형·상태를 전달해요.
*/
(function (root) {
  'use strict';

  const FS = 100;            // 펌웨어 샘플링 속도 (Hz)
  const SPAN = 4;            // 기울기를 계산할 간격 (샘플)
  const SAT = 250000;        // 이 이상이면 빛이 너무 세서 신호가 잘린 것
  const BAUD = 115200;
  const OVF_GAP = 4;         // #OVF로 이만큼(40ms) 이상 샘플이 빠졌다고 하면 그 구간을 건너뛰어요

  // 민감도 1(낮음) ~ 5(높음). 높일수록 약한 박동도 잡지만 잡음도 박동으로 잘못 셀 수 있어요.
  const SENSITIVITY = [
    { k: 1.15, beta: 0.12, minAmp: 0.5 },
    { k: 1.07, beta: 0.06, minAmp: 0.42 },
    { k: 1.00, beta: 0.03, minAmp: 0.33 },
    { k: 0.95, beta: 0.015, minAmp: 0.25 },
    { k: 0.90, beta: 0.0, minAmp: 0.18 }
  ];

  const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const odd = v => (v % 2 ? v : v + 1);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ───────── 필터 ─────────
  class Biquad {
    constructor(b0, b1, b2, a1, a2) { Object.assign(this, { b0, b1, b2, a1, a2, s1: 0, s2: 0 }); }
    step(x) {
      const y = this.b0 * x + this.s1;
      this.s1 = this.b1 * x - this.a1 * y + this.s2;
      this.s2 = this.b2 * x - this.a2 * y;
      return y;
    }
    // 입력 x가 계속 들어와 출력이 y로 안정된 상태로 맞춰요 (리셋 직후 출렁임 방지)
    settle(x, y) {
      this.s2 = this.b2 * x - this.a2 * y;
      this.s1 = this.b1 * x - this.a1 * y + this.s2;
    }
  }
  function biquad(type, fc, fs, q = Math.SQRT1_2) {
    const w = 2 * Math.PI * fc / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    const b = type === 'lp' ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] : [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
    return new Biquad(b[0] / a0, b[1] / a0, b[2] / a0, -2 * cw / a0, (1 - al) / a0);
  }

  // ───────── 한 채널 박동 검출 ─────────
  // 박동마다 혈액이 밀려올 때 신호가 가장 가파르게 올라가요(수축기 상승).
  // 이 '기울기'로 박동을 찾으면 호흡 때문에 출렁이는 기준선이나 이완기의 작은 물결(중복맥)에
  // 덜 속아요. 기울기의 제곱을 짧은 창(0.11초)·긴 창(0.67초)으로 평균 내서
  // 짧은 쪽이 긴 쪽보다 큰 구간을 박동 후보로 봐요 (Elgendi 방식).
  class PpgChannel {
    constructor(fs = FS, sensitivity = 3) {
      this.fs = fs;
      this.N = 1024;
      this.y = new Float64Array(this.N);       // 정규화한 맥파 (‰)
      this.s = new Float64Array(this.N);       // 맥파의 기울기
      this.z = new Float64Array(this.N);       // 올라가는 기울기의 제곱
      this.w1 = odd(Math.round(0.111 * fs));   // 수축기 상승 구간 길이
      this.w2 = odd(Math.round(0.667 * fs));   // 박동 한 번의 길이
      this.h1 = (this.w1 - 1) / 2;
      this.d = (this.w2 - 1) / 2;              // 검출 지연 (약 0.33초)
      this.hp = biquad('hp', 0.3, fs);         // 0.3Hz 아래(밝기 변화·느린 출렁임) 제거
      this.lp = biquad('lp', 5, fs);           // 5Hz 위(전기 잡음) 제거
      this.dcK = 1 / (1.5 * fs);
      this.n = -1;
      this.slopes = [];
      this.amps = [];
      this.rrs = [];
      this.recent = [];
      this.medSlope = null;
      this.medAmp = null;
      this.medRR = null;
      this.lastMotion = -1e9;
      this.motion = [-1e9, -1e9];
      this.rejects = { big: 0, small: 0 };
      this.setSensitivity(sensitivity);
      this.reset();
    }
    setSensitivity(level) {
      this.level = clamp(Math.round(level) || 3, 1, 5);
      Object.assign(this, SENSITIVITY[this.level - 1]);
    }
    reset() { this.needInit = true; this.lastPeak = null; }
    // LED 밝기가 k배로 바뀌면 원신호도 k배가 돼요. 필터 안의 값도 k배 해 두면 처음부터 다시 할 필요가 없어요.
    rescale(k) {
      if (this.needInit || !(k > 0) || !isFinite(k) || k === 1) return;
      this.gain(k);
      // LED 전류와 실제 빛의 양이 정확히 비례하지는 않아서, 바뀐 직후 3샘플로 실제 비율을 재서 한 번 더 맞춰요.
      // 그동안(첫 샘플은 두 밝기가 섞여 있을 수 있음)은 예상값을 대신 넣어요.
      this.fix = { hold: this.lastX * k, post: [] };
    }
    gain(g) {
      this.dc *= g;
      for (const f of [this.hp, this.lp]) { f.s1 *= g; f.s2 *= g; }
    }
    // 손가락을 새로 올렸을 때: 앞사람(또는 손가락 없을 때 잡음)에서 배운 기준값을 지워요
    forget() {
      this.slopes = [];
      this.amps = [];
      this.rrs = [];
      this.recent = [];
      this.medSlope = this.medAmp = this.medRR = null;
      this.rejects = { big: 0, small: 0 };
    }
    markMotion(i) {
      const s = i - Math.round(0.3 * this.fs), e = i + Math.round(0.7 * this.fs);
      if (s <= this.motion[1]) this.motion[1] = Math.max(this.motion[1], e);
      else this.motion = [s, e];
      this.lastMotion = i;
    }
    inMotion(i) { return i >= this.motion[0] && i <= this.motion[1]; }
    get blanking() { return this.n < this.blankUntil; }

    push(x) {
      const n = ++this.n, M = this.N - 1, fs = this.fs;
      if (this.fix) {
        const f = this.fix;
        f.post.push(x);
        if (f.post.length < 4) x = f.hold;
        else {
          this.fix = null;
          const c = (f.post[1] + f.post[2] + f.post[3]) / 3 / f.hold;
          if (c > 0.7 && c < 1.4) this.gain(c);
        }
      }
      this.lastX = x;
      if (this.needInit) {
        this.needInit = false;
        this.fix = null;
        this.dc = x;
        this.hp.settle(x, 0);
        this.lp.settle(0, 0);
        this.y.fill(0);
        this.s.fill(0);
        this.z.fill(0);
        this.sumBeat = this.sumPeak = 0;
        this.inBlock = false;
        this.blankUntil = n + Math.round(1.2 * fs);
        this.zMean = 0;
        this.zCount = 0;
      }
      this.dc += (x - this.dc) * this.dcK;
      const v = -this.lp.step(this.hp.step(x)) / Math.max(this.dc, 1) * 1000;  // ‰, 박동이 위로 솟게 뒤집음
      this.v = v;
      this.y[n & M] = v;
      const sl = (v - this.y[(n - SPAN) & M]) / SPAN;  // n-SPAN/2 시점의 기울기 (‰/샘플)
      this.s[n & M] = sl;
      const zv = sl > 0 ? sl * sl : 0;
      // 맥박으로는 나올 수 없는 크기(밝기의 8% 이상 출렁임, 아주 가파른 변화)면 움직임으로 봐요
      if (x >= SAT || x <= 0 || Math.abs(sl) > 12 || Math.abs(v) > 80) this.markMotion(n);

      this.sumBeat += zv - this.z[(n - this.w2) & M];
      this.z[n & M] = zv;
      const m = n - this.d;
      this.sumPeak += this.z[(m + this.h1) & M] - this.z[(m - this.h1 - 1) & M];
      if ((n & 4095) === 0) this.resum(n, m);

      if (m < this.blankUntil) { this.inBlock = false; return null; }
      if (!this.inMotion(m)) {
        this.zCount++;
        this.zMean += (this.z[m & M] - this.zMean) / Math.min(this.zCount, 8 * fs);
      }
      const maPeak = this.sumPeak / this.w1, maBeat = this.sumBeat / this.w2;
      if (maPeak > this.k * maBeat + this.beta * this.zMean) {
        if (!this.inBlock) { this.inBlock = true; this.blockStart = m; }
        return null;
      }
      if (!this.inBlock) return null;
      this.inBlock = false;
      if (m - this.blockStart < this.w1) return null;
      return this.candidate(this.blockStart, m, n);
    }
    resum(n, m) {  // 누적 합의 부동소수점 오차 정리
      const M = this.N - 1;
      let a = 0, b = 0;
      for (let i = n - this.w2 + 1; i <= n; i++) a += this.z[i & M];
      for (let i = m - this.h1; i <= m + this.h1; i++) b += this.z[i & M];
      this.sumBeat = a;
      this.sumPeak = b;
    }
    reject(why) {
      const r = this.rejects;
      for (const k in r) r[k] = k === why ? r[k] + 1 : 0;
      // 기준 크기가 잘못 잡혀 계속 거절되면 기준을 새로 잡아요
      if (r.big >= 2 || r.small >= 4) {
        this.slopes = [];
        this.amps = [];
        this.medSlope = this.medAmp = null;
        r.big = r.small = 0;
      }
      return null;
    }
    candidate(b0, b1, n) {
      const y = this.y, s = this.s, M = this.N - 1, fs = this.fs;
      let p = b0;
      for (let i = b0 + 1; i < b1; i++) if (s[i & M] > s[p & M]) p = i;
      const at = p - SPAN / 2;                           // 기울기가 가장 큰 시점
      if (this.inMotion(at)) return this.reject('motion');
      const s0 = s[(p - 1) & M], s1 = s[p & M], s2 = s[(p + 1) & M], den = s0 - 2 * s1 + s2;
      const tp = at + (den < 0 ? clamp(0.5 * (s0 - s2) / den, -0.5, 0.5) : 0);
      let lo = Infinity, hi = -Infinity;
      for (let i = at - Math.round(0.3 * fs); i <= at; i++) lo = Math.min(lo, y[i & M]);
      for (let i = at; i <= Math.min(n, at + Math.round(0.3 * fs)); i++) hi = Math.max(hi, y[i & M]);
      const slope = s1, amp = hi - lo;
      // 2.5초(또는 박동 2번) 넘게 박동을 하나도 인정하지 못했으면 기울기 기준이 낡은 거예요
      // (손가락을 세게 눌러 맥동이 갑자기 작아진 경우 등) → 기준만 새로 잡아요
      if (this.medSlope && this.rejects.small >= 2 && this.lastPeak != null && this.lastMotion < this.lastPeak
        && at - this.lastPeak > Math.max(2.5 * fs, 2.2 * (this.medRR || 0))) {
        this.slopes = [];
        this.medSlope = null;
      }
      const rc = this.recent;
      rc.push({ at, slope });
      while (rc.length && at - rc[0].at > 3 * fs) rc.shift();
      if (this.medSlope) {
        if (slope > 4 * this.medSlope) return this.reject('big');
        if (slope < this.minAmp * this.medSlope) return this.reject('small');
      } else if (slope < 0.4 * Math.max(...rc.map(c => c.slope))) {
        return this.reject('small');                     // 기준이 없을 땐 최근 3초의 가장 큰 박동과 비교
      }
      let rr = null;
      if (this.lastPeak != null) {
        const gap = tp - this.lastPeak;
        if (gap < Math.max(0.28 * fs, this.medRR ? 0.5 * this.medRR : 0)) return this.reject('refractory');
        // 예상보다 일찍 온 작은 봉우리는 이완기 물결일 가능성이 커요
        if (this.medRR && this.medSlope && gap < 0.75 * this.medRR && slope < 0.5 * this.medSlope) return this.reject('early');
        if (gap < 2.2 * fs) rr = gap;
      }
      this.reject('none');
      this.lastPeak = tp;
      const keep = (arr, v) => { arr.push(v); if (arr.length > 9) arr.shift(); return arr.length >= 3 ? median(arr) : null; };
      this.medSlope = keep(this.slopes, slope);
      this.medAmp = keep(this.amps, amp);
      if (rr != null) this.medRR = keep(this.rrs, rr);
      return { idx: tp, amp, rr };
    }
  }

  // ───────── 두 채널(IR·Red) 묶음 + 신호 품질 ─────────
  class PulseProcessor {
    constructor(fs = FS, sensitivity = 3) {
      this.fs = fs;
      this.ch = { ir: new PpgChannel(fs, sensitivity), red: new PpgChannel(fs, sensitivity) };
      this.hist = { ir: [], red: [] };
      this.active = 'ir';
      this.lastSwitch = -1e9;
      this.n = -1;
      this.lastEmit = null;
      this.beats = [];
      this.finger = false;
      this.fingerAt = -1e9;
      this.offAt = -1e9;
      this.fingerSeen = false;
      this.lastIr = 0;
      this.lastRed = 0;
      this.periodicity = 0;      // 최근 3.5초 신호가 얼마나 규칙적으로 반복되는지 (0~1)
      this.shape = null;         // 최근 박동들의 모양이 서로 얼마나 닮았는지 (0~1)
      this.segs = [];            // 최근 박동 모양 (정규화)
      this.shapes = [];          // 박동마다 앞선 박동들과의 모양 일치도
      this.pulseOk = false;      // 진짜 맥박이 보이는지 (잡음만 있을 때 박동을 세지 않도록)
      this.okCount = 0;
      this.restartIdx = 0;
    }
    setSensitivity(level) { for (const k in this.ch) this.ch[k].setSensitivity(level); }
    get sensitivity() { return this.ch.ir.level; }
    restart() {  // 손가락을 새로 올렸거나 신호가 끊겼을 때
      for (const k in this.ch) this.ch[k].reset();
      this.restartIdx = this.n + 1;
      this.lastEmit = null;
      this.pulseOk = false;
      this.okCount = 0;
    }
    rescaleLed(kIr, kRed) { this.ch.ir.rescale(kIr); this.ch.red.rescale(kRed); }
    // 샘플 몇 개가 빠졌을 때(FIFO 넘침): 처음부터 다시 하지 않고 그 구간만 움직임처럼 건너뛰어요
    gap() {
      for (const k in this.ch) {
        const c = this.ch[k];
        if (!c.needInit) { c.markMotion(c.n); c.lastPeak = null; }
      }
      this.lastEmit = null;
    }
    setFinger(on) {
      if (!on && this.finger) this.offAt = this.n;
      if (on) this.fingerSeen = true;
      // 새 손가락이면 처음부터 다시 해요. 맥박을 잡고 있던 중 손가락 감지 신호만 잠깐 깜빡인 거라면 그대로 두지만,
      // 1.5초 넘게 떼었다 올리면 다른 사람일 수 있어서 앞 사람의 기준값을 모두 버려요
      if (on && !this.finger && (!this.pulseOk || this.n - this.offAt >= 1.5 * this.fs)) {
        this.fingerAt = this.n;
        this.segs = [];
        this.shapes = [];
        this.beats = [];
        this.hist = { ir: [], red: [] };
        for (const k in this.ch) this.ch[k].forget();
        this.active = 'ir';
        this.restart();
      }
      this.finger = on;
    }
    // 손가락을 뗀 지 1초가 넘었으면, 남은 잡음을 박동으로 보여주지 않아요
    get lifted() { return this.fingerSeen && !this.finger && this.n - this.offAt > this.fs; }
    push(ir, red) {
      const n = ++this.n, fs = this.fs;
      this.lastIr = ir;
      this.lastRed = red;
      const got = { ir: this.ch.ir.push(ir), red: this.ch.red.push(red) };
      for (const k in got) {
        if (!got[k]) continue;
        const h = this.hist[k];
        h.push(got[k]);
        while (h.length && n - h[0].idx > 8 * fs) h.shift();
      }
      if (n % 50 === 0) this.chooseChannel();
      if (n % 25 === 0) this.checkPulse();
      const b = got[this.active];
      return b ? this.emit(b) : null;
    }
    // 자기상관: 신호를 0.34~1.5초(176~40 BPM) 밀어서 자기 자신과 얼마나 닮았는지 봐요.
    // 맥박은 같은 모양이 반복돼서 값이 크고, 잡음은 작아요.
    autocorr(c) {
      const fs = this.fs, step = 2, len = Math.round(3.5 * fs / step), y = c.s, M = c.N - 1;  // 기울기로 계산하면 호흡 출렁임의 영향이 적어요
      if (c.blanking || c.n - c.blankUntil < 3.5 * fs) return { r: 0, period: null, peaks: [] };
      const a = new Float64Array(len);
      let mean = 0;
      for (let i = 0; i < len; i++) { a[i] = y[(c.n - (len - 1 - i) * step) & M]; mean += a[i]; }
      mean /= len;
      for (let i = 0; i < len; i++) a[i] -= mean;
      const lo = Math.round(0.34 * fs / step), hi = Math.round(1.5 * fs / step), rs = [];
      for (let lag = lo; lag <= hi; lag++) {
        let xy = 0, xx = 0, yy = 0;
        for (let i = 0; i + lag < len; i++) { xy += a[i] * a[i + lag]; xx += a[i] * a[i]; yy += a[i + lag] * a[i + lag]; }
        rs.push(xx && yy ? xy / Math.sqrt(xx * yy) : 0);
      }
      // 양 끝이 아닌 진짜 봉우리만 봐요 (느린 출렁임 때문에 양 끝값이 커지는 경우가 있어요)
      const peaks = [];
      for (let i = 1; i < rs.length - 1; i++) if (rs[i] > 0 && rs[i] >= rs[i - 1] && rs[i] >= rs[i + 1]) peaks.push({ lag: (lo + i) * step, r: rs[i] });
      let best = 0;
      for (const p of peaks) if (p.r > best) best = p.r;
      // 두 배 주기에서도 값이 크게 나오므로, 최댓값의 85%를 넘는 첫 봉우리를 한 주기로 봐요
      const first = peaks.find(p => p.r >= 0.85 * best);
      return { r: best, period: first ? first.lag : null, peaks };
    }
    // 진짜 맥박인지 판정해요. 사람은 숨 쉴 때마다 박동 간격이 10~20%씩 바뀌어서
    // 주기만으로는 놓치기 쉬워요. 그래서 '박동 모양이 서로 닮았는지'를 함께 봐요.
    checkPulse() {
      const c = this.ch[this.active], fs = this.fs;
      if (c.inMotion(c.n)) {                       // 움직이는 동안에는 판정을 미뤄요
        if (!this.finger && this.pulseOk && --this.okCount <= 0) this.pulseOk = false;  // 손가락을 뗐으면 그래도 해제
        return;
      }
      const { r, period, peaks } = this.autocorr(c);
      this.periodicity = r;
      const since = this.beats.filter(b => b.idx >= this.restartIdx);
      const rrs = since.slice(-6).map(b => b.rr).filter(v => v != null);
      const med = rrs.length >= 3 ? median(rrs) : null;
      // ① 반복 주기와 실제로 센 박동 간격이 맞음
      const periodic = r >= 0.45 && med != null && period != null && Math.abs(period - med) <= 0.15 * med;
      if (med != null && !periodic) this.fixDoubleCount(since, med, peaks);
      // 박동 사이에 엉뚱한 봉우리를 끼워 세면 간격이 매번 1.5배 넘게 바뀌어요 (숨 때문에는 10~20%,
      // 조기 박동이나 한 번 놓친 박동은 한두 번만 튀어요)
      const q = since.slice(-5).map(b => b.rr).filter(v => v != null);
      let jumps = 0;
      for (let i = 1; i < q.length; i++) if (q[i] > 1.45 * q[i - 1] || q[i - 1] > 1.45 * q[i]) jumps++;
      const steady = jumps < 3;
      // ② 최근 4박동의 모양이 앞선 박동들과 닮음
      const sh = this.shapes.filter(v => c.n - v.idx < 6 * fs).slice(-4);
      this.shape = sh.length >= 4 ? median(sh.map(v => v.corr)) : null;
      const recent = this.beats.length && c.n - this.beats[this.beats.length - 1].idx < 2.5 * fs;
      const strong = c.medAmp != null && c.medAmp >= 0.4;     // 맥동이 밝기의 0.04% 이상 (세게 눌러 맥박이 없을 때 걸러요)
      const lit = c.dc >= 20000;                              // 반사광이 너무 약하면(손가락 없음) 더 엄격하게
      const good = recent && strong && steady && (lit ? (this.shape != null && this.shape >= 0.65) || periodic
        : this.shape != null && this.shape >= 0.85 && periodic);
      if (good) { this.pulseOk = true; this.okCount = 12; }      // 한 번 인정되면 3초 동안 아니어야 해제
      else if (this.pulseOk && --this.okCount <= 0) this.pulseOk = false;
    }
    // 이완기 물결(중복맥)이 큰 사람은 한 박동을 두 번 셀 수 있어요. 짧은·긴 간격이 번갈아 나오고
    // 반복 주기가 그 두 배라면, 박동 간격 기준을 진짜 주기로 바로잡아 작은 물결을 걸러 내게 해요.
    fixDoubleCount(since, med, peaks) {
      let r2 = 0, lag = 0;
      for (const p of peaks) if (Math.abs(p.lag - 2 * med) <= 0.3 * med && p.r > r2) { r2 = p.r; lag = p.lag; }
      if (r2 < 0.45) return;
      const q = since.slice(-5).map(b => b.rr);
      if (q.length < 5 || q.some(v => v == null)) return;
      for (let i = 2; i < 5; i++) {
        const d1 = q[i] - q[i - 1], d0 = q[i - 1] - q[i - 2];
        if (d1 * d0 >= 0 || Math.abs(d1) < 0.2 * med) return;
      }
      for (const k in this.ch) Object.assign(this.ch[k], { rrs: [lag, lag, lag], medRR: lag });
    }
    // 박동 시각 앞 0.25초 ~ 뒤 0.3초 파형을 잘라 최근 5박동의 평균 모양과 비교해요
    recordShape(idx) {
      const c = this.ch[this.active], y = c.y, M = c.N - 1, fs = this.fs;
      const pre = Math.round(0.25 * fs), L = pre + Math.round(0.3 * fs) + 1, i0 = Math.round(idx) - pre;
      const seg = new Float64Array(L);
      let m = 0;
      for (let k = 0; k < L; k++) { seg[k] = y[(i0 + k) & M]; m += seg[k]; }
      m /= L;
      let ss = 0;
      for (let k = 0; k < L; k++) { seg[k] -= m; ss += seg[k] * seg[k]; }
      const sd = Math.sqrt(ss) || 1;
      for (let k = 0; k < L; k++) seg[k] /= sd;
      if (this.segs.length >= 3 && this.segs[0].length === L) {
        const t = new Float64Array(L);
        for (const g of this.segs) for (let k = 0; k < L; k++) t[k] += g[k];
        let tm = 0, ts = 0, dot = 0;
        for (let k = 0; k < L; k++) tm += t[k];
        tm /= L;
        for (let k = 0; k < L; k++) { t[k] -= tm; ts += t[k] * t[k]; }
        ts = Math.sqrt(ts) || 1;
        for (let k = 0; k < L; k++) dot += seg[k] * t[k] / ts;
        this.shapes.push({ idx, corr: dot });
        if (this.shapes.length > 10) this.shapes.shift();
      }
      this.segs.push(seg);
      if (this.segs.length > 5) this.segs.shift();
    }
    score(k) {  // 최근 8초 동안 고르게 잡힌 박동 수
      const h = this.hist[k], n = this.n, fs = this.fs;
      const rrs = h.filter(b => n - b.idx <= 8 * fs && b.rr != null).map(b => b.rr);
      const med = median(rrs);
      if (!med) return 0;
      const good = rrs.filter(r => Math.abs(r - med) < 0.2 * med).length;
      const motion = n - this.ch[k].lastMotion < 3 * fs ? 2 : 0;
      return good - (rrs.length - good) - motion;   // 잡음은 간격이 들쭉날쭉해서 감점돼요
    }
    chooseChannel() {
      const other = this.active === 'ir' ? 'red' : 'ir';
      if (this.n - this.lastSwitch < 5 * this.fs) return;
      // LED가 고장 난 채널은 잡음만 있어도 박동처럼 보일 수 있어서, 맥박처럼 반복되는 채널로만 바꿔요
      if (this.score(other) >= this.score(this.active) + 3
        && this.autocorr(this.ch[other]).r >= Math.max(0.45, this.periodicity)) { this.active = other; this.lastSwitch = this.n; }
    }
    emit(b) {
      const fs = this.fs;
      if (this.lastEmit != null && b.idx - this.lastEmit < 0.28 * fs) return null;
      const rr = this.lastEmit != null && b.idx - this.lastEmit < 2.2 * fs ? b.idx - this.lastEmit : null;
      this.lastEmit = b.idx;
      this.recordShape(b.idx);
      const beat = { idx: b.idx, rr, amp: b.amp, ch: this.active, ok: this.pulseOk && !this.lifted };
      this.beats.push(beat);
      if (this.beats.length > 40) this.beats.shift();
      return beat;
    }
    get display() { const c = this.ch[this.active]; return c.blanking ? NaN : c.v; }
    // 신호 상태 요약 (품질 점수와 안내 문구는 Hub에서 만듦)
    summary() {
      const n = this.n, fs = this.fs, c = this.ch[this.active];
      const recent = this.beats.filter(b => n - b.idx < 8 * fs);
      const rrs = recent.map(b => b.rr).filter(r => r != null).slice(-6);
      let cv = null;
      if (rrs.length >= 3) {
        const m = rrs.reduce((s, v) => s + v, 0) / rrs.length;
        cv = Math.sqrt(rrs.reduce((s, v) => s + (v - m) * (v - m), 0) / rrs.length) / m;
      }
      return {
        beats: recent.length,
        lastBeatAge: recent.length ? (n - recent[recent.length - 1].idx) / fs : Infinity,
        cv,
        pi: c.medAmp != null ? c.medAmp / 10 : null,           // 관류지수(%) = 맥동 크기 ÷ 밝기
        motionAge: (n - Math.max(this.ch.ir.lastMotion, this.ch.red.lastMotion)) / fs,
        sinceFinger: (n - this.fingerAt) / fs,
        settling: c.blanking,
        periodicity: this.periodicity,
        shape: this.shape,
        lit: c.dc >= 20000,
        pulseOk: this.pulseOk && !this.lifted,
        channel: this.active
      };
    }
  }

  // ───────── 아두이노가 보낸 한 줄 해석 (브라우저·Node 공용) ─────────
  // 데이터 줄 "IR,Red"는 신호 처리기로 보내고, "#..." 상태 줄로 LED·손가락 상태를 따라가요.
  class StreamCore {
    constructor(sensitivity = 3) {
      this.proc = new PulseProcessor(FS, sensitivity);
      this.fw = { version: '', sensorOk: false, err: '', i2c: '', paIr: null, paRed: null, finger: false, refl: null, auto: true };
      this.badLines = 0;
      this.goodLines = 0;
    }
    // 반환: { type: 'sample', beat, display } | { type: 'status', tag } | null(알 수 없는 줄)
    line(line) {
      let c = line.charCodeAt(0);
      if (c !== 35 && !(c >= 48 && c <= 57)) {
        // 아두이노가 재시작할 때 줄 앞에 깨진 글자가 붙을 수 있어요
        const h = line.indexOf('#');
        if (h > 0) { line = line.slice(h); c = 35; }
      }
      const proc = this.proc, fw = this.fw;
      if (c >= 48 && c <= 57) {
        const k = line.indexOf(',');
        const ir = k > 0 ? +line.slice(0, k) : NaN, red = k > 0 ? +line.slice(k + 1) : NaN;
        if (!(ir >= 0 && red >= 0 && ir <= 262143 && red <= 262143)) { this.badLines++; return null; }
        // 전송 중에 글자 하나가 빠지면 값이 1/10이 돼요: 자릿수가 바뀌면서 갑자기 25% 넘게 튀면 버려요
        const dig = k * 100 + (line.length - k - 1), last = this.lastLine;
        if (last && dig !== last.dig && (Math.abs(ir - last.ir) > 0.25 * last.ir || Math.abs(red - last.red) > 0.25 * last.red) && !this.skipped) {
          this.skipped = true;
          this.badLines++;
          return null;
        }
        this.skipped = false;
        this.lastLine = { dig, ir, red };
        this.goodLines++;
        const beat = proc.push(ir, red);
        return { type: 'sample', beat, display: fw.finger || proc.pulseOk ? proc.display : NaN };  // 손가락이 없으면 평평하게
      }
      if (c !== 35) { this.badLines++; return null; }  // '#'
      const parts = line.slice(1).split(/\s+/), tag = parts.shift();
      if (tag === 'HELLO') { fw.version = parts.join(' '); }
      else if (tag === 'OK') { fw.sensorOk = true; fw.err = ''; fw.i2c = ''; proc.restart(); }
      else if (tag === 'ERR') { fw.sensorOk = false; fw.err = parts.join(' '); }
      else if (tag === 'I2C') { fw.i2c = parts.join(' '); }
      else if (tag === 'OVF') {
        // 'OVF n' = 센서 FIFO가 넘쳐서 샘플 n개를 잃었다는 뜻이에요. 그런데 호환 칩 중에는 넘치지 않았는데도
        // 샘플마다 'OVF 1'을 보내는 것이 있어서, 매번 끊김으로 처리하면 맥박을 영영 못 잡아요.
        // 몇 개(30ms 이하) 빠진 건 맥박 모양에 거의 영향이 없으니 무시하고, 1초 안에 또 오면 믿을 수 없는 값이라 무시해요.
        const lost = parseInt(parts[0], 10) || 0, last = this.lastOvf;
        this.lastOvf = proc.n;
        if (lost < OVF_GAP || (last != null && proc.n - last < FS)) return null;
        proc.gap();
      }
      else if (tag === 'STAT') {
        const [pi, pr, f, r, au] = parts.map(Number);
        if (fw.paIr != null && (pi !== fw.paIr || pr !== fw.paRed)) {
          // LED 밝기가 바뀌면 처음부터 다시 하지 않고 밝기 비율만큼 보정해요
          if (fw.paIr > 0 && fw.paRed > 0 && pi > 0 && pr > 0) proc.rescaleLed(pi / fw.paIr, pr / fw.paRed);
          else proc.restart();
        }
        Object.assign(fw, { paIr: pi, paRed: pr, refl: r, auto: !!au, sensorOk: true, err: '' });
        if (!!f !== fw.finger) { fw.finger = !!f; proc.setFinger(!!f); }
      }
      return { type: 'status', tag };
    }
  }

  const api = { PpgChannel, PulseProcessor, StreamCore, SENSITIVITY, FS, SAT, BAUD };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ═════════════════════ 여기부터 브라우저 전용 ═════════════════════

  const nowAbs = () => performance.timeOrigin + performance.now();   // 모든 창(iframe 포함)에서 같은 기준의 시각(ms)
  const store = {
    get(k, d) { try { const v = localStorage.getItem('heartSensor.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('heartSensor.' + k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } }
  };
  const COLOR = { green: 'oklch(0.66 0.15 155)', amber: 'oklch(0.75 0.15 70)', red: 'oklch(0.62 0.19 25)', gray: '#8A93A0' };
  const SHELL_NAME = 'heart-sensor-shell';
  const USB_NAMES = { 0x2341: 'Arduino', 0x2A03: 'Arduino', 0x1A86: 'CH340', 0x0403: 'FTDI', 0x10C4: 'CP210x', 0x239A: 'Adafruit', 0x303A: 'ESP32' };

  // ───────── 최근 파형 보관 + 그리기 ─────────
  class WaveBuffer {
    constructor() {
      this.cap = 1600;
      this.t = new Float64Array(this.cap);
      this.v = new Float32Array(this.cap);
      this.head = 0;
      this.len = 0;
      this.lo = null;
      this.hi = null;
    }
    push(t0, dt, vs) {
      for (let i = 0; i < vs.length; i++) {
        this.t[this.head] = t0 + i * dt;
        this.v[this.head] = vs[i] == null ? NaN : vs[i];
        this.head = (this.head + 1) % this.cap;
        if (this.len < this.cap) this.len++;
      }
    }
    export() {
      const t = [], v = [];
      for (let k = this.len; k > 0; k--) { const i = (this.head - k + this.cap) % this.cap; t.push(this.t[i]); v.push(this.v[i]); }
      return { t, v };
    }
    import(d) {
      this.head = this.len = 0;
      for (let i = 0; i < d.t.length; i++) this.push(d.t[i], 0, [d.v[i]]);
    }
    // o: w, h, win(초), top, bot, delay(ms), stroke(색 또는 그라디언트), lineWidth, dot, marks[{t, text, color}], font
    draw(ctx, o) {
      const delay = o.delay ?? 250, end = nowAbs() - delay, start = end - o.win * 1000;
      const pts = [], vals = [];
      for (let k = this.len; k > 0; k--) {
        const i = (this.head - k + this.cap) % this.cap, t = this.t[i];
        if (t < start - 50 || t > end) continue;
        const v = this.v[i];
        pts.push(t, v);
        if (v === v) vals.push(v);
      }
      // 화면 높이에 맞춰 크기를 부드럽게 조절. 순간적으로 튀는 값(움직임)은 무시하도록 상·하위 3%는 빼고 봐요.
      if (vals.length > 20) {
        vals.sort((a, b) => a - b);
        let lo = vals[Math.floor(vals.length * 0.03)], hi = vals[Math.ceil(vals.length * 0.97) - 1];
        const mid = (hi + lo) / 2, span = Math.max(hi - lo, 0.6) * 1.1;
        lo = mid - span / 2; hi = mid + span / 2;
        if (this.lo == null) { this.lo = lo; this.hi = hi; }
        this.lo += (lo - this.lo) * 0.08;
        this.hi += (hi - this.hi) * 0.08;
      } else if (!vals.length) {
        this.lo = this.hi = null;
      }
      const top = o.top, bot = o.bot, X = t => (t - start) / (end - start) * o.w;
      const Y = v => (v !== v || this.lo == null) ? (top + bot) / 2
        : clamp(bot - (v - this.lo) / (this.hi - this.lo || 1) * (bot - top), top - 4, bot + 4);
      ctx.beginPath();
      let ly = (top + bot) / 2, any = false;
      for (let k = 0; k < pts.length; k += 2) {
        const x = X(pts[k]), y = Y(pts[k + 1]);
        if (!any) { ctx.moveTo(x, y); any = true; } else ctx.lineTo(x, y);
        ly = y;
      }
      if (!any) { ctx.moveTo(0, ly); ctx.lineTo(o.w, ly); }
      ctx.strokeStyle = o.stroke;
      ctx.lineWidth = o.lineWidth || 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      if (o.dot) { ctx.beginPath(); ctx.arc(o.w - 3, ly, o.dotSize || 3, 0, Math.PI * 2); ctx.fillStyle = o.dotColor || o.stroke; ctx.fill(); }
      if (o.marks && o.marks.length) {
        ctx.font = o.font || '700 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        for (const m of o.marks) {
          // 박동 시각(가장 가파른 지점) 뒤 0.35초 안의 꼭대기에 숫자를 달아요
          let bx = null, by = Infinity;
          for (let k = 0; k < pts.length; k += 2) {
            const t = pts[k];
            if (t < m.t || t > m.t + 350) continue;
            const y = Y(pts[k + 1]);
            if (y < by) { by = y; bx = X(t); }
          }
          if (bx == null || bx < 18) continue;
          ctx.globalAlpha = Math.min(1, bx / 80);
          ctx.fillStyle = m.color || '#3A4350';
          ctx.fillText(m.text, bx, Math.max(12, by - 9));
          ctx.globalAlpha = 1;
        }
      }
      return ly;
    }
  }

  // ───────── 허브: 시리얼 연결 + 신호 처리 + 상태 ─────────
  class Hub {
    constructor() {
      this.supported = !!navigator.serial;
      this.settings = Object.assign({ source: 'sensor', sensitivity: 3, ledAuto: true, led: 60 }, store.get('settings', {}));
      if (!this.supported) this.settings.source = 'sim';
      this.listeners = new Set();
      this.port = null;
      this.reader = null;
      this.conn = 'idle';
      this.connError = '';
      this.portName = '';
      this.sendChain = Promise.resolve();
      this.waveBuf = new WaveBuffer();
      this.log = [];
      this.raw = [];             // 최근 원신호 줄 (문제 분석용 '원신호 저장')
      this.resetStream();
      this.status = this.buildStatus();
      setInterval(() => this.tick(), 250);
      if (this.supported) {
        navigator.serial.addEventListener('connect', e => {
          if (!this.port && this.settings.source === 'sensor') this.open(e.target);
        });
        navigator.serial.addEventListener('disconnect', e => {
          if (this.port && e.target === this.port) this.closed();
        });
        this.autoConnect();
      }
    }
    resetStream() {
      this.core = new StreamCore(this.settings.sensitivity);
      this.lineBuf = '';
      this.lastData = 0;
      this.wavePending = [];
      this.beatPending = [];
      this.lastFlush = 0;
      this.timing = { dt: 1000 / FS, nRef: null, tRef: null, n0: null, t0: null, fs: null };
      this.lastBeat = null;
      this.rrs = [];
    }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(ev) { for (const fn of this.listeners) { try { fn(ev); } catch (e) { console.error(e); } } }
    saveSettings() { store.set('settings', this.settings); }

    // ── 연결 ──
    async autoConnect() {
      try {
        const ports = await navigator.serial.getPorts();
        if (!ports.length || this.port || this.settings.source !== 'sensor') return;
        const last = store.get('port', null);
        const pick = ports.find(p => { const i = p.getInfo(); return last && i.usbVendorId === last.v && i.usbProductId === last.p; }) || (ports.length === 1 ? ports[0] : null);
        if (pick) this.open(pick);
      } catch { /* 권한 없음 */ }
    }
    async connect() {
      if (!this.supported) return;
      try {
        const port = await navigator.serial.requestPort();
        if (this.port === port) return;
        if (this.port) await this.disconnect();
        if (this.settings.source !== 'sensor') this.setSource('sensor');
        await this.open(port);
      } catch (e) {
        if (e.name !== 'NotFoundError') { this.conn = 'error'; this.connError = e.message || String(e); this.update(); }
      }
    }
    async open(port) {
      if (this.port) return;
      this.port = port;
      this.conn = 'connecting';
      this.update();
      try {
        await port.open({ baudRate: BAUD, bufferSize: 16384 });
      } catch (e) {
        this.port = null;
        this.conn = 'error';
        this.connError = e.name === 'NetworkError' || e.name === 'InvalidStateError'
          ? '포트를 열 수 없어요 · 아두이노 IDE의 시리얼 모니터/플로터가 켜져 있으면 닫아 주세요'
          : (e.message || String(e));
        this.update();
        return;
      }
      const info = port.getInfo();
      store.set('port', { v: info.usbVendorId, p: info.usbProductId });
      this.portName = USB_NAMES[info.usbVendorId] || 'USB 시리얼';
      this.resetStream();
      this.conn = 'waiting';
      this.openedAt = nowAbs();
      this.update();
      this.readLoop(port);
    }
    async readLoop(port) {
      const dec = new TextDecoder();
      while (this.port === port && port.readable) {
        const reader = this.reader = port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            this.feed(dec.decode(value, { stream: true }));
          }
        } catch (e) {
          // 잡음으로 생긴 일시적 오류(BufferOverrun, Framing 등)는 다시 읽고, 장치가 빠졌으면 멈춰요
        } finally {
          try { reader.releaseLock(); } catch { /* 이미 해제됨 */ }
        }
      }
      if (this.port === port) this.closed();
    }
    async disconnect() {
      const port = this.port;
      if (!port) return;
      this.port = null;
      const r = this.reader;
      this.reader = null;
      try { if (r) await r.cancel(); } catch { /* 무시 */ }
      try { await port.close(); } catch { /* 무시 */ }
      this.conn = 'idle';
      this.update();
    }
    closed() {  // USB가 뽑히는 등 예상치 못하게 끊김
      const port = this.port;
      this.port = null;
      this.reader = null;
      if (port) port.close().catch(() => {});
      this.conn = 'lost';
      this.update();
    }
    send(cmd) {
      const port = this.port;
      if (!port || !port.writable) return;
      this.sendChain = this.sendChain.then(async () => {
        if (!port.writable) return;
        const w = port.writable.getWriter();
        try { await w.write(new TextEncoder().encode(cmd + '\n')); } catch { /* 무시 */ } finally { w.releaseLock(); }
      });
    }
    syncFirmware() {  // 아두이노는 연결될 때마다 재시작되므로 설정을 다시 보내요
      this.send(this.settings.ledAuto ? 'A' : 'M' + this.settings.led);
    }

    // ── 수신 ──
    feed(text) {
      this.lineBuf += text;
      if (this.lineBuf.length > 65536) this.lineBuf = this.lineBuf.slice(-256);
      const t = nowAbs();
      let i;
      while ((i = this.lineBuf.indexOf('\n')) >= 0) {
        const line = this.lineBuf.slice(0, i).trim();
        this.lineBuf = this.lineBuf.slice(i + 1);
        if (!line) continue;
        this.raw.push(line);
        if (this.raw.length > 15000) this.raw.splice(0, this.raw.length - 12000);  // 약 2분
        this.onLine(line, t);
      }
      this.flush(t, false);
    }
    get proc() { return this.core.proc; }
    get fw() { return this.core.fw; }
    get badLines() { return this.core.badLines; }
    get goodLines() { return this.core.goodLines; }
    onLine(line, t) {
      const r = this.core.line(line);
      if (!r) return;
      if (r.type === 'sample') {
        this.lastData = t;
        if (this.conn !== 'ok') { this.conn = 'ok'; this.statusDirty = true; }
        this.wavePending.push(r.display);
        if (r.beat) this.beatPending.push(r.beat);
        return;
      }
      if (r.tag === 'HELLO') this.syncFirmware();
      if (r.tag === 'OVF') this.timing.n0 = null;
      this.statusDirty = true;
    }
    // 샘플 번호 → 실제 시각. 시리얼은 몇 개씩 몰려서 오므로, 도착 시각 중 가장 이른 것을 기준으로 잡아요.
    updateTiming(n, t) {
      const tm = this.timing;
      if (tm.n0 == null) { tm.n0 = n; tm.t0 = t; }
      else if (t - tm.t0 > 10000) {
        const fs = (n - tm.n0) / (t - tm.t0) * 1000;
        tm.fs = fs;
        if (fs >= 85 && fs <= 115) tm.dt = 1000 / fs;
      }
      if (tm.nRef == null) { tm.nRef = n; tm.tRef = t; return; }
      const pred = tm.tRef + (n - tm.nRef) * tm.dt;
      tm.tRef = t < pred ? t : pred + (t - pred) * 0.02;
      tm.nRef = n;
    }
    timeOf(idx) { const tm = this.timing; return tm.tRef - (tm.nRef - idx) * tm.dt; }
    flush(t, force) {
      if (!this.wavePending.length && !this.beatPending.length) return;
      this.updateTiming(this.proc.n, t);
      if (this.beatPending.length) { for (const b of this.beatPending) this.onBeat(b); this.beatPending = []; }
      if (this.wavePending.length && (force || this.wavePending.length >= 8 || t - this.lastFlush > 40)) {
        const v = this.wavePending, n = this.proc.n, t0 = this.timeOf(n - v.length + 1);
        this.wavePending = [];
        this.lastFlush = t;
        this.waveBuf.push(t0, this.timing.dt, v);
        this.emit({ type: 'wave', t0, dt: this.timing.dt, v });
      }
    }
    onBeat(b) {
      if (!b.ok) return;  // 아직 규칙적인 맥박이 확인되지 않았어요
      const rr = b.rr != null ? b.rr * this.timing.dt : null;
      const beat = { t: this.timeOf(b.idx), rr, bpm: rr ? 60000 / rr : null, amp: b.amp, ch: b.ch };
      if (!this.lastBeat || beat.t - this.lastBeat.t > 2500) this.rrs = [];  // 끊겼다 다시 잡히면(다른 사람일 수도) 이전 BPM은 버려요
      this.lastBeat = beat;
      if (rr) { this.rrs.push(rr); if (this.rrs.length > 5) this.rrs.shift(); }
      if (this.log.length < 50000) {
        this.log.push({ at: Date.now(), bpm: beat.bpm, rr, amp: b.amp, ch: b.ch, pa: this.fw.paIr, sens: this.settings.sensitivity, level: this.status.level });
      }
      this.emit({ type: 'beat', beat });
    }

    // ── 상태 ──
    tick() {
      if (this.port) this.flush(nowAbs(), true);
      this.update();
    }
    update() {
      this.status = this.buildStatus();
      this.statusDirty = false;
      this.emit({ type: 'status', status: this.status });
      if (this.panel) this.panel.render();
    }
    buildStatus() {
      const s = this.settings, fw = this.fw, sum = this.proc.summary(), now = nowAbs();
      let conn = this.conn;
      if (conn === 'ok' && now - this.lastData > 2000) conn = fw.err ? 'nosensor' : 'nodata';
      if (conn === 'waiting' && fw.err) conn = 'nosensor';
      else if (conn === 'waiting' && now - this.openedAt > 5000) conn = 'nodata';
      const beatAge = this.lastBeat ? (now - this.lastBeat.t) / 1000 : Infinity;
      const pulse = sum.pulseOk && beatAge < 3.5;
      const finger = fw.finger || pulse;
      let level = 0, label = '', hint = '', tone = 'idle';
      if (s.source === 'sim') {
        level = 4; label = '시뮬레이션'; hint = '센서 없이 만든 시뮬레이션 데이터를 보여주고 있어요'; tone = 'idle';
      } else if (!this.supported) {
        label = '연결 불가'; hint = '이 브라우저는 센서 연결을 지원하지 않아요 · Chrome 또는 Edge로 열어 주세요'; tone = 'bad';
      } else if (conn === 'idle' || conn === 'lost' || conn === 'error') {
        label = '연결 안 됨'; tone = 'bad';
        hint = conn === 'lost' ? '연결이 끊어졌어요 · USB 케이블을 확인하고 다시 연결해 주세요'
          : conn === 'error' ? this.connError : '‘센서 연결’을 눌러 아두이노를 연결해 주세요';
      } else if (conn === 'connecting' || conn === 'waiting') {
        label = '연결 중'; hint = '아두이노가 준비되는 중이에요…'; tone = 'warn';
      } else if (conn === 'nodata') {
        label = '데이터 없음'; tone = 'bad';
        hint = this.badLines > 20 && !this.goodLines ? '알 수 없는 데이터가 와요 · HeartSensor 펌웨어를 업로드해 주세요'
          : '아두이노에서 데이터가 오지 않아요 · HeartSensor 펌웨어를 업로드했는지 확인해 주세요';
      } else if (conn === 'nosensor') {
        label = '센서 없음'; tone = 'bad';
        const wrong = /WRONG_PART/.test(fw.err);
        hint = wrong ? 'MAX30102가 아닌 센서가 연결됐어요 (' + fw.err.split(' ')[1] + ')'
          : '센서를 찾을 수 없어요 · VIN→5V, GND→GND, SDA→A4, SCL→A5 배선을 확인해 주세요'
            + (fw.i2c && fw.i2c !== 'none' ? ' (발견된 I2C 장치: ' + fw.i2c + ')' : '');
      } else if (!finger) {
        label = '손가락 없음'; hint = '손가락 끝을 센서 창에 가볍게 올려 주세요'; tone = 'warn';
      } else if (this.proc.lastIr >= SAT && fw.paIr != null && (fw.paIr <= 2 || (!fw.auto && !pulse))) {
        level = 1; label = '빛이 너무 강함'; tone = 'warn';
        hint = fw.auto ? '손가락으로 센서 창을 완전히 덮어 주세요' : '설정에서 LED 밝기를 ‘자동’으로 바꾸거나 더 낮춰 주세요';
      } else if (!pulse) {
        level = 1; label = '신호 찾는 중'; tone = 'warn';
        hint = sum.motionAge < 2 ? '손가락을 움직이지 말고 그대로 있어 주세요'
          : sum.sinceFinger < 7 || sum.settling ? '맥박을 찾고 있어요… 그대로 기다려 주세요'
          : sum.pi != null && sum.pi < 0.08 ? '신호가 약해요 · 누르는 힘을 살짝 빼거나 손을 비벼 따뜻하게 해 주세요'
          : '손가락 끝 가운데(지문 부분)를 센서 창 한가운데에 맞춰 주세요';
      } else {
        level = 4;
        if (sum.cv != null && sum.cv > 0.12) level = 3;
        if (sum.cv != null && sum.cv > 0.22) level = 2;
        const moving = sum.motionAge < 3;
        if (moving) level = Math.min(level, 2);
        if (sum.pi != null && sum.pi < 0.1) level = Math.min(level, 3);
        label = level >= 3 ? '양호' : '불안정';
        tone = level >= 3 ? 'good' : 'warn';
        hint = level === 4 ? '신호가 안정적이에요' : level === 3 ? '좋아요 · 이대로 유지해 주세요'
          : moving ? '움직이면 오차가 생겨요 · 가만히 있어 주세요' : '박동이 고르게 잡히지 않아요 · 손을 책상에 대고 힘을 빼 주세요';
      }
      const connected = !!this.port;
      const badge = !this.supported ? { text: '센서 연결 불가', dot: COLOR.amber }
        : s.source === 'sim' ? { text: '시뮬레이션 데이터', dot: COLOR.gray }
        : conn === 'ok' ? { text: '센서 연결됨', dot: COLOR.green }
        : conn === 'connecting' || conn === 'waiting' ? { text: '센서 연결 중…', dot: COLOR.amber }
        : conn === 'nodata' || conn === 'nosensor' ? { text: '센서 확인 필요', dot: COLOR.amber }
        : { text: '센서 연결하기', dot: COLOR.red };
      const med = median(this.rrs);
      return {
        source: s.source, supported: this.supported, conn, connected, portName: this.portName,
        level, label, hint, tone, color: COLOR[{ good: 'green', warn: 'amber', bad: 'red', idle: 'gray' }[tone]],
        finger, pulse, bpm: pulse && med ? Math.round(60000 / med) : null, badge,
        settings: Object.assign({}, s),
        diag: {
          ir: this.proc.lastIr, red: this.proc.lastRed, paIr: fw.paIr, paRed: fw.paRed, refl: fw.refl, auto: fw.auto,
          pi: sum.pi, periodicity: sum.periodicity, channel: sum.channel, fs: this.timing.fs, firmware: fw.version,
          beats: this.log.length
        }
      };
    }

    // ── 설정 ──
    command(cmd, arg) {
      if (cmd === 'panel') this.openPanel();
      else if (cmd === 'connect') this.connect();
      else if (cmd === 'disconnect') this.disconnect();
      else if (cmd === 'source') this.setSource(arg);
    }
    setSource(src) {
      if (src === 'sensor' && !this.supported) return;
      this.settings.source = src;
      this.saveSettings();
      if (src === 'sensor' && !this.port) this.autoConnect();
      this.update();
    }
    setSensitivity(level) {
      this.settings.sensitivity = clamp(level, 1, 5);
      this.proc.setSensitivity(this.settings.sensitivity);
      this.saveSettings();
      this.update();
    }
    setLed(auto, value) {
      this.settings.ledAuto = auto;
      if (value != null) this.settings.led = clamp(Math.round(value), 1, 255);
      this.saveSettings();
      this.syncFirmware();
      this.update();
    }
    // 최근 약 2분 동안 아두이노가 보낸 줄을 그대로 저장해요. tools/replay.js 로 다시 분석할 수 있어요.
    exportRaw() {
      const pad = v => String(v).padStart(2, '0'), d = new Date(), st = this.status;
      const head = [`# heart-sensor raw ${d.toISOString()}`, `# settings ${JSON.stringify(this.settings)}`,
        `# status ${st.conn} ${st.label} fs=${this.timing.fs ? this.timing.fs.toFixed(2) : '?'} ua=${navigator.userAgent}`];
      this.download(head.concat(this.raw).join('\n') + '\n', 'text/plain',
        `원신호_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`);
    }
    download(text, type, name) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
    exportCsv() {
      const pad = v => String(v).padStart(2, '0');
      const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
      const rows = [['시각', 'BPM', 'RR간격(ms)', '맥동크기(%)', '채널', 'IR LED(mA)', '민감도', '신호품질(0~4)']];
      for (const b of this.log) {
        rows.push([fmt(new Date(b.at)), b.bpm ? b.bpm.toFixed(1) : '', b.rr ? b.rr.toFixed(0) : '', (b.amp / 10).toFixed(3),
          b.ch === 'ir' ? 'IR' : 'Red', b.pa != null ? (b.pa * 0.2).toFixed(1) : '', b.sens, b.level]);
      }
      const d = new Date();
      this.download('\uFEFF' + rows.map(r => r.join(',')).join('\r\n'), 'text/csv',
        `심박기록_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.csv`);
    }
    openPanel() {
      if (!this.panel) this.panel = new Panel(this);
      this.panel.open();
    }
  }

  // ───────── 센서 설정 패널 ─────────
  const PANEL_CSS = `
.hsp-back{position:fixed;inset:0;background:rgba(15,20,25,.28);z-index:2147483000;display:flex;justify-content:flex-end;opacity:0;transition:opacity .15s}
.hsp-back.on{opacity:1}
.hsp{width:min(400px,100vw);height:100%;overflow:auto;background:#F3F4F6;box-shadow:-12px 0 32px rgba(15,20,25,.12);padding:18px 16px 24px;box-sizing:border-box;
  font-family:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#0F1419;-webkit-font-smoothing:antialiased;letter-spacing:-.005em;
  transform:translateX(24px);transition:transform .18s ease}
.hsp-back.on .hsp{transform:none}
.hsp *{box-sizing:border-box}
.hsp-head{display:flex;align-items:center;justify-content:space-between;margin:2px 4px 14px}
.hsp-title{font-size:18px;font-weight:700;letter-spacing:-.02em}
.hsp-x{width:36px;height:36px;border:none;border-radius:10px;background:transparent;font-size:20px;color:#5B6573;cursor:pointer}
.hsp-x:hover{background:#E6E8EC;color:#0F1419}
.hsp-card{background:#FFF;border:1px solid #E6E8EC;border-radius:16px;padding:16px 18px;margin-bottom:12px}
.hsp-h{font-size:13px;color:#5B6573;font-weight:700;margin-bottom:10px}
.hsp-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.hsp-state{display:flex;align-items:center;gap:8px;font-size:17px;font-weight:700}
.hsp-dot{width:9px;height:9px;border-radius:50%;flex:none}
.hsp-hint{font-size:13px;color:#5B6573;line-height:1.5;margin-top:8px;text-wrap:pretty}
.hsp-btn{height:40px;padding:0 16px;border:none;border-radius:10px;background:#0F1419;color:#FFF;font:inherit;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap}
.hsp-btn:hover{background:#2A313C}
.hsp-btn.ghost{background:#FFF;color:#0F1419;border:1px solid #D5D9DF}
.hsp-btn.ghost:hover{background:#F5F6F8}
.hsp-btn.wide{width:100%;height:46px;font-size:15px;margin-top:12px}
.hsp-seg{display:flex;background:#F1F2F4;border-radius:10px;padding:3px;gap:3px;margin-top:12px}
.hsp-seg button{flex:1;height:34px;border:none;border-radius:8px;background:transparent;font:inherit;font-size:13.5px;font-weight:600;color:#5B6573;cursor:pointer}
.hsp-seg button.on{background:#FFF;color:#0F1419;box-shadow:0 1px 2px rgba(15,20,25,.08)}
.hsp-seg button:disabled{opacity:.4;cursor:not-allowed}
.hsp-scale{display:flex;justify-content:space-between;font-size:11.5px;color:#8A93A0;margin-top:6px}
.hsp-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;margin-top:12px}
.hsp-k{font-size:11.5px;color:#8A93A0;font-weight:600}
.hsp-v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px}
.hsp-bars{display:flex;align-items:flex-end;gap:3px;height:18px}
.hsp-bars span{width:5px;border-radius:1.5px}
.hsp canvas{width:100%;height:64px;display:block;margin-top:10px}
.hsp-range{width:100%;margin-top:12px;accent-color:#0F1419}
.hsp-note{font-size:12px;color:#8A93A0;line-height:1.5;margin-top:10px;text-wrap:pretty}
`;
  class Panel {
    constructor(hub) {
      this.hub = hub;
      const st = document.createElement('style');
      st.textContent = PANEL_CSS;
      document.head.appendChild(st);
      const el = this.el = document.createElement('div');
      el.className = 'hsp-back';
      el.innerHTML = `
<div class="hsp" role="dialog" aria-label="센서 설정">
  <div class="hsp-head"><div class="hsp-title">센서 설정</div><button class="hsp-x" data-a="close" aria-label="닫기">✕</button></div>
  <div class="hsp-card">
    <div class="hsp-h">연결</div>
    <div class="hsp-row"><div class="hsp-state"><span class="hsp-dot" data-f="cdot"></span><span data-f="ctext"></span></div><button class="hsp-btn ghost" data-a="disconnect" data-f="discBtn">연결 해제</button></div>
    <div class="hsp-hint" data-f="chint"></div>
    <button class="hsp-btn wide" data-a="connect" data-f="connBtn">센서 연결</button>
    <div class="hsp-seg" data-f="src"><button data-a="src-sensor">센서</button><button data-a="src-sim">시뮬레이션</button></div>
  </div>
  <div class="hsp-card">
    <div class="hsp-row"><div class="hsp-h" style="margin:0">신호</div><div class="hsp-bars" data-f="bars"><span></span><span></span><span></span><span></span></div></div>
    <div class="hsp-state" style="margin-top:6px"><span class="hsp-dot" data-f="sdot"></span><span data-f="stext"></span></div>
    <div class="hsp-hint" data-f="shint"></div>
    <canvas data-f="wave"></canvas>
    <div class="hsp-grid">
      <div><div class="hsp-k">심박수</div><div class="hsp-v" data-f="bpm"></div></div>
      <div><div class="hsp-k">관류지수 (맥동 크기)</div><div class="hsp-v" data-f="pi"></div></div>
      <div><div class="hsp-k">규칙성</div><div class="hsp-v" data-f="per"></div></div>
      <div><div class="hsp-k">사용 채널</div><div class="hsp-v" data-f="ch"></div></div>
    </div>
  </div>
  <div class="hsp-card">
    <div class="hsp-h">측정 민감도</div>
    <div class="hsp-seg" data-f="sens" style="margin-top:0"><button data-a="sens-1">1</button><button data-a="sens-2">2</button><button data-a="sens-3">3</button><button data-a="sens-4">4</button><button data-a="sens-5">5</button></div>
    <div class="hsp-scale"><span>낮음 · 잡음에 강함</span><span>높음 · 약한 맥박도 감지</span></div>
    <div class="hsp-note">박동을 자주 놓치면 높이고, 박동이 아닌데 숫자가 튀면 낮추세요. 기본값은 3이에요.</div>
  </div>
  <div class="hsp-card">
    <div class="hsp-h">LED 밝기</div>
    <div class="hsp-seg" data-f="led" style="margin-top:0"><button data-a="led-auto">자동 (권장)</button><button data-a="led-manual">직접 조절</button></div>
    <input class="hsp-range" type="range" min="1" max="255" step="1" data-f="ledRange">
    <div class="hsp-grid">
      <div><div class="hsp-k">적외선(IR) LED</div><div class="hsp-v" data-f="paIr"></div></div>
      <div><div class="hsp-k">적색(Red) LED</div><div class="hsp-v" data-f="paRed"></div></div>
      <div><div class="hsp-k">IR 신호 (최대 262143)</div><div class="hsp-v" data-f="ir"></div></div>
      <div><div class="hsp-k">반사지수</div><div class="hsp-v" data-f="refl"></div></div>
    </div>
    <div class="hsp-note">자동으로 두면 손가락 두께·피부색·누르는 힘에 맞춰 0.2초마다 밝기를 맞춰요. IR 신호가 9만~22만 사이면 알맞은 밝기예요.</div>
  </div>
  <div class="hsp-card">
    <div class="hsp-h">기록</div>
    <div class="hsp-row"><div style="font-size:14px;font-weight:600" data-f="logCount"></div>
      <div style="display:flex;gap:6px"><button class="hsp-btn ghost" data-a="clear">지우기</button><button class="hsp-btn" data-a="csv">CSV 저장</button></div></div>
    <div class="hsp-note">센서로 잡은 박동의 시각·BPM·RR 간격·신호 품질을 엑셀에서 열 수 있는 파일로 저장해요.</div>
    <div class="hsp-row" style="margin-top:14px;padding-top:12px;border-top:1px solid #EEF0F3"><div style="font-size:14px;font-weight:600">원신호 (최근 2분)</div>
      <button class="hsp-btn ghost" data-a="raw">원신호 저장</button></div>
    <div class="hsp-note">측정이 잘 안 될 때 손가락을 올린 채 30초 이상 기다린 뒤 저장해서 개발자에게 보내 주세요. 센서가 보낸 값을 그대로 담고 있어서 원인을 찾을 수 있어요.</div>
  </div>
  <div class="hsp-note" style="text-align:center" data-f="foot"></div>
</div>`;
      this.f = {};
      el.querySelectorAll('[data-f]').forEach(n => { this.f[n.dataset.f] = n; });
      el.addEventListener('click', e => {
        if (e.target === el) return this.close();
        const a = e.target.closest('[data-a]');
        if (!a) return;
        const act = a.dataset.a, h = this.hub;
        if (act === 'close') this.close();
        else if (act === 'connect') h.connect();
        else if (act === 'disconnect') h.disconnect();
        else if (act.startsWith('src-')) h.setSource(act.slice(4));
        else if (act.startsWith('sens-')) h.setSensitivity(+act.slice(5));
        else if (act === 'led-auto') h.setLed(true);
        else if (act === 'led-manual') h.setLed(false, h.fw.paIr || h.settings.led);
        else if (act === 'csv') h.exportCsv();
        else if (act === 'raw') h.exportRaw();
        else if (act === 'clear') { h.log = []; h.update(); }
      });
      this.f.ledRange.addEventListener('input', e => this.hub.setLed(false, +e.target.value));
      this.onKey = e => { if (e.key === 'Escape') this.close(); };
    }
    open() {
      if (!this.el.isConnected) document.body.appendChild(this.el);
      requestAnimationFrame(() => this.el.classList.add('on'));
      document.addEventListener('keydown', this.onKey);
      this.render();
      const loop = () => { if (!this.isOpen) return; this.drawWave(); this.raf = requestAnimationFrame(loop); };
      this.isOpen = true;
      loop();
    }
    close() {
      this.isOpen = false;
      cancelAnimationFrame(this.raf);
      document.removeEventListener('keydown', this.onKey);
      this.el.classList.remove('on');
      setTimeout(() => { if (!this.isOpen) this.el.remove(); }, 180);
    }
    drawWave() {
      const c = this.f.wave, w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
      if (!w) return;
      if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      this.hub.waveBuf.draw(ctx, { w, h, win: 4, top: 6, bot: h - 6, stroke: COLOR.red, lineWidth: 1.75, dot: true });
    }
    render() {
      if (!this.isOpen) return;
      const h = this.hub, st = h.status, d = st.diag, f = this.f, s = h.settings;
      const txt = (k, v) => { if (f[k].textContent !== v) f[k].textContent = v; };
      const connText = !h.supported ? '이 브라우저는 지원하지 않아요'
        : st.conn === 'ok' ? '연결됨 · ' + st.portName
        : st.conn === 'connecting' || st.conn === 'waiting' ? '연결 중…'
        : st.conn === 'nodata' ? '연결됨 · 데이터 없음'
        : st.conn === 'nosensor' ? '연결됨 · 센서 없음'
        : st.conn === 'lost' ? '연결 끊김' : '연결 안 됨';
      txt('ctext', connText);
      f.cdot.style.background = st.conn === 'ok' ? COLOR.green : st.connected ? COLOR.amber : COLOR.red;
      txt('chint', !h.supported ? 'Web Serial을 지원하는 Chrome 또는 Edge(데스크톱)로 START.html을 열어 주세요.'
        : st.connected ? (st.conn === 'ok' ? '아두이노에서 1초에 100번씩 측정값을 받고 있어요.' : st.hint)
        : st.conn === 'error' ? st.hint : 'USB로 아두이노를 연결한 뒤 버튼을 누르고, 목록에서 아두이노(또는 CH340/USB Serial)를 고르세요.');
      f.connBtn.style.display = st.connected || !h.supported ? 'none' : '';
      f.discBtn.style.display = st.connected ? '' : 'none';
      const [bs, bm] = f.src.children;
      bs.classList.toggle('on', s.source === 'sensor');
      bm.classList.toggle('on', s.source === 'sim');
      bs.disabled = !h.supported;
      // 신호
      const live = s.source === 'sensor';
      const sig = live ? st : h.buildStatusForSensor();
      txt('stext', sig.label);
      f.sdot.style.background = sig.color;
      txt('shint', sig.hint);
      [...f.bars.children].forEach((b, i) => { b.style.height = (6 + i * 4) + 'px'; b.style.background = i < sig.level ? sig.color : '#E3E6EA'; });
      txt('bpm', sig.bpm ? sig.bpm + ' BPM' : '—');
      txt('pi', d.pi != null && st.conn === 'ok' ? d.pi.toFixed(2) + '%' : '—');
      txt('per', st.conn === 'ok' && d.periodicity ? Math.round(d.periodicity * 100) + '%' : '—');
      txt('ch', st.conn === 'ok' ? (d.channel === 'ir' ? '적외선 (IR)' : '적색 (Red)') : '—');
      // 민감도·LED
      [...f.sens.children].forEach((b, i) => b.classList.toggle('on', s.sensitivity === i + 1));
      const [la, lm] = f.led.children;
      la.classList.toggle('on', s.ledAuto);
      lm.classList.toggle('on', !s.ledAuto);
      f.ledRange.style.display = s.ledAuto ? 'none' : '';
      if (document.activeElement !== f.ledRange) f.ledRange.value = s.led;
      const mA = v => v != null ? (v * 0.2).toFixed(1) + ' mA' : '—';
      txt('paIr', mA(d.paIr));
      txt('paRed', mA(d.paRed));
      txt('ir', st.conn === 'ok' ? Math.round(d.ir).toLocaleString() : '—');
      txt('refl', d.refl != null && st.conn === 'ok' ? String(d.refl) : '—');
      txt('logCount', `박동 ${h.log.length.toLocaleString()}개 기록됨`);
      txt('foot', (d.firmware ? '펌웨어 ' + d.firmware + ' · ' : '') + (d.fs ? '샘플 속도 ' + d.fs.toFixed(1) + 'Hz' : '115200 baud'));
    }
  }
  // 시뮬레이션 모드에서도 패널에서는 실제 센서 상태를 보여줘요
  Hub.prototype.buildStatusForSensor = function () {
    const src = this.settings.source;
    this.settings.source = 'sensor';
    try { return this.buildStatus(); } finally { this.settings.source = src; }
  };

  let hubInstance = null;
  const getHub = () => hubInstance || (hubInstance = new Hub());

  // ───────── START.html(바깥 창) 쪽: 안쪽 페이지에 연결을 빌려줘요 ─────────
  function host(iframe) {
    const hub = getHub();
    iframe.name = SHELL_NAME;  // 안쪽 페이지가 START.html 안에 있다는 걸 바로 알 수 있게
    const post = msg => { try { iframe.contentWindow.postMessage(Object.assign({ hs: 1 }, msg), '*'); } catch { /* 페이지 이동 중 */ } };
    hub.subscribe(post);
    window.addEventListener('message', e => {
      const d = e.data;
      if (e.source !== iframe.contentWindow || !d || d.hs !== 1) return;
      if (d.type === 'hello') {
        post({ type: 'welcome', status: hub.status, wave: hub.waveBuf.export() });
        if (d.page) { try { sessionStorage.setItem('heartSensor.page', d.page); } catch { /* 무시 */ } }
      } else if (d.type === 'cmd') {
        hub.command(d.cmd, d.arg);
      }
    });
    return hub;
  }

  // ───────── 디자인 페이지 쪽 ─────────
  class Client {
    constructor() {
      this.subs = new Set();
      this.status = { source: 'pending', badge: { text: '센서 확인 중…', dot: COLOR.gray } };
      this.wave = new WaveBuffer();
      this.mode = 'pending';
      if (window.parent !== window) {
        window.addEventListener('message', e => {
          if (e.source !== window.parent || !e.data || e.data.hs !== 1 || this.mode === 'local') return;
          this.onMsg(e.data);
        });
        const page = location.pathname.split('/').pop() + location.hash;
        try { window.parent.postMessage({ hs: 1, type: 'hello', page }, '*'); } catch { /* 무시 */ }
        // START.html 안이면 바깥 창의 연결을 기다리고, 다른 곳(디자인 도구 미리보기 등)에 들어 있으면 직접 연결해요
        if (window.name !== SHELL_NAME) this.fallback = setTimeout(() => { if (this.mode === 'pending') this.useLocal(); }, 1500);
      } else {
        this.useLocal();
      }
    }
    useLocal() {
      this.mode = 'local';
      this.hub = getHub();
      this.wave = this.hub.waveBuf;
      this.hub.subscribe(ev => this.onMsg(ev));
      this.onMsg({ type: 'status', status: this.hub.status });
    }
    onMsg(d) {
      if (d.type === 'welcome') {
        clearTimeout(this.fallback);
        this.mode = 'bridge';
        if (d.wave) this.wave.import(d.wave);
        d = { type: 'status', status: d.status };
      } else if (d.type === 'wave') {
        if (this.mode === 'bridge') this.wave.push(d.t0, d.dt, d.v);
      }
      if (d.type === 'status') this.status = d.status;
      for (const fn of this.subs) { try { fn(d); } catch (e) { console.error(e); } }
    }
    subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
    command(cmd, arg) {
      if (this.mode === 'local') this.hub.command(cmd, arg);
      else if (this.mode === 'bridge') window.parent.postMessage({ hs: 1, type: 'cmd', cmd, arg }, '*');
    }
    openPanel() { this.command('panel'); }
    get source() { return this.status.source; }
    drawWave(ctx, o) { return this.wave.draw(ctx, o); }
  }
  let clientInstance = null;
  const client = () => clientInstance || (clientInstance = new Client());

  Object.assign(api, { Hub, WaveBuffer, host, client, getHub, nowAbs, COLOR });
  root.HeartSensor = Object.assign(root.HeartSensor || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
