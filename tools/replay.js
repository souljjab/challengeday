// 설정 패널에서 저장한 '원신호' 파일을 다시 재생해서 박동 검출 과정을 1초 단위로 보여줘요.
//   node tools/replay.js 원신호_20261021_101500.txt [민감도 1~5]
// 측정이 잘 안 될 때 어디서 막히는지(LED 변경으로 재시작, 움직임, 규칙성 부족 등) 확인할 수 있어요.
const fs = require('fs');
const { StreamCore, FS } = require('../app/heart-sensor.js');

const file = process.argv[2];
if (!file) {
  console.log('사용법: node tools/replay.js <원신호 파일> [민감도 1~5]');
  process.exit(1);
}
const core = new StreamCore(+(process.argv[3] || 3));
const proc = core.proc;

const restarts = { led: 0, finger: 0, ovf: 0, ok: 0 };
let cause = null;
const origRestart = proc.restart.bind(proc);
proc.restart = () => { restarts[cause || 'ok']++; origRestart(); };

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
let samples = 0, beats = 0, okBeats = 0, okSamples = 0, sec = null;
const rows = [];
for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith('# ')) continue;
  const prev = { paIr: core.fw.paIr, paRed: core.fw.paRed, finger: core.fw.finger };
  cause = line.startsWith('#STAT') ? (core.fw.paIr != null ? 'led' : null) : line.startsWith('#OVF') ? 'ovf' : line.startsWith('#OK') ? 'ok' : null;
  if (line.startsWith('#STAT')) {
    const [pi, pr, f] = line.slice(6).split(/\s+/).map(Number);
    if (prev.paIr != null && pi === prev.paIr && pr === prev.paRed && !!f && !prev.finger) cause = 'finger';
  }
  const r = core.line(line);
  cause = null;
  if (!r || r.type !== 'sample') continue;
  samples++;
  if (proc.pulseOk) okSamples++;
  if (r.beat) { beats++; if (r.beat.ok) okBeats++; }
  if (!sec) sec = { ir: 0, n: 0, beats: [], motion: false };
  sec.ir += proc.lastIr;
  sec.n++;
  if (r.beat) sec.beats.push(r.beat);
  if (proc.ch[proc.active].inMotion(proc.n)) sec.motion = true;
  if (sec.n === FS) {
    const s = proc.summary(), fw = core.fw;
    const bpm = sec.beats.filter(b => b.rr).map(b => Math.round(60 * FS / b.rr));
    rows.push([
      String(rows.length + 1).padStart(4) + 's',
      String(Math.round(sec.ir / sec.n)).padStart(7),
      `${String(fw.paIr).padStart(3)}/${String(fw.paRed).padStart(3)}`,
      fw.finger ? '손가락' : '  없음',
      `반사${String(fw.refl).padStart(5)}`,
      s.settling ? '재시작중' : '        ',
      `규칙성 ${(s.periodicity * 100).toFixed(0).padStart(3)}%`,
      proc.pulseOk ? '인정' : '  - ',
      sec.motion ? '움직임' : '      ',
      s.channel.padEnd(3),
      `PI ${s.pi != null ? s.pi.toFixed(2) : ' -  '}%`,
      `박동 ${sec.beats.map(b => (b.ok ? '' : '(') + (b.rr ? Math.round(60 * FS / b.rr) : '?') + (b.ok ? '' : ')')).join(' ')}`
    ].join('  '));
    sec = null;
  }
}
console.log('  시각    IR평균  LED(IR/Red)        반사지수            규칙성     인정  움직임  채널  관류지수  박동(BPM, 괄호=아직 미인정)');
for (const r of rows) console.log(r);
console.log('');
console.log(`샘플 ${samples}개 (${(samples / FS).toFixed(1)}초), 데이터 아닌 줄 ${core.badLines}개`);
console.log(`검출한 박동 ${beats}개 중 화면에 보낸(인정된) 박동 ${okBeats}개, 맥박 인정 상태였던 시간 ${(okSamples / Math.max(1, samples) * 100).toFixed(0)}%`);
console.log(`재시작: LED 변경 ${restarts.led}번, 손가락 감지 ${restarts.finger}번, FIFO 넘침 ${restarts.ovf}번, 센서 시작 ${restarts.ok}번`);
