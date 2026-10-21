/*
  HeartSensor.ino — 화생컴공 심박 측정 부스용 MAX30102 펌웨어

  ■ 별도 라이브러리 설치가 필요 없어요. (아두이노 기본 Wire 라이브러리만 사용)
  ■ 배선 (아두이노 우노/나노 기준)
      MAX30102 VIN → 5V (모듈에 3.3V만 적혀 있으면 3.3V)
      MAX30102 GND → GND
      MAX30102 SDA → A4
      MAX30102 SCL → A5
      (INT 핀은 연결하지 않아도 돼요)

  ■ 인식률을 높이기 위해 하는 일
      1) LED 밝기 자동 조절 : 손가락 두께·피부색·누르는 힘이 사람마다 달라서
         빛이 너무 세면 신호가 잘리고(포화), 너무 약하면 맥박이 묻혀요.
         0.2초마다 신호 크기를 보고 LED 전류를 알맞게 맞춰요.
      2) 18비트 해상도 + 4회 평균 : 400번/초로 재서 4개씩 평균 → 100번/초,
         잡음이 줄어든 신호를 보내요.
      3) 손가락 감지 : 반사되는 빛의 양으로 손가락이 올라왔는지 판단해요.
      4) 배선이 흔들려 I2C 통신이 잠깐 실패해도 무시하고(0.2초까지) 계속 재요.
         정말로 센서가 빠지면 스스로 다시 연결해요.

  ■ 시리얼 출력 (115200 baud)
      "적외선(IR),적색(Red)"         ← 1초에 100줄. 시리얼 플로터로도 볼 수 있어요.
      "#STAT IR전류 Red전류 손가락 반사지수 자동"  ← 상태 (0.5초마다, 바뀌면 즉시)
      "#HELLO", "#OK", "#ERR ..."    ← 시작·오류 메시지

  ■ 시리얼 명령 (PC → 아두이노, 한 줄씩)
      A      LED 밝기 자동 조절 켜기 (기본값)
      M60    LED 밝기 수동 고정 (0~255, 1 = 0.2mA)
      R      센서 다시 초기화
      ?      현재 상태 출력
*/

#include <Wire.h>
#include "WireTimeout.h"

// ───────── 조절할 수 있는 값 ─────────
const unsigned long BAUD = 115200;

const uint32_t TARGET_LEVEL = 150000;  // LED 자동 조절 목표 (최대 262143의 약 57%)
const uint32_t TARGET_LOW   = 90000;   // 이 범위 안이면 LED를 건드리지 않아요
const uint32_t TARGET_HIGH  = 220000;
const uint32_t SAT_LEVEL    = 250000;  // 이보다 크면 빛이 너무 세서 신호가 잘려요
// 손가락이 자리 잡은 뒤(2초)에는 이 넓은 범위를 0.6초 넘게 벗어날 때만 LED를 다시 맞춰요.
// 누르는 힘이 조금씩 바뀔 때마다 밝기를 바꾸면 그때마다 신호가 살짝 흔들리기 때문이에요.
const uint32_t HOLD_LOW     = 40000;
const uint32_t HOLD_HIGH    = 235000;

const uint8_t PA_START       = 64;     // 시작 LED 전류 (64 × 0.2mA = 12.8mA)
const uint8_t PA_MIN         = 1;
const uint8_t PA_MAX         = 255;    // 51mA
const uint8_t PA_NOFINGER_MAX = 96;    // 손가락이 없을 때는 이 이상 밝히지 않아요

// 손가락 감지 기준: 반사지수 = IR값 ÷ LED전류.
// 설정 패널의 '반사지수' 값을 보고, 손가락을 올렸을 때와 뗐을 때의 중간쯤으로 맞추면 돼요.
const uint16_t FINGER_ON  = 150;
const uint16_t FINGER_OFF = 80;

const uint8_t AGC_WINDOW = 20;         // 20샘플(0.2초)마다 LED 밝기를 점검
const unsigned long POLL_US = 10000;   // 10ms마다 FIFO를 읽어요 (FIFO는 0.32초분까지 담아 둬요)
const uint8_t MAX_I2C_FAILS = 20;      // 연속 20번(0.2초) 실패해야 센서가 빠진 것으로 봐요

