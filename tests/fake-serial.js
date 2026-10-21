// 브라우저 테스트용 가짜 아두이노. HeartSensor 펌웨어와 같은 형식으로 합성 맥파를 100Hz로 보내요.
// window.__fake = { hr, finger, pi, ovf, dropMs } 를 바꿔 상황을 흉내 낼 수 있어요.
// (ovf: 샘플 앞에 '#OVF 1'을 끼우는 비율, dropMs: 그 시간 동안 센서가 빠졌다가 다시 연결됨)
(() => {
  if (window.top !== window) return;
  const fake = window.__fake = { hr: 72, finger: true, pi: 0.012, ovf: window.__fakeOvf || 0, dropMs: 0, cmds: [], granted: false };
  class FakePort extends EventTarget {
    getInfo() { return { usbVendorId: 0x1A86, usbProductId: 0x7523 }; }
    async open() {
      const port = this, enc = new TextEncoder();
      let ctrl;
      this.readable = new ReadableStream({ start(c) { ctrl = c; }, cancel() { clearInterval(port.timer); } });
      this.writable = new WritableStream({ write(chunk) { fake.cmds.push(new TextDecoder().decode(chunk).trim()); } });
      fake.granted = true;
      let t0 = performance.now(), drop = null;
      let n = 0, nextBeat = 0.5, beats = [], seed = 1;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
      setTimeout(() => ctrl.enqueue(enc.encode('\0\xff#HELLO HeartSensor 1.0\n#OK MAX30102 rev=3\n')), 300);
      this.timer = setInterval(() => {
        const now = performance.now();
        let out = '';
        // 센서가 빠지면 펌웨어처럼 SENSOR_LOST → 2초마다 NO_SENSOR → 다시 연결되면 OK. 빠진 동안의 샘플은 없어요.
        if (!drop && fake.dropMs) { drop = { start: now, retry: now + 2000 }; out += '#ERR SENSOR_LOST\n'; }
        if (drop) {
          if (now >= drop.retry) {
            if (now - drop.start >= fake.dropMs) {
              out += '#OK MAX30102 rev=3\n';
              t0 += now - drop.start;
              drop = null;
              fake.dropMs = 0;
            } else { out += '#ERR NO_SENSOR\n#I2C none\n'; drop.retry += 2000; }
          }
          if (drop) { if (out) ctrl.enqueue(enc.encode(out)); return; }
        }
        const target = Math.floor((now - t0 - 400) / 10);
        while (n < target) {
          const t = n / 100;
          // 숨 쉴 때마다(4초 주기) 박동 간격이 ±12% 출렁이는 실제 사람처럼
          if (t >= nextBeat) { beats.push(nextBeat); nextBeat += 60 / fake.hr * (1 - 0.12 * Math.sin(2 * Math.PI * 0.25 * t) + 0.02 * rnd()); }
          beats = beats.filter(b => t - b < 1.5);
          let ac = 0;
          for (const b of beats) { const d = t - b; ac += Math.exp(-0.5 * ((d - 0.2) / 0.06) ** 2) + 0.35 * Math.exp(-0.5 * ((d - 0.45) / 0.09) ** 2); }
          const dc = fake.finger ? 150000 : 1900;
          const ir = Math.round(dc * (1 - (fake.finger ? fake.pi * ac : 0)) + 20 * rnd() * 2);
          const red = Math.round(ir * 0.75);
          if (fake.ovf && Math.random() < fake.ovf) out += '#OVF 1\n';
          out += ir + ',' + red + '\n';
          if (n % 50 === 0) out += `#STAT ${fake.finger ? 187 : 96} ${fake.finger ? 255 : 96} ${fake.finger ? 1 : 0} ${fake.finger ? 800 : 20} 1\n`;
          n++;
        }
        if (out) ctrl.enqueue(enc.encode(out));
      }, 30);
    }
    async close() { clearInterval(this.timer); this.readable = null; this.writable = null; }
  }
  const port = new FakePort();
  const serial = new EventTarget();
  serial.requestPort = async () => port;
  serial.getPorts = async () => (fake.granted ? [port] : []);
  Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
})();
