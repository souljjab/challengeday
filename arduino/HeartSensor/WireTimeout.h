// I2C 통신 시간 제한을 켜는 도우미.
// 아두이노 AVR 보드 패키지 1.8.3 이상에는 Wire.setWireTimeout()이 있지만
// 오래된 버전이나 다른 보드에는 없어서, 있을 때만 호출하도록 만들었어요.
#pragma once

template <class W>
auto enableWireTimeout(W &w, int) -> decltype(w.setWireTimeout(3000UL, true), void()) {
  w.setWireTimeout(3000UL, true);  // 3ms 동안 응답이 없으면 I2C를 풀어 줘요
}

template <class W>
void enableWireTimeout(W &, long) {}