// ───────── MAX30102 레지스터 ─────────
const uint8_t MAX_ADDR = 0x57;
const uint8_t REG_INTR_ENABLE_1 = 0x02;
const uint8_t REG_INTR_ENABLE_2 = 0x03;
const uint8_t REG_FIFO_WR_PTR   = 0x04;
const uint8_t REG_OVF_COUNTER   = 0x05;
const uint8_t REG_FIFO_RD_PTR   = 0x06;
const uint8_t REG_FIFO_DATA     = 0x07;
const uint8_t REG_FIFO_CONFIG   = 0x08;
const uint8_t REG_MODE_CONFIG   = 0x09;
const uint8_t REG_SPO2_CONFIG   = 0x0A;
const uint8_t REG_LED1_PA       = 0x0C;  // 적색(Red) LED
const uint8_t REG_LED2_PA       = 0x0D;  // 적외선(IR) LED
const uint8_t REG_REV_ID        = 0xFE;
const uint8_t REG_PART_ID       = 0xFF;
const uint8_t PART_ID_MAX30102  = 0x15;

const uint8_t FIFO_CONFIG = 0x40 | 0x10 | 0x0F;  // 4회 평균, 가득 차면 덮어쓰기
const uint8_t MODE_SPO2   = 0x03;                // Red + IR 둘 다 사용
const uint8_t SPO2_CONFIG = 0x60 | 0x0C | 0x03;  // ADC 16384nA, 400sps, 411us(18비트)

// ───────── 상태 ─────────
bool sensorOk = false;
bool everOk = false;          // 한 번이라도 센서가 연결됐었는지 (다시 연결할 때 LED 밝기를 그대로 둬요)
bool autoLed = true;
bool ledPending = false;      // LED 설정을 아직 센서에 못 썼으면 다음에 다시 써요
bool finger = false;
uint8_t fingerCount = 0;
unsigned long fingerSince = 0;
uint8_t outIr = 0, outRed = 0;  // 넓은 범위를 연속으로 벗어난 점검 횟수
uint8_t paIr = PA_START, paRed = PA_START;
uint16_t reflectance = 0;

uint32_t sumIr = 0, sumRed = 0, maxIr = 0, maxRed = 0;
uint8_t agcCount = 0, agcSkip = 0;

unsigned long lastStat = 0, lastRetry = 0, lastPoll = 0;
uint8_t i2cFails = 0;
bool statDirty = true;

char cmdBuf[10];
uint8_t cmdLen = 0;

// ───────── I2C 도우미 ─────────
bool writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MAX_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool readReg(uint8_t reg, uint8_t &val) {
  Wire.beginTransmission(MAX_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MAX_ADDR, (uint8_t)1) != 1) return false;
  val = Wire.read();
  return true;
}

bool applyLed() {
  if (!(writeReg(REG_LED1_PA, paRed) && writeReg(REG_LED2_PA, paIr))) return false;
  statDirty = true;
  return true;
}

void resetAgc() {
  sumIr = sumRed = maxIr = maxRed = 0;
  agcCount = 0;
}

bool initSensor() {
  uint8_t part = 0, rev = 0;
  if (!readReg(REG_PART_ID, part)) return false;
  if (part != PART_ID_MAX30102) {
    Serial.print(F("#ERR WRONG_PART 0x"));
    Serial.println(part, HEX);
    return false;
  }
  readReg(REG_REV_ID, rev);
  if (autoLed && !everOk) paIr = paRed = PA_START;   // 다시 연결할 때는 맞춰 둔 밝기를 그대로 써요

  if (!writeReg(REG_MODE_CONFIG, 0x40)) return false;  // 소프트 리셋
  for (uint8_t i = 0; i < 100; i++) {
    uint8_t mode;
    delay(1);
    if (readReg(REG_MODE_CONFIG, mode) && !(mode & 0x40)) break;
  }

  bool ok = writeReg(REG_INTR_ENABLE_1, 0x00) && writeReg(REG_INTR_ENABLE_2, 0x00)
         && writeReg(REG_FIFO_CONFIG, FIFO_CONFIG)
         && writeReg(REG_MODE_CONFIG, MODE_SPO2)
         && writeReg(REG_SPO2_CONFIG, SPO2_CONFIG)
         && applyLed()
         && writeReg(REG_FIFO_WR_PTR, 0) && writeReg(REG_OVF_COUNTER, 0) && writeReg(REG_FIFO_RD_PTR, 0);
  if (!ok) return false;

  if (!everOk) { finger = false; fingerCount = 0; }
  everOk = true;
  ledPending = false;
  resetAgc();
  Serial.print(F("#OK MAX30102 rev="));
  Serial.println(rev);
  return true;
}

