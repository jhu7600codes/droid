// neon intrinsics against plain c reference loops (built with -fno-vectorize, so the references stay scalar)
#include <arm_neon.h>
#include <stdint.h>
typedef unsigned long size_t;
int snprintf(char *, size_t, const char *, ...);
static char *out; static int left, fails, checks;
#define LOG(...) do { int k_ = snprintf(out, left, __VA_ARGS__); out += k_; left -= k_; } while (0)
static void check(const char *name, const void *a, const void *b, int n) {
  const unsigned char *x = a, *y = b; checks++;
  for (int i = 0; i < n; i++) if (x[i] != y[i]) { fails++; LOG("FAIL %s at byte %d: %02x != %02x\n", name, i, x[i], y[i]); return; }
}
static uint8_t A8[16], B8[16]; static int8_t SA8[16], SB8[16];
static uint16_t A16[8], B16[8]; static int16_t SA16[8], SB16[8];
static uint32_t A32[4], B32[4]; static int32_t SA32[4], SB32[4];
static float FA[4], FB[4]; static int64_t SA64[2]; static uint64_t A64[2], B64[2];
static void init(void) {
  uint32_t s = 12345;
  #define R() (s = s * 1103515245u + 12345u, s >> 8)
  for (int i = 0; i < 16; i++) { A8[i] = R(); B8[i] = R(); SA8[i] = R(); SB8[i] = R(); }
  for (int i = 0; i < 8; i++) { A16[i] = R(); B16[i] = R(); SA16[i] = R(); SB16[i] = R(); }
  for (int i = 0; i < 4; i++) { A32[i] = R() * 977u; B32[i] = R() * 13u; SA32[i] = R() * 31; SB32[i] = R() - 0x400000; FA[i] = (float)(int)(R() % 2000 - 1000) / 7.f; FB[i] = (float)(int)(R() % 2000 - 1000) / 3.f; }
  SA8[0] = 127; SB8[0] = 100; SA8[1] = -128; SB8[1] = -5; SA16[0] = 32767; SB16[0] = 32767; A8[2] = 250; B8[2] = 10;
  for (int i = 0; i < 2; i++) { A64[i] = ((uint64_t)R() << 40) | R(); B64[i] = ((uint64_t)R() << 33) | R(); SA64[i] = -(int64_t)A64[i]; }
}
static int satS(long long v, int bits) { long long hi = (1ll << (bits - 1)) - 1, lo = -(1ll << (bits - 1)); return v > hi ? hi : v < lo ? lo : v; }
static unsigned satU(long long v, int bits) { long long hi = (1ll << bits) - 1; return v > hi ? hi : v < 0 ? 0 : v; }

