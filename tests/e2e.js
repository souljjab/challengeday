// 브라우저 통합 테스트 (개발용): node tests/e2e.js [스크린샷 폴더]
// 가짜 시리얼 포트로 START.html 전체 흐름을 확인해요. Playwright + Chromium이 필요해요.
const path = require('path');
const fs = require('fs');
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }

const root = path.resolve(__dirname, '..');
const shots = path.resolve(process.argv[2] || path.join(root, 'tests', 'screenshots'));
fs.mkdirSync(shots, { recursive: true });
const fails = [];
const check = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails.push(msg); };

(async () => {
  const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(p => fs.existsSync(p));
  const browser = await pw.chromium.launch({ executablePath: exe, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 }, acceptDownloads: true });
  await ctx.route(/^https?:/, r => r.abort());               // 인터넷 없이도 되는지 확인
  // E2E_OVF=0.9 : 일부 호환 칩처럼 샘플 앞에 '#OVF 1'을 그 비율로 끼워 보내요
  if (process.env.E2E_OVF) await ctx.addInitScript(`window.__fakeOvf = ${+process.env.E2E_OVF}`);
  await ctx.addInitScript({ path: path.join(__dirname, 'fake-serial.js') });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/attribute d: Expected/.test(m.text())) errors.push(m.text()); });

  console.log('1. START.html 열기');
  await page.goto('file://' + path.join(root, 'START.html'));
  const fr = page.frameLocator('#page');
  await fr.getByText('센서 연결하기').first().waitFor({ timeout: 8000 });
  check(true, '헤더 배지가 "센서 연결하기"로 보여요');
  await page.screenshot({ path: path.join(shots, '1-not-connected.png') });

  console.log('2. 배지를 눌러 설정 패널 열고 연결');
  await fr.getByRole('button', { name: /센서 연결하기/ }).first().click();
  await page.locator('.hsp').waitFor();
  await page.screenshot({ path: path.join(shots, '2-panel.png') });
  await page.locator('.hsp [data-a="connect"]').click();
  await page.waitForTimeout(9000);
  const panelText = await page.locator('.hsp').innerText();
  check(/연결됨 · CH340/.test(panelText), '패널에 "연결됨 · CH340"');
  check(/양호/.test(panelText), '신호 품질 "양호"');
  const bpmText = await page.locator('.hsp [data-f="bpm"]').innerText();
  const bpm = parseInt(bpmText, 10);
  check(bpm >= 69 && bpm <= 75, `패널 심박수 ${bpmText} (정답 72)`);
  await page.screenshot({ path: path.join(shots, '3-panel-connected.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log('3. 메인 화면에 실제 데이터 표시');
  const frame = page.frames().find(f => /Monitor/.test(f.url()));
  const bigBpm = await frame.evaluate(() => [...document.querySelectorAll('span')].find(s => s.style.fontSize === '76px')?.textContent);
  check(Math.abs(parseInt(bigBpm, 10) - 72) <= 4, `현재 심박수 ${bigBpm}`);
  check(await fr.getByText('센서 연결됨').count() > 0, '헤더 배지 "센서 연결됨"');
  await page.screenshot({ path: path.join(shots, '4-monitor-live.png') });

  console.log('3-1. 센서가 5초 동안 빠졌다 다시 연결돼도 BPM이 그대로');
  await page.evaluate(() => {
    window.__beats = [];
    window.HeartSensor.getHub().subscribe(ev => { if (ev.type === 'beat' && ev.beat.bpm) window.__beats.push({ t: performance.now(), bpm: ev.beat.bpm }); });
    window.__fake.dropMs = 5000;
  });
  await page.waitForTimeout(18000);
  // 숨 쉴 때마다 박동 간격이 출렁이므로 마지막 8초 동안의 평균으로 봐요
  const after = await page.evaluate(() => {
    const h = window.HeartSensor.getHub(), bs = window.__beats.filter(b => b.t > performance.now() - 8000);
    return { bpm: bs.length ? bs.reduce((a, b) => a + b.bpm, 0) / bs.length : null, n: bs.length, fs: h.timing.fs };
  });
  check(after.bpm != null && after.n >= 5 && Math.abs(after.bpm - 72) <= 3 && (after.fs == null || Math.abs(after.fs - 100) < 3),
    `다시 연결 뒤 평균 심박수 ${after.bpm ? after.bpm.toFixed(1) : '-'} (정답 72, 박동 ${after.n}개, 샘플 속도 추정 ${after.fs ? after.fs.toFixed(1) : '-'}Hz)`);

  console.log('4. 보통/집중 측정 (10초씩으로 줄여서)');
  await frame.evaluate(() => window.__dcSetProps('Heart Rate Monitor', { phaseSeconds: 10 }));
  await fr.getByRole('button', { name: '측정 시작' }).click();
  await page.waitForTimeout(11000);
  await page.evaluate(() => { window.__fake.hr = 84; });
  await fr.getByRole('button', { name: '측정 시작' }).click();
  await page.waitForTimeout(11500);
  const summary = await frame.evaluate(() => document.body.innerText);
  const m = summary.match(/(\d+) − (\d+) = ([+−]?\d+)/);
  check(!!m, '변화량 계산식이 보여요: ' + (m ? m[0] : '없음'));
  if (m) {
    check(Math.abs(+m[2] - 72) <= 3, `보통 평균 ${m[2]} (정답 72)`);
    check(Math.abs(+m[1] - 84) <= 4, `집중 평균 ${m[1]} (정답 84, 바뀌는 중 포함)`);
  }
  await page.screenshot({ path: path.join(shots, '5-monitor-done.png'), fullPage: true });

  console.log('5. 실습 화면으로 이동해도 연결 유지');
  await page.evaluate(() => { window.__fake.hr = 70; });
  await fr.getByText('실습하기 →').click();
  await page.waitForTimeout(1500);
  check(await fr.getByText('센서 연결됨').count() > 0, '실습 화면에서도 "센서 연결됨"');
  check(page.frames().some(f => /Practice/.test(f.url())), '안쪽 페이지가 실습 화면으로 바뀜');
  await page.waitForTimeout(12000);
  const practice = page.frames().find(f => /Practice/.test(f.url()));
  const step = await practice.evaluate(() => document.body.innerText);
  check(/신호가 안정됐어요|보통 상태 측정/.test(step), '심박 확인 단계가 안정 박동을 세고 넘어감');
  await page.screenshot({ path: path.join(shots, '6-practice.png') });

  console.log('6. 손가락을 떼면 안내');
  await page.evaluate(() => { window.__fake.finger = false; });
  await page.waitForTimeout(5000);
  const off = await practice.evaluate(() => document.body.innerText);
  check(/손가락 없음/.test(off), '센서 카드에 "손가락 없음"');
  check(/손가락 끝을 센서 창에 가볍게 올려 주세요/.test(off), '올바른 안내 문구');
  await page.screenshot({ path: path.join(shots, '7-finger-off.png') });
  await page.evaluate(() => { window.__fake.finger = true; });

  console.log('7. CSV 저장');
  await fr.getByRole('button', { name: /센서/ }).first().click();
  const dl = page.waitForEvent('download');
  await page.locator('.hsp [data-a="csv"]').click();
  const file = await dl;
  const csv = fs.readFileSync(await file.path(), 'utf8');
  check(/^﻿시각,BPM,RR간격/.test(csv) && csv.split('\n').length > 30, `CSV ${file.suggestedFilename()} (${csv.split('\n').length - 1}줄)`);

  console.log('8. 민감도·LED 설정이 펌웨어로 전달');
  await page.locator('.hsp [data-a="led-manual"]').click();
  await page.locator('.hsp [data-a="sens-4"]').click();
  await page.waitForTimeout(300);
  const cmds = await page.evaluate(() => window.__fake.cmds);
  check(cmds.includes('A') && cmds.some(c => /^M\d+$/.test(c)), '펌웨어 명령 전송: ' + cmds.join(', '));
  await page.locator('.hsp [data-a="led-auto"]').click();
  await page.locator('.hsp [data-a="sens-3"]').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log('9. 참가자 설문');
  const hubVal = fn => page.evaluate(fn);
  check((await hubVal(() => window.HeartSensor.getHub().participant || {})).id === 'A-001', '실습을 시작하면 참가 번호 A-001');
  await fr.getByRole('button', { name: /결과/ }).first().click();
  await page.waitForTimeout(500);
  check((await hubVal(() => window.HeartSensor.getHub().participant || {})).done === true, '결과 화면에 오면 설문을 열 수 있는 상태가 돼요');
  await fr.getByText('설문 참여하기').click();
  await fr.getByText('체험 설문').waitFor({ timeout: 8000 });
  check(await fr.getByText('A-001').count() > 0, '설문 화면에 참가 번호');
  await fr.getByRole('button', { name: '제출하기' }).click();
  await page.waitForTimeout(400);
  check(await fr.getByText('아직 답하지 않았어요').count() >= 5, '답하지 않은 필수 질문을 표시해요');
  await fr.locator('#q1 button').nth(4).click();
  await fr.getByRole('button', { name: '거짓말 탐지기 게임' }).click();
  const q3 = fr.locator('#q3 button');
  await q3.nth(3).click(); await q3.nth(9).click(); await q3.nth(12).click();
  await fr.locator('#q4 button').nth(3).click();
  await fr.getByRole('button', { name: '조금 떨렸어요' }).click();
  await fr.getByRole('button', { name: '대체로 비슷했어요' }).click();
  await fr.getByRole('button', { name: '생명과학' }).click();
  await fr.getByRole('button', { name: '컴퓨터공학' }).click();
  await page.screenshot({ path: path.join(shots, '9-survey.png') });
  await fr.getByRole('button', { name: '제출하기' }).click();
  await fr.getByText('설문에 참여해 줘서 고마워요').waitFor({ timeout: 5000 });
  check(true, '제출하면 감사 화면');
  await page.screenshot({ path: path.join(shots, '10-survey-thanks.png') });
  await hubVal(() => window.HeartSensor.getHub().submitSurvey([{ key: 'satisfaction', label: '만족도', value: '1' }]));
  check(await hubVal(() => window.HeartSensor.getHub().surveys.length) === 1, '한 참가자는 한 번만 제출돼요');
  await fr.getByRole('button', { name: /센서/ }).first().click();
  check(/응답 1명 · 만족도 평균 5\.0/.test(await page.locator('.hsp').innerText()), '패널에 응답 수와 만족도 평균');
  const sdl = page.waitForEvent('download');
  await page.locator('.hsp [data-a="sv-csv"]').click();
  const sfile = await sdl;
  const scsv = fs.readFileSync(await sfile.path(), 'utf8').split('\r\n');
  check(scsv.length === 2 && /^﻿참가번호,부스,/.test(scsv[0]) && /^A-001,A,.*,센서,.*,5,거짓말 탐지기 게임,4,5,3,4,조금 떨렸어요,대체로 비슷했어요,"생명과학, 컴퓨터공학",,$/.test(scsv[1]),
    `설문 CSV ${sfile.suggestedFilename()}: ${scsv[1]}`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.getElementById('page').src = 'app/Heart%20Rate%20Practice.dc.html#start'; });
  await page.waitForTimeout(2500);
  check((await hubVal(() => window.HeartSensor.getHub().participant || {})).id === 'A-002', '다음 참가자는 A-002');
  await page.evaluate(() => { document.getElementById('page').src = 'app/Heart%20Rate%20Survey.dc.html'; });
  await fr.getByText('체험을 마친 참가자만').waitFor({ timeout: 8000 });
  check(true, '실습을 마치지 않은 참가자는 설문 대신 안내를 봐요');
  await fr.getByRole('button', { name: /센서/ }).first().click();

  console.log('10. 시뮬레이션 모드 전환');
  await page.locator('.hsp [data-a="src-sim"]').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2500);
  check(await fr.getByText('시뮬레이션 데이터').count() > 0, '배지 "시뮬레이션 데이터"');
  await page.screenshot({ path: path.join(shots, '8-sim.png') });

  check(errors.length === 0, '페이지 오류 없음' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(fails.length ? `\n실패 ${fails.length}개` : '\n모두 통과');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