// 센서를 못 찾았을 때 I2C 버스에 무엇이 있는지 알려줘요 (배선 점검용)
void scanI2c() {
  Serial.print(F("#I2C"));
  bool any = false;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.print(F(" 0x"));
      Serial.print(a, HEX);
      any = true;
    }
  }
  if (!any) Serial.print(F(" none"));
  Serial.println();
}

// ───────── LED 자동 조절 ─────────
uint8_t adjustPa(uint8_t pa, uint32_t mean, uint32_t peak, uint8_t cap) {
  uint32_t np = pa;
  if (peak >= SAT_LEVEL) {
    np = pa / 2;                                   // 포화: 바로 절반으로
  } else if (mean < TARGET_LOW || mean > TARGET_HIGH) {
    uint32_t want = (uint32_t)pa * TARGET_LEVEL / (mean ? mean : 1);
    uint32_t lo = pa / 2, hi = (uint32_t)pa * 2;   // 한 번에 너무 크게 바꾸지 않아요
    np = want < lo ? lo : want > hi ? hi : want;
  }
  if (np > cap) np = cap;
  if (np < PA_MIN) np = PA_MIN;
  return (uint8_t)np;
}

void runAgc() {
  uint32_t meanIr = sumIr / agcCount, meanRed = sumRed / agcCount;
  uint32_t peakIr = maxIr, peakRed = maxRed;
  resetAgc();

  uint32_t r = meanIr / paIr;
  reflectance = r > 65535 ? 65535 : (uint16_t)r;
  bool was = finger;
  if (finger) {
    if (reflectance < FINGER_OFF) finger = false;
    fingerCount = 0;
  } else if (reflectance >= FINGER_ON) {
    if (++fingerCount >= 2) finger = true;          // 0.4초 동안 계속 감지되면 손가락으로 인정
  } else {
    fingerCount = 0;
  }
  if (was != finger) {
    statDirty = true;
    fingerSince = millis();
    outIr = outRed = 0;
  }

  if (agcSkip) { agcSkip--; return; }                // LED를 막 바꿨으면 한 번 쉬어요
  if (!autoLed) return;
  uint8_t cap = finger ? PA_MAX : PA_NOFINGER_MAX;
  uint8_t nIr, nRed;
  if (finger && millis() - fingerSince > 2000 && paIr <= cap && paRed <= cap) {
    // 자리 잡은 뒤: 빛이 넘치면 바로, 넓은 범위를 0.6초(3번) 넘게 벗어나면 다시 맞춰요
    outIr = (meanIr < HOLD_LOW || meanIr > HOLD_HIGH) ? outIr + 1 : 0;
    outRed = (meanRed < HOLD_LOW || meanRed > HOLD_HIGH) ? outRed + 1 : 0;
    nIr = (peakIr >= SAT_LEVEL || outIr >= 3) ? adjustPa(paIr, meanIr, peakIr, cap) : paIr;
    nRed = (peakRed >= SAT_LEVEL || outRed >= 3) ? adjustPa(paRed, meanRed, peakRed, cap) : paRed;
  } else {
    nIr = adjustPa(paIr, meanIr, peakIr, cap);
    nRed = adjustPa(paRed, meanRed, peakRed, cap);
  }
  if (nIr != paIr || nRed != paRed) {
    paIr = nIr;
    paRed = nRed;
    outIr = outRed = 0;
    if (!applyLed()) ledPending = true;              // 통신이 잠깐 실패하면 다음에 다시 써요
    agcSkip = 1;
  }
}

// ───────── 샘플 처리 ─────────
void printSample(uint32_t ir, uint32_t red) {
  char buf[8];
  ultoa(ir, buf, 10);
  Serial.write(buf);
  Serial.write(',');
  ultoa(red, buf, 10);
  Serial.write(buf);
  Serial.write('\n');
}

void handleSample(uint32_t ir, uint32_t red) {
  printSample(ir, red);
  sumIr += ir;
  sumRed += red;
  if (ir > maxIr) maxIr = ir;
  if (red > maxRed) maxRed = red;
  if (++agcCount >= AGC_WINDOW) runAgc();
}

