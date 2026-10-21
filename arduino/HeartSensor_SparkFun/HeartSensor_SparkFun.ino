/*
  HeartSensor_SparkFun.ino — SparkFun MAX3010x 라이브러리로 만든 심박 측정 부스용 펌웨어

  ■ HeartSensor.ino와 하는 일·출력 형식이 똑같아요. 웹 앱은 그대로 쓰면 되고, 둘 중 하나만 올리면 돼요.
    차이는 센서와 통신하는 부분을 SparkFun 라이브러리(예제에서 쓰는 방법 그대로)에 맡겼다는 점이에요.

  ■ 라이브러리 설치 (처음 한 번)
      아두이노 IDE → 도구 → 라이브러리 관리 → "SparkFun MAX3010x" 검색
      → "SparkFun MAX3010x Pulse and Proximity Sensor Library" 설치

  ■ 배선 (아두이노 우노/나노 기준)
      MAX30102 VIN → 5V (모듈에 3.3V만 적혀 있으면 3.3V)
      MAX30102 GND → GND
      MAX30102 SDA → A4
      MAX30102 SCL → A5
      (INT 핀은 연결하지 않아도 돼요)

  ■ SparkFun 예제에서 가져온 부분
      Example5_HeartRate      particleSensor.begin(Wire, ...)  로 센서를 찾아요
      Example6_FIFO_Readings  particleSensor.setup(밝기, 4회 평균, Red+IR, 400sps, 411us, ADC 범위)
                              check() → available() → nextSample() → getFIFOIR()/getFIFORed()
    맥박 계산은 아두이노가 아니라 웹 앱이 해요. (예제의 checkForBeat보다 약한 맥박·움직임에 강해요)

  ■ 인식률을 높이기 위해 하는 일 (HeartSensor.ino와 같아요)
      1) LED 밝기 자동 조절 : 0.2초마다 신호 크기를 보고 LED 전류를 알맞게 맞춰요.
      2) 18비트 해상도 + 4회 평균 : 400번/초로 재서 4개씩 평균 → 100번/초
      3) 손가락 감지 : 반사되는 빛의 양(반사지수)으로 손가락이 올라왔는지 판단해요.
      4) 센서가 빠지면 스스로 다시 연결해요.

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
#include "MAX30105.h"     // SparkFun MAX3010x 라이브러리 (MAX30102도 이 이름으로 써요)
#include "WireTimeout.h"

MAX30105 particleSensor;

// ───────── 조절할 수 있는 값 ─────────
const unsigned long BAUD = 115200;

// 센서 설정 (Example6_FIFO_Readings의 setup() 인자와 같은 뜻이에요)
const byte SAMPLE_AVERAGE = 4;     // 4개씩 평균
const byte LED_MODE       = 2;     // 2 = Red + IR
const int  SAMPLE_RATE    = 400;   // 400번/초 ÷ 4 = 100번/초
const int  PULSE_WIDTH    = 411;   // 411us = 18비트 해상도
const int  ADC_RANGE      = 16384; // 가장 넓은 범위 (손가락이 두꺼워도 신호가 잘 안 잘려요)

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
// 라이브러리는 한 번에 3개까지만 보관해서, 샘플 간격(10ms)보다 자주 읽어요
const unsigned long POLL_US = 5000;
const unsigned long RESYNC_MS = 200;   // 이 간격으로 FIFO 읽는 위치를 다시 맞춰요 (readSamples 설명 참고)
const unsigned long NO_DATA_MS = 200;  // 이만큼 새 샘플이 없으면 센서를 점검해요
const uint8_t PART_ID = 0x15;          // MAX30102·MAX30105의 부품 번호

// ───────── 상태 ─────────
bool sensorOk = false;
bool everOk = false;          // 한 번이라도 센서가 연결됐었는지 (다시 연결할 때 LED 밝기를 그대로 둬요)
bool autoLed = true;
bool finger = false;
uint8_t fingerCount = 0;
unsigned long fingerSince = 0;
uint8_t outIr = 0, outRed = 0;  // 넓은 범위를 연속으로 벗어난 점검 횟수
uint8_t paIr = PA_START, paRed = PA_START;
uint16_t reflectance = 0;

uint32_t sumIr = 0, sumRed = 0, maxIr = 0, maxRed = 0;
uint8_t agcCount = 0, agcSkip = 0;

unsigned long lastStat = 0, lastRetry = 0, lastPoll = 0, lastSample = 0, lastResync = 0;
uint8_t lostChecks = 0, stalls = 0;  // 새 샘플이 안 올 때 센서가 대답하지 않은 / 대답은 한 점검 횟수
bool statDirty = true;

char cmdBuf[10];
uint8_t cmdLen = 0;

// ───────── 센서 ─────────
void applyLed() {
  particleSensor.setPulseAmplitudeRed(paRed);
  particleSensor.setPulseAmplitudeIR(paIr);
  statDirty = true;
}

void resetAgc() {
  sumIr = sumRed = maxIr = maxRed = 0;
  agcCount = 0;
}

// 센서 주소(0x57)에서 대답이 오는지
bool sensorAnswers() {
  Wire.beginTransmission(MAX30105_ADDRESS);
  return Wire.endTransmission() == 0;
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

bool initSensor() {
  // Example5_HeartRate처럼 begin()으로 센서를 찾아요. 값싼 모듈·긴 점퍼선에서도 안정적인 100kHz로 통신해요.
  bool found = particleSensor.begin(Wire, I2C_SPEED_STANDARD);
  enableWireTimeout(Wire, 0);  // 배선이 흔들려 통신이 멈춰도 3ms 뒤에 풀려요
  if (!found) {
    if (sensorAnswers()) {     // 대답은 하는데 부품 번호가 달라요
      Serial.print(F("#ERR WRONG_PART 0x"));
      Serial.println(particleSensor.readPartID(), HEX);
    } else {
      Serial.println(F("#ERR NO_SENSOR"));
      scanI2c();
    }
    return false;
  }
  if (autoLed && !everOk) paIr = paRed = PA_START;   // 다시 연결할 때는 맞춰 둔 밝기를 그대로 써요

  // Example6_FIFO_Readings와 같은 방법으로 설정해요 (FIFO도 여기서 비워요)
  particleSensor.setup(paIr, SAMPLE_AVERAGE, LED_MODE, SAMPLE_RATE, PULSE_WIDTH, ADC_RANGE);
  applyLed();                  // setup()은 모든 LED를 같은 밝기로 켜서, Red만 따로 다시 맞춰요

  if (!everOk) { finger = false; fingerCount = 0; }
  everOk = true;
  resetAgc();
  lastSample = millis();
  lostChecks = stalls = 0;
  Serial.print(F("#OK MAX30102 rev="));
  Serial.println(particleSensor.getRevisionID());
  return true;
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

  uint32_t r = meanIr / (paIr ? paIr : 1);
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
    applyLed();
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

// 새 샘플을 모두 읽어요 (Example6_FIFO_Readings의 loop()와 같은 방법)
void readSamples() {
  uint16_t got = particleSensor.check();
  uint8_t ready = particleSensor.available();
  // 라이브러리 보관함(3개)보다 많이 밀려 있었으면 앞의 것은 잃어버려요. 몇 개를 잃었는지 앱에 알려줘요.
  // (센서의 OVF 레지스터는 쓰지 않아요. 호환 칩 중에는 넘치지 않았는데도 값이 1인 것이 있어요)
  if (got > ready) {
    Serial.print(F("#OVF "));
    Serial.println(got - ready);
  }
  while (particleSensor.available()) {
    // 라이브러리는 check()에서 보관 칸을 먼저 넘긴 뒤 저장해요. 그래서 예제처럼 '읽고 → nextSample()' 순서로 하면
    // 한 샘플씩 늦게 나오고 맨 처음에 0이 나와요. nextSample()을 먼저 불러서 방금 들어온 칸을 읽어요.
    particleSensor.nextSample();
    handleSample(particleSensor.getFIFOIR(), particleSensor.getFIFORed());
  }
  if (got) {
    lastSample = millis();
    lostChecks = stalls = 0;
    // 배선이 흔들려 통신이 한 번 실패하면, 라이브러리는 그걸 모른 채 다음부터 샘플을 몇 바이트 밀려서 읽을 수 있어요.
    // (값이 엉망이 되거나 IR·Red가 뒤바뀌어 계속 '신호 찾는 중'이 돼요) 그래서 0.2초마다 FIFO를 비워 읽는 위치를 맞춰요.
    // 방금 샘플을 읽었으니 다음 샘플이 오기(10ms) 전이라 잃어버리는 샘플은 없어요.
    if (got > ready || millis() - lastResync >= RESYNC_MS) {
      particleSensor.clearFIFO();
      lastResync = millis();
    }
    return;
  }
  if (millis() - lastSample < NO_DATA_MS) return;
  // 0.2초 넘게 새 샘플이 없어요. 라이브러리는 통신 오류를 알려주지 않아서 부품 번호를 읽어 확인해요.
  lastSample = millis();
  if (particleSensor.readPartID() != PART_ID) {
    if (++lostChecks < 2) return;          // 두 번 연속(0.4초) 대답이 없으면 센서가 빠진 거예요
    Serial.println(F("#ERR SENSOR_LOST"));
    sensorOk = false;
    lastRetry = millis();
    return;
  }
  lostChecks = 0;
  if (++stalls < 3) {
    particleSensor.clearFIFO();            // 센서는 그대로인데 샘플이 멈췄어요: FIFO를 비우고 다시 기다려요
    Serial.println(F("#OVF 32"));
  } else {
    sensorOk = false;                      // 그래도 안 오면 센서 설정을 처음부터 다시 해요
    lastRetry = 0;
  }
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
  Serial.println(F("#HELLO HeartSensor 1.0 SparkFun"));
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
    if (sensorOk) applyLed();
    statDirty = true;
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
  enableWireTimeout(Wire, 0);
  printHello();
}

void loop() {
  readCommands();

  if (!sensorOk) {
    if (lastRetry == 0 || millis() - lastRetry >= 2000) {
      lastRetry = millis();
      sensorOk = initSensor();
      if (sensorOk) printStat();
    }
    return;
  }

  if (micros() - lastPoll < POLL_US) return;
  lastPoll = micros();
  readSamples();
  if (!sensorOk) return;

  if (statDirty || millis() - lastStat >= 500) printStat();
}