int neon_test(char *buf, int size) {
  out = buf; left = size; init();
  { uint8_t r[16], e[16]; vst1q_u8(r, vaddq_u8(vld1q_u8(A8), vld1q_u8(B8))); for (int i = 0; i < 16; i++) e[i] = A8[i] + B8[i]; check("vaddq_u8", r, e, 16); }
  { uint8_t r[16], e[16]; vst1q_u8(r, vqaddq_u8(vld1q_u8(A8), vld1q_u8(B8))); for (int i = 0; i < 16; i++) e[i] = satU(A8[i] + B8[i], 8); check("vqaddq_u8", r, e, 16); }
  { int8_t r[16], e[16]; vst1q_s8(r, vqaddq_s8(vld1q_s8(SA8), vld1q_s8(SB8))); for (int i = 0; i < 16; i++) e[i] = satS(SA8[i] + SB8[i], 8); check("vqaddq_s8", r, e, 16); }
  { int8_t r[16], e[16]; vst1q_s8(r, vqsubq_s8(vld1q_s8(SA8), vld1q_s8(SB8))); for (int i = 0; i < 16; i++) e[i] = satS(SA8[i] - SB8[i], 8); check("vqsubq_s8", r, e, 16); }
  { uint8_t r[16], e[16]; vst1q_u8(r, vhaddq_u8(vld1q_u8(A8), vld1q_u8(B8))); for (int i = 0; i < 16; i++) e[i] = (A8[i] + B8[i]) >> 1; check("vhaddq_u8", r, e, 16); }
  { uint8_t r[16], e[16]; vst1q_u8(r, vrhaddq_u8(vld1q_u8(A8), vld1q_u8(B8))); for (int i = 0; i < 16; i++) e[i] = (A8[i] + B8[i] + 1) >> 1; check("vrhaddq_u8", r, e, 16); }
  { int32_t r[2], e[2]; vst1_s32(r, vhadd_s32(vld1_s32(SA32), vld1_s32(SB32))); for (int i = 0; i < 2; i++) e[i] = ((long long)SA32[i] + SB32[i]) >> 1; check("vhadd_s32", r, e, 8); }
  { uint8_t r[16], e[16]; vst1q_u8(r, vabdq_u8(vld1q_u8(A8), vld1q_u8(B8))); for (int i = 0; i < 16; i++) e[i] = A8[i] > B8[i] ? A8[i] - B8[i] : B8[i] - A8[i]; check("vabdq_u8", r, e, 16); }
  { int16_t r[8], e[8]; vst1q_s16(r, vmaxq_s16(vld1q_s16(SA16), vld1q_s16(SB16))); for (int i = 0; i < 8; i++) e[i] = SA16[i] > SB16[i] ? SA16[i] : SB16[i]; check("vmaxq_s16", r, e, 16); }
  { uint16_t r[8], e[8]; vst1q_u16(r, vcgtq_s16(vld1q_s16(SA16), vld1q_s16(SB16))); for (int i = 0; i < 8; i++) e[i] = SA16[i] > SB16[i] ? 0xffff : 0; check("vcgtq_s16", r, e, 16); }
  { uint32_t r[4], e[4]; vst1q_u32(r, vceqq_u32(vld1q_u32(A32), vld1q_u32(A32))); for (int i = 0; i < 4; i++) e[i] = ~0u; check("vceqq_u32", r, e, 16); }
  { uint8_t r[16], e[16]; vst1q_u8(r, vtstq_u8(vld1q_u8(A8), vld1q_u8(B8))); for (int i = 0; i < 16; i++) e[i] = (A8[i] & B8[i]) ? 0xff : 0; check("vtstq_u8", r, e, 16); }
  { uint32_t r[4], e[4]; vst1q_u32(r, vmulq_u32(vld1q_u32(A32), vld1q_u32(B32))); for (int i = 0; i < 4; i++) e[i] = A32[i] * B32[i]; check("vmulq_u32", r, e, 16); }
  { uint16_t r[8], e[8]; vst1q_u16(r, vmlaq_u16(vld1q_u16(A16), vld1q_u16(B16), vld1q_u16(A16))); for (int i = 0; i < 8; i++) e[i] = A16[i] + B16[i] * A16[i]; check("vmlaq_u16", r, e, 16); }
  { int16_t r[8], e[8]; vst1q_s16(r, vqdmulhq_s16(vld1q_s16(SA16), vld1q_s16(SB16))); for (int i = 0; i < 8; i++) e[i] = satS(((long long)SA16[i] * SB16[i] * 2) >> 16, 16); check("vqdmulhq_s16", r, e, 16); }
  { int32_t r[4], e[4]; vst1q_s32(r, vqrdmulhq_s32(vld1q_s32(SA32), vld1q_s32(SB32))); for (int i = 0; i < 4; i++) { long long p = (long long)SA32[i] * SB32[i]; e[i] = (int32_t)((p * 2 + (1ll << 31)) >> 32); } check("vqrdmulhq_s32", r, e, 16); }
  { int16_t r[8], e[8]; int16_t sh[8] = {1, -1, 3, -3, 0, 15, -15, 7}; vst1q_s16(r, vshlq_s16(vld1q_s16(SA16), vld1q_s16(sh))); for (int i = 0; i < 8; i++) e[i] = sh[i] >= 0 ? (int16_t)(SA16[i] << sh[i]) : SA16[i] >> -sh[i]; check("vshlq_s16", r, e, 16); }
  { int16_t r[8], e[8]; int16_t sh[8] = {1, -1, 3, -3, 0, 15, -15, 7}; vst1q_s16(r, vrshlq_s16(vld1q_s16(SA16), vld1q_s16(sh))); for (int i = 0; i < 8; i++) e[i] = sh[i] >= 0 ? (int16_t)(SA16[i] << sh[i]) : (SA16[i] + (1 << (-sh[i] - 1))) >> -sh[i]; check("vrshlq_s16", r, e, 16); }
  { uint8_t r[8], e[8]; vst1_u8(r, vpadd_u8(vld1_u8(A8), vld1_u8(B8))); for (int i = 0; i < 4; i++) { e[i] = A8[2 * i] + A8[2 * i + 1]; e[4 + i] = B8[2 * i] + B8[2 * i + 1]; } check("vpadd_u8", r, e, 8); }
  { uint64_t r[2], e[2]; vst1q_u64(r, vaddq_u64(vld1q_u64(A64), vld1q_u64(B64))); for (int i = 0; i < 2; i++) e[i] = A64[i] + B64[i]; check("vaddq_u64", r, e, 16); }
  { uint64_t r[2], e[2]; vst1q_u64(r, vsubq_u64(vld1q_u64(A64), vld1q_u64(B64))); for (int i = 0; i < 2; i++) e[i] = A64[i] - B64[i]; check("vsubq_u64", r, e, 16); }
  // floats
  { float r[4], e[4]; vst1q_f32(r, vaddq_f32(vld1q_f32(FA), vld1q_f32(FB))); for (int i = 0; i < 4; i++) e[i] = FA[i] + FB[i]; check("vaddq_f32", r, e, 16); }
  { float r[4], e[4]; vst1q_f32(r, vmulq_f32(vld1q_f32(FA), vld1q_f32(FB))); for (int i = 0; i < 4; i++) e[i] = FA[i] * FB[i]; check("vmulq_f32", r, e, 16); }
  { float r[4], e[4]; vst1q_f32(r, vmlaq_f32(vld1q_f32(FA), vld1q_f32(FB), vld1q_f32(FA))); for (int i = 0; i < 4; i++) { float p = FB[i] * FA[i]; e[i] = FA[i] + p; } check("vmlaq_f32", r, e, 16); }
  { float r[4], e[4]; vst1q_f32(r, vmulq_n_f32(vld1q_f32(FA), FB[1])); for (int i = 0; i < 4; i++) e[i] = FA[i] * FB[1]; check("vmulq_n_f32", r, e, 16); }
  { float r[4], e[4]; vst1q_f32(r, vmlaq_lane_f32(vld1q_f32(FA), vld1q_f32(FB), vld1_f32(FA + 2), 1)); for (int i = 0; i < 4; i++) { float p = FB[i] * FA[3]; e[i] = FA[i] + p; } check("vmlaq_lane_f32", r, e, 16); }
  { float r[4], e[4]; vst1q_f32(r, vmaxq_f32(vld1q_f32(FA), vld1q_f32(FB))); for (int i = 0; i < 4; i++) e[i] = FA[i] > FB[i] ? FA[i] : FB[i]; check("vmaxq_f32", r, e, 16); }
  { float r[2], e[2]; vst1_f32(r, vpadd_f32(vld1_f32(FA), vld1_f32(FB))); e[0] = FA[0] + FA[1]; e[1] = FB[0] + FB[1]; check("vpadd_f32", r, e, 8); }
  { uint32_t r[4], e[4]; vst1q_u32(r, vcgeq_f32(vld1q_f32(FA), vld1q_f32(FB))); for (int i = 0; i < 4; i++) e[i] = FA[i] >= FB[i] ? ~0u : 0; check("vcgeq_f32", r, e, 16); }
  { float r[4], e[4]; vst1q_f32(r, vabsq_f32(vld1q_f32(FA))); for (int i = 0; i < 4; i++) e[i] = FA[i] < 0 ? -FA[i] : FA[i]; check("vabsq_f32", r, e, 16); }
  { float r[4], e[4]; vst1q_f32(r, vnegq_f32(vld1q_f32(FA))); for (int i = 0; i < 4; i++) e[i] = -FA[i]; check("vnegq_f32", r, e, 16); }
  { float r[4], e[4]; vst1q_f32(r, vcvtq_f32_s32(vld1q_s32(SA32))); for (int i = 0; i < 4; i++) e[i] = (float)SA32[i]; check("vcvtq_f32_s32", r, e, 16); }
  { int32_t r[4], e[4]; vst1q_s32(r, vcvtq_s32_f32(vld1q_f32(FB))); for (int i = 0; i < 4; i++) e[i] = (int32_t)FB[i]; check("vcvtq_s32_f32", r, e, 16); }
  { int32_t r[4], e[4]; vst1q_s32(r, vcvtq_n_s32_f32(vld1q_f32(FB), 8)); for (int i = 0; i < 4; i++) e[i] = (int32_t)(FB[i] * 256.f); check("vcvtq_n_s32_f32", r, e, 16); }
  { float r[4], e[4]; vst1q_f32(r, vrecpsq_f32(vld1q_f32(FA), vld1q_f32(FB))); for (int i = 0; i < 4; i++) e[i] = 2.f - FA[i] * FB[i]; check("vrecpsq_f32", r, e, 16); }
  // widening / narrowing
  { uint16_t r[8], e[8]; vst1q_u16(r, vmovl_u8(vld1_u8(A8))); for (int i = 0; i < 8; i++) e[i] = A8[i]; check("vmovl_u8", r, e, 16); }
  { int32_t r[4], e[4]; vst1q_s32(r, vmovl_s16(vld1_s16(SA16))); for (int i = 0; i < 4; i++) e[i] = SA16[i]; check("vmovl_s16", r, e, 16); }
  { int64_t r[2], e[2]; vst1q_s64(r, vmovl_s32(vld1_s32(SB32))); for (int i = 0; i < 2; i++) e[i] = SB32[i]; check("vmovl_s32", r, e, 16); }
  { uint8_t r[8], e[8]; vst1_u8(r, vmovn_u16(vld1q_u16(A16))); for (int i = 0; i < 8; i++) e[i] = (uint8_t)A16[i]; check("vmovn_u16", r, e, 8); }
  { int8_t r[8], e[8]; vst1_s8(r, vqmovn_s16(vld1q_s16(SA16))); for (int i = 0; i < 8; i++) e[i] = satS(SA16[i], 8); check("vqmovn_s16", r, e, 8); }
  { uint8_t r[8], e[8]; vst1_u8(r, vqmovun_s16(vld1q_s16(SA16))); for (int i = 0; i < 8; i++) e[i] = satU(SA16[i], 8); check("vqmovun_s16", r, e, 8); }
  { uint16_t r[8], e[8]; vst1q_u16(r, vaddl_u8(vld1_u8(A8), vld1_u8(B8))); for (int i = 0; i < 8; i++) e[i] = A8[i] + B8[i]; check("vaddl_u8", r, e, 16); }
  { int32_t r[4], e[4]; vst1q_s32(r, vsubw_s16(vld1q_s32(SA32), vld1_s16(SB16))); for (int i = 0; i < 4; i++) e[i] = SA32[i] - SB16[i]; check("vsubw_s16", r, e, 16); }
  { uint16_t r[8], e[8]; vst1q_u16(r, vmull_u8(vld1_u8(A8), vld1_u8(B8))); for (int i = 0; i < 8; i++) e[i] = A8[i] * B8[i]; check("vmull_u8", r, e, 16); }
  { int64_t r[2], e[2]; vst1q_s64(r, vmull_s32(vld1_s32(SA32), vld1_s32(SB32))); for (int i = 0; i < 2; i++) e[i] = (int64_t)SA32[i] * SB32[i]; check("vmull_s32", r, e, 16); }
  { uint64_t r[2], e[2]; vst1q_u64(r, vmlal_u32(vld1q_u64(A64), vld1_u32(A32), vld1_u32(B32))); for (int i = 0; i < 2; i++) e[i] = A64[i] + (uint64_t)A32[i] * B32[i]; check("vmlal_u32", r, e, 16); }
  { int32_t r[4], e[4]; vst1q_s32(r, vmull_lane_s16(vld1_s16(SA16), vld1_s16(SB16), 2)); for (int i = 0; i < 4; i++) e[i] = SA16[i] * SB16[2]; check("vmull_lane_s16", r, e, 16); }
  { int32_t r[4], e[4]; vst1q_s32(r, vqdmull_s16(vld1_s16(SA16), vld1_s16(SB16))); for (int i = 0; i < 4; i++) e[i] = satS((long long)SA16[i] * SB16[i] * 2, 32); check("vqdmull_s16", r, e, 16); }
  { uint8_t r[8], e[8]; vst1_u8(r, vaddhn_u16(vld1q_u16(A16), vld1q_u16(B16))); for (int i = 0; i < 8; i++) e[i] = (A16[i] + B16[i]) >> 8; check("vaddhn_u16", r, e, 8); }
  { uint16_t r[4], e[4]; vst1_u16(r, vpaddl_u8(vld1_u8(A8))); for (int i = 0; i < 4; i++) e[i] = A8[2 * i] + A8[2 * i + 1]; check("vpaddl_u8", r, e, 8); }
  { int64_t r[2], e[2]; vst1q_s64(r, vpaddlq_s32(vld1q_s32(SA32))); for (int i = 0; i < 2; i++) e[i] = (int64_t)SA32[2 * i] + SA32[2 * i + 1]; check("vpaddlq_s32", r, e, 16); }
  // shifts by immediates
  { uint8_t r[16], e[16]; vst1q_u8(r, vshrq_n_u8(vld1q_u8(A8), 3)); for (int i = 0; i < 16; i++) e[i] = A8[i] >> 3; check("vshrq_n_u8", r, e, 16); }
  { int16_t r[8], e[8]; vst1q_s16(r, vshrq_n_s16(vld1q_s16(SA16), 5)); for (int i = 0; i < 8; i++) e[i] = SA16[i] >> 5; check("vshrq_n_s16", r, e, 16); }
  { int32_t r[4], e[4]; vst1q_s32(r, vrshrq_n_s32(vld1q_s32(SA32), 7)); for (int i = 0; i < 4; i++) e[i] = (int32_t)(((long long)SA32[i] + 64) >> 7); check("vrshrq_n_s32", r, e, 16); }
  { uint16_t r[8], e[8]; vst1q_u16(r, vsraq_n_u16(vld1q_u16(A16), vld1q_u16(B16), 4)); for (int i = 0; i < 8; i++) e[i] = A16[i] + (B16[i] >> 4); check("vsraq_n_u16", r, e, 16); }
  { uint32_t r[4], e[4]; vst1q_u32(r, vshlq_n_u32(vld1q_u32(A32), 9)); for (int i = 0; i < 4; i++) e[i] = A32[i] << 9; check("vshlq_n_u32", r, e, 16); }
  { uint16_t r[8], e[8]; vst1q_u16(r, vsliq_n_u16(vld1q_u16(A16), vld1q_u16(B16), 5)); for (int i = 0; i < 8; i++) e[i] = (uint16_t)((B16[i] << 5) | (A16[i] & 31)); check("vsliq_n_u16", r, e, 16); }
  { uint16_t r[8], e[8]; vst1q_u16(r, vsriq_n_u16(vld1q_u16(A16), vld1q_u16(B16), 5)); for (int i = 0; i < 8; i++) e[i] = (uint16_t)((B16[i] >> 5) | (A16[i] & 0xf800)); check("vsriq_n_u16", r, e, 16); }
  { int16_t r[8], e[8]; vst1q_s16(r, vqshlq_n_s16(vld1q_s16(SA16), 4)); for (int i = 0; i < 8; i++) e[i] = satS((long long)SA16[i] * 16, 16); check("vqshlq_n_s16", r, e, 16); }
  { uint8_t r[8], e[8]; vst1_u8(r, vshrn_n_u16(vld1q_u16(A16), 6)); for (int i = 0; i < 8; i++) e[i] = (uint8_t)(A16[i] >> 6); check("vshrn_n_u16", r, e, 8); }
  { uint8_t r[8], e[8]; vst1_u8(r, vqrshrun_n_s16(vld1q_s16(SA16), 6)); for (int i = 0; i < 8; i++) e[i] = satU((SA16[i] + 32) >> 6, 8); check("vqrshrun_n_s16", r, e, 8); }
  { int16_t r[4], e[4]; vst1_s16(r, vqshrn_n_s32(vld1q_s32(SA32), 3)); for (int i = 0; i < 4; i++) e[i] = satS(SA32[i] >> 3, 16); check("vqshrn_n_s32", r, e, 8); }
  { uint16_t r[8], e[8]; vst1q_u16(r, vshll_n_u8(vld1_u8(A8), 3)); for (int i = 0; i < 8; i++) e[i] = A8[i] << 3; check("vshll_n_u8", r, e, 16); }
  { int64_t r[2], e[2]; vst1q_s64(r, vshrq_n_s64(vld1q_s64(SA64), 13)); for (int i = 0; i < 2; i++) e[i] = SA64[i] >> 13; check("vshrq_n_s64", r, e, 16); }
  { uint64_t r[2], e[2]; vst1q_u64(r, vshlq_n_u64(vld1q_u64(A64), 21)); for (int i = 0; i < 2; i++) e[i] = A64[i] << 21; check("vshlq_n_u64", r, e, 16); }
  // misc
  { uint8_t r[16], e[16]; vst1q_u8(r, vrev64q_u8(vld1q_u8(A8))); for (int i = 0; i < 16; i++) e[i] = A8[(i & ~7) + 7 - (i & 7)]; check("vrev64q_u8", r, e, 16); }
  { uint16_t r[4], e[4]; vst1_u16(r, vrev32_u16(vld1_u16(A16))); for (int i = 0; i < 4; i++) e[i] = A16[i ^ 1]; check("vrev32_u16", r, e, 8); }
  { uint8_t r[16], e[16]; vst1q_u8(r, vcntq_u8(vld1q_u8(A8))); for (int i = 0; i < 16; i++) { int c = 0; for (int k = 0; k < 8; k++) c += (A8[i] >> k) & 1; e[i] = c; } check("vcntq_u8", r, e, 16); }
  { uint32_t r[4], e[4]; vst1q_u32(r, vclzq_u32(vld1q_u32(B32))); for (int i = 0; i < 4; i++) { int c = 0; while (c < 32 && !((B32[i] << c) & 0x80000000u)) c++; e[i] = c; } check("vclzq_u32", r, e, 16); }
  { int16_t r[8], e[8]; vst1q_s16(r, vqabsq_s16(vld1q_s16(SA16))); for (int i = 0; i < 8; i++) e[i] = satS(SA16[i] < 0 ? -(int)SA16[i] : SA16[i], 16); check("vqabsq_s16", r, e, 16); }
  { uint8_t r[16], e[16]; vst1q_u8(r, vmvnq_u8(vld1q_u8(A8))); for (int i = 0; i < 16; i++) e[i] = ~A8[i]; check("vmvnq_u8", r, e, 16); }
  { uint8_t r[16], e[16]; uint8x8x2_t z = vzip_u8(vld1_u8(A8), vld1_u8(B8)); vst1_u8(r, z.val[0]); vst1_u8(r + 8, z.val[1]); for (int i = 0; i < 8; i++) { e[2 * i] = A8[i]; e[2 * i + 1] = B8[i]; } check("vzip_u8", r, e, 16); }
  { uint16_t r[8], e[8]; uint16x4x2_t z = vuzp_u16(vld1_u16(A16), vld1_u16(B16)); vst1_u16(r, z.val[0]); vst1_u16(r + 4, z.val[1]); uint16_t all[8]; for (int i = 0; i < 4; i++) { all[i] = A16[i]; all[4 + i] = B16[i]; } for (int i = 0; i < 4; i++) { e[i] = all[2 * i]; e[4 + i] = all[2 * i + 1]; } check("vuzp_u16", r, e, 16); }
  { uint32_t r[4], e[4]; uint32x2x2_t z = vtrn_u32(vld1_u32(A32), vld1_u32(B32)); vst1_u32(r, z.val[0]); vst1_u32(r + 2, z.val[1]); e[0] = A32[0]; e[1] = B32[0]; e[2] = A32[1]; e[3] = B32[1]; check("vtrn_u32", r, e, 16); }
  { uint8_t r[16], e[16]; vst1q_u8(r, vextq_u8(vld1q_u8(A8), vld1q_u8(B8), 5)); for (int i = 0; i < 16; i++) e[i] = i + 5 < 16 ? A8[i + 5] : B8[i - 11]; check("vextq_u8", r, e, 16); }
  { uint8_t r[8], e[8], idx[8] = {0, 3, 7, 15, 16, 1, 9, 200}; uint8x8x2_t t = {{vld1_u8(A8), vld1_u8(A8 + 8)}}; vst1_u8(r, vtbl2_u8(t, vld1_u8(idx))); for (int i = 0; i < 8; i++) e[i] = idx[i] < 16 ? A8[idx[i]] : 0; check("vtbl2_u8", r, e, 8); }
  { uint16_t r[8], e[8]; vst1q_u16(r, vdupq_lane_u16(vld1_u16(A16), 3)); for (int i = 0; i < 8; i++) e[i] = A16[3]; check("vdupq_lane_u16", r, e, 16); }
  { uint8_t r[16], e[16]; vst1q_u8(r, vdupq_n_u8(A8[5])); for (int i = 0; i < 16; i++) e[i] = A8[5]; check("vdupq_n_u8", r, e, 16); }
  { int32_t r[4], e[4]; vst1q_s32(r, vmovq_n_s32(-77)); for (int i = 0; i < 4; i++) e[i] = -77; check("vmovq_n_s32", r, e, 16); }
  { float r[4], e[4]; vst1q_f32(r, vdupq_n_f32(1.5f)); for (int i = 0; i < 4; i++) e[i] = 1.5f; check("vdupq_n_f32", r, e, 16); }
  { uint8_t v = vgetq_lane_u8(vld1q_u8(A8), 13); check("vgetq_lane_u8", &v, &A8[13], 1); }
  { int16_t v = vget_lane_s16(vld1_s16(SA16), 2); check("vget_lane_s16", &v, &SA16[2], 2); }
  { uint8_t r[16], e[16]; vst1q_u8(r, vsetq_lane_u8(99, vld1q_u8(A8), 11)); for (int i = 0; i < 16; i++) e[i] = i == 11 ? 99 : A8[i]; check("vsetq_lane_u8", r, e, 16); }
  { uint16_t r[8], e[8]; vst1q_u16(r, vbslq_u16(vld1q_u16(A16), vld1q_u16(B16), vld1q_u16(A16 ))); for (int i = 0; i < 8; i++) e[i] = (A16[i] & B16[i]) | (~A16[i] & A16[i]); check("vbslq_u16", r, e, 16); }
  // structure loads / stores
  { uint8_t r[16], e[16]; uint8x8x2_t s = vld2_u8(A8); vst1_u8(r, s.val[0]); vst1_u8(r + 8, s.val[1]); for (int i = 0; i < 8; i++) { e[i] = A8[2 * i]; e[8 + i] = A8[2 * i + 1]; } check("vld2_u8", r, e, 16); }
  { uint16_t r[24], e[24], src[24]; for (int i = 0; i < 24; i++) src[i] = i * 7 + 1; uint16x8x3_t s = vld3q_u16(src); vst1q_u16(r, s.val[0]); vst1q_u16(r + 8, s.val[1]); vst1q_u16(r + 16, s.val[2]); for (int i = 0; i < 8; i++) for (int k = 0; k < 3; k++) e[k * 8 + i] = src[3 * i + k]; check("vld3q_u16", r, e, 48); }
  { uint8_t r[32], e[32]; uint8x8x4_t s = {{vld1_u8(A8), vld1_u8(A8 + 8), vld1_u8(B8), vld1_u8(B8 + 8)}}; vst4_u8(r, s); for (int i = 0; i < 8; i++) { e[4 * i] = A8[i]; e[4 * i + 1] = A8[8 + i]; e[4 * i + 2] = B8[i]; e[4 * i + 3] = B8[8 + i]; } check("vst4_u8", r, e, 32); }
  { float r[8], e[8]; static const float in8[8] = {1, 2, 3, 4, 5, 6, 7, 8}; float32x4x2_t s = vld2q_f32(in8); vst1q_f32(r, s.val[0]); vst1q_f32(r + 4, s.val[1]); float x[8] = {1, 3, 5, 7, 2, 4, 6, 8}; for (int i = 0; i < 8; i++) e[i] = x[i]; check("vld2q_f32", r, e, 32); }
  { uint32_t r[4], e[4]; vst1q_u32(r, vld1q_dup_u32(&A32[2])); for (int i = 0; i < 4; i++) e[i] = A32[2]; check("vld1q_dup_u32", r, e, 16); }
  { uint16_t r[8], e[8]; vst1q_u16(r, vld1q_lane_u16(&B16[1], vld1q_u16(A16), 6)); for (int i = 0; i < 8; i++) e[i] = i == 6 ? B16[1] : A16[i]; check("vld1q_lane_u16", r, e, 16); }
  { uint8_t r[16] = {0}, e[16] = {0}; vst1q_lane_u8(r + 3, vld1q_u8(A8), 9); e[3] = A8[9]; check("vst1q_lane_u8", r, e, 16); }
  { uint16_t r[8], e[8]; uint16x4x2_t s = vld2_dup_u16(A16); vst1_u16(r, s.val[0]); vst1_u16(r + 4, s.val[1]); for (int i = 0; i < 4; i++) { e[i] = A16[0]; e[4 + i] = A16[1]; } check("vld2_dup_u16", r, e, 16); }
  { uint32_t r[4] = {0}, e[4] = {0}; uint32x2x2_t s = {{vld1_u32(A32), vld1_u32(B32)}}; vst2_lane_u32(r, s, 1); e[0] = A32[1]; e[1] = B32[1]; check("vst2_lane_u32", r, e, 16); }
  LOG("%d checks, %d failed\n", checks, fails);
  return fails == 0;
}