uint32_t read18() {
  uint32_t v = (uint32_t)Wire.read() << 16;
  v |= (uint32_t)Wire.read() << 8;
  v |= Wire.read();
  return v & 0x3FFFF;
}

// FIFO에 쌓인 샘플을 모두 읽어요. I2C 오류면 false.
bool readFifo() {
  // 쓰기 위치·넘친 수·읽기 위치(0x04~0x06)를 한 번에 읽어야 세 값이 서로 어긋나지 않아요
  Wire.beginTransmission(MAX_ADDR);
  Wire.write(REG_FIFO_WR_PTR);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MAX_ADDR, (uint8_t)3) != 3) return false;
  uint8_t wr = Wire.read(), ovf = Wire.read(), rd = Wire.read();
  uint8_t n = (wr - rd) & 0x1F;
  if (ovf) {
    if (n == 0) n = 32;
    Serial.print(F("#OVF "));
    Serial.println(ovf);
  }
  while (n > 0) {
    uint8_t k = n > 5 ? 5 : n;                       // Wire 버퍼(32바이트)에 맞춰 5개씩
    Wire.beginTransmission(MAX_ADDR);
    Wire.write(REG_FIFO_DATA);
    if (Wire.endTransmission(false) != 0) return false;
    uint8_t want = k * 6;
    if (Wire.requestFrom(MAX_ADDR, want) != want) return false;
    for (uint8_t i = 0; i < k; i++) {
      uint32_t red = read18();
      uint32_t ir = read18();
      handleSample(ir, red);
    }
    n -= k;
  }
  return true;
}

// ───────── 상태·명령 ─────────
void printStat() {
  Serial.print(F("#STAT "));
  Serial.print(paIr);
  Serial.print(' ');
  Serial.print(paRed);
  Serial.print(' ');
  Serial.print(finger ? 1 : 0);
  Serial.print(' ');
  Serial.print(reflectance);
  Serial.print(' ');
  Serial.println(autoLed ? 1 : 0);
  statDirty = false;
  lastStat = millis();
}

void printHello() {
  Serial.println(F("#HELLO HeartSensor 1.0"));
}

void runCommand() {
  cmdBuf[cmdLen] = 0;
  char c = cmdBuf[0];
  if (c == 'A' || c == 'a') {
    autoLed = true;
    statDirty = true;
  } else if (c == 'M' || c == 'm') {
    int v = atoi(cmdBuf + 1);
    if (v < 0) v = 0;
    if (v > 255) v = 255;
    autoLed = false;
    paIr = paRed = (uint8_t)v;
    if (sensorOk && !applyLed()) ledPending = true;
    agcSkip = 1;
  } else if (c == 'R' || c == 'r') {
    sensorOk = false;
    lastRetry = 0;
  } else if (c == '?') {
    printHello();
    if (sensorOk) printStat();
  }
}

void readCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (cmdLen) runCommand();
      cmdLen = 0;
    } else if (cmdLen < sizeof(cmdBuf) - 1) {
      cmdBuf[cmdLen++] = c;
    }
  }
}

// ───────── 메인 ─────────
void setup() {
  Serial.begin(BAUD);
  Wire.begin();
  Wire.setClock(100000);       // 값싼 모듈·긴 점퍼선에서도 안정적인 속도 (필요한 양의 10배 여유)
  enableWireTimeout(Wire, 0);  // 배선이 흔들려 통신이 멈춰도 3ms 뒤에 풀려요
  printHello();
}

void loop() {
  readCommands();

  if (!sensorOk) {
    if (lastRetry == 0 || millis() - lastRetry >= 2000) {
      lastRetry = millis();
      sensorOk = initSensor();
      if (sensorOk) {
        printStat();
      } else {
        Serial.println(F("#ERR NO_SENSOR"));
        scanI2c();
      }
    }
    return;
  }

  if (micros() - lastPoll < POLL_US) return;
  lastPoll = micros();
  if (!readFifo()) {
    if (++i2cFails < MAX_I2C_FAILS) return;          // 잠깐의 통신 오류는 무시하고 다음에 다시 읽어요
    Serial.println(F("#ERR SENSOR_LOST"));
    sensorOk = false;
    i2cFails = 0;
    lastRetry = millis();
    return;
  }
  i2cFails = 0;
  if (ledPending && applyLed()) ledPending = false;

  if (statDirty || millis() - lastStat >= 500) printStat();
}
