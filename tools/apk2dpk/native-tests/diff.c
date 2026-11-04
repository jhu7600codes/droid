// differential test: the same program built for the host (the truth) and for arm / thumb, run on
// droid's emulator. every category folds its results into a hash; run-diff.mjs compares the lines.
// ieee results of + - * / sqrt and conversions are the same everywhere (build with -ffp-contract=off).
#include <stdint.h>
#ifdef HOST
#include <stdio.h>
#else
typedef unsigned long size_t;
int snprintf(char *, size_t, const char *, ...);
#endif

static char *out; static int left;
static uint64_t h;
static void mix_(uint64_t v, int at);
static void mixd_(double d, int at) { union { double d; uint64_t u; } x = { d }; if (d != d) x.u = 0x7ff8000000000000ull; mix_(x.u, at); }
static void mixf_(float f, int at) { union { float f; uint32_t u; } x = { f }; if (f != f) x.u = 0x7fc00000u; mix_(x.u, at); }
#define mix(v) mix_((uint64_t)(v), __LINE__)
#define mixd(v) mixd_((v), __LINE__)
#define mixf(v) mixf_((v), __LINE__)
#ifdef DETAIL
// every value on its own line, with the source line that made it
static void mix_(uint64_t v, int at) { if (left > 100) { int k = snprintf(out, left, "%d %08x%08x\n", at, (unsigned)(v >> 32), (unsigned)v); out += k; left -= k; } }
#else
static void mix_(uint64_t v, int at) { (void)at; h ^= v + 0x9e3779b97f4a7c15ull + (h << 6) + (h >> 2); }
#endif
static void line(const char *name) {
  int k = snprintf(out, left, "%s %08x%08x\n", name, (unsigned)(h >> 32), (unsigned)h); out += k; left -= k; h = 0;
}
static uint32_t seed = 1;
static uint32_t rnd(void) { seed = seed * 1664525u + 1013904223u; return seed; }
// values with edges mixed in
static int32_t vi(int i) { static const int32_t e[] = {0, 1, -1, 2, -2, 0x7fffffff, (int32_t)0x80000000, 255, 256, 65535, -65536, 31, 32, 33}; return i < 14 ? e[i] : (int32_t)rnd() >> (rnd() & 15); }
static double vd(int i) { static const double e[] = {0.0, -0.0, 1.0, -1.0, 0.5, 1e300, -1e-300, 3.0e9, -3.0e9, 2147483647.5, 4294967296.0, 1.0 / 3}; if (i < 12) return e[i]; return (double)(int32_t)rnd() / (double)((rnd() & 0xffff) + 1) * ((rnd() & 3) == 0 ? 1e6 : 1); }

#ifndef N
#define N 400
#endif
volatile int sink;

__attribute__((noinline)) static void ints(void) {
  for (int i = 0; i < N; i++) {
    int32_t a = vi(i % 40 == i ? i : 99), b = vi((i * 7) % 14 + (i > 30 ? 99 : 0));
    uint32_t ua = a, ub = b;
    mix(a + b); mix(a - b); mix((uint32_t)(a * b)); mix(a & b); mix(a | b); mix(a ^ ~b);
    if (b != 0 && !(a == (int32_t)0x80000000 && b == -1)) { mix(a / b); mix(a % b); }
    if (ub) { mix(ua / ub); mix(ua % ub); }
    int s = b & 31;
    mix(ua << s); mix(ua >> s); mix(a >> s); mix((ua >> s) | (ua << ((32 - s) & 31)));
    mix(a < b); mix(ua < ub); mix(a <= b); mix(ua >= ub); mix(a == b);
    mix((int8_t)a); mix((uint8_t)a); mix((int16_t)a); mix((uint16_t)a);
    mix(a > b ? a : b); mix(ua < ub ? ua : ub);
    mix(__builtin_clz(ua | 1)); mix(__builtin_ctz(ua | 0x80000000u)); mix(__builtin_bswap32(ua)); mix(__builtin_bswap16((uint16_t)ua));
    int64_t pa = (int64_t)a * b; uint64_t pu = (uint64_t)ua * ub; mix(pa); mix(pu); mix(pa >> 32); mix(pu >> 32);
    int32_t ov; mix(__builtin_add_overflow(a, b, &ov)); mix(ov); mix(__builtin_sub_overflow(a, b, &ov)); mix(ov);
    // bitfields
    struct { unsigned x : 5, y : 11; signed z : 7; } bf = { 0 }; bf.x = a; bf.y = b; bf.z = a ^ b; mix(bf.x); mix(bf.y); mix(bf.z);
  }
  line("ints");
}
__attribute__((noinline)) static void longs(void) {
  for (int i = 0; i < N; i++) {
    int64_t a = ((int64_t)vi(i % 14) << 32) | rnd(), b = ((int64_t)vi((i + 5) % 14) << (rnd() & 31)) ^ rnd();
    uint64_t ua = a, ub = b;
    mix(a + b); mix(a - b); mix(ua * ub); mix(a & b); mix(a | b); mix(a ^ b);
    if (b != 0 && !(a == INT64_MIN && b == -1)) { mix(a / b); mix(a % b); }
    if (ub) { mix(ua / ub); mix(ua % ub); }
    int s = b & 63;
    mix(ua << s); mix(ua >> s); mix(a >> s);
    mix(a < b); mix(ua < ub); mix(a == b); mix(a >= b);
    mix((int32_t)a); mix((uint32_t)(ua >> 17));
    mix(__builtin_clzll(ua | 1)); mix(__builtin_bswap64(ua));
  }
  line("longs");
}
__attribute__((noinline)) static void doubles(void) {
  for (int i = 0; i < N; i++) {
    double a = vd(i % 12 == i ? i : 99), b = vd((i * 5) % 12 + (i > 20 ? 99 : 0));
    mixd(a + b); mixd(a - b); mixd(a * b); mixd(a / b); mixd(-a);
    mixd(a < 0 ? -a : a); mixd(__builtin_sqrt(a < 0 ? -a : a));
    mix(a < b); mix(a <= b); mix(a == b); mix(a != b); mix(a > b); mix(a >= b);
    mixd(a > b ? a : b);
    if (a > -2147483648.0 && a < 2147483647.0) mix((int32_t)a);
    if (a >= 0 && a < 4294967295.0) mix((uint32_t)a);
    if (a > -9.2e18 && a < 9.2e18) mix((int64_t)a);
    if (a >= 0 && a < 1.8e19) mix((uint64_t)a);
    mixf((float)a); mixd((double)(float)a);
    int32_t k = (int32_t)rnd(); mixd((double)k); mixd((double)(uint32_t)k); mixd((double)(((int64_t)k << 20) + i)); mixd((double)((uint64_t)rnd() << 32 | rnd()));
    mixd(a * b + a); mixd(a - b * 3.0); // separate ops (no fma: -ffp-contract=off)
  }
  line("doubles");
}
__attribute__((noinline)) static void floats(void) {
  for (int i = 0; i < N; i++) {
    float a = (float)vd(i % 12 == i ? i : 99), b = (float)vd((i * 3) % 12 + (i > 20 ? 99 : 0));
    mixf(a + b); mixf(a - b); mixf(a * b); mixf(a / b); mixf(-a);
    mixf(__builtin_sqrtf(a < 0 ? -a : a)); mixf(a < 0 ? -a : a);
    mix(a < b); mix(a == b); mix(a >= b); mix(a != a);
    if (a > -2147483648.0f && a < 2147483647.0f) mix((int32_t)a);
    if (a >= 0 && a < 4294967295.0f) mix((uint32_t)a);
    if (a > -9.2e18f && a < 9.2e18f) mix((int64_t)a);
    int32_t k = (int32_t)rnd(); mixf((float)k); mixf((float)(uint32_t)k); mixf((float)((int64_t)k << 24)); mixf((float)((uint64_t)rnd() << 32 | rnd()));
    mixd((double)a * b); mixf(a * b - a); mixf(a * 0.5f + b * 0.25f);
  }
  line("floats");
}
// loops, switch tables, memory of every width, struct copies, recursion, varargs-free calls
static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
struct S { signed char c; short s; int i; long long l; float f; double d; char pad[13]; };
__attribute__((noinline)) static void control(void) {
  uint8_t buf[256];
  for (int i = 0; i < 256; i++) buf[i] = rnd();
  for (int i = 0; i < N; i++) {
    int k = rnd() % 11;
    switch (k) { case 0: mix(1); break; case 1: mix(7); break; case 2: mix(k * 3); break; case 3: case 4: mix(k << 4); break; case 5: mix(99); break; case 6: mix(k ^ 5); break; case 7: mix(k - 100); break; default: mix(k * k); }
    int o = rnd() & 0xf0;
    uint16_t h16; uint32_t w; uint64_t q; __builtin_memcpy(&h16, buf + o + 1, 2); __builtin_memcpy(&w, buf + o + 3, 4); __builtin_memcpy(&q, buf + o + 5, 8);
    mix(h16); mix(w); mix(q);
    struct S s1 = { (signed char)i, (short)(i * 3), i * 7, (long long)i << 40, i * 0.25f, i / 3.0, {0} }, s2;
    s2 = s1; s2.i += 1; mix(s2.c); mix(s2.s); mix(s2.i); mix(s2.l); mixf(s2.f); mixd(s2.d);
  }
  mix(fib(20));
  line("control");
}
// fixed-point / dsp-ish code clang turns into ssat, usat, smulbb, smlal and friends at -O2
__attribute__((noinline)) static void dsp(void) {
  for (int i = 0; i < N; i++) {
    int32_t a = vi(i % 14 == i ? i : 99), b = vi((i * 3) % 14 + 99);
    int16_t x = a, y = b;
    int32_t p = x * y; mix(p); mix((int64_t)a * b + p);
    int32_t c = a >> 4; mix(c > 32767 ? 32767 : c < -32768 ? -32768 : c); mix(c > 255 ? 255 : c < 0 ? 0 : c);
    mix(((int64_t)a * b) >> 32); mix((a >> 16) * (int16_t)b);
    uint8_t u1 = a, u2 = b; int sum = u1 + u2; mix(sum > 255 ? 255 : sum);
    mix(((uint32_t)a & 0xffff) | ((uint32_t)b << 16));
  }
  line("dsp");
}

// array loops: at -O2 clang vectorizes these into neon (vld / vst, vadd, vmul, vmla, vmax, vqadd, vmovl...)
static float fa[64], fb[64], fc[64]; static int32_t ia[64], ib[64]; static int16_t sa[64], sb[64]; static uint8_t ba[64], bb[64];
__attribute__((noinline)) static void vector(void) {
  for (int r = 0; r < N / 20 + 1; r++) {
    for (int i = 0; i < 64; i++) { fa[i] = (float)(int)(rnd() % 20001 - 10000) / 64.f; fb[i] = (float)(int)(rnd() % 2001 - 1000) / 16.f; ia[i] = (int32_t)rnd() >> 4; ib[i] = (int32_t)rnd() >> 6; sa[i] = rnd(); sb[i] = rnd(); ba[i] = rnd(); bb[i] = rnd(); }
    float dot = 0; for (int i = 0; i < 64; i++) dot += fa[i] * fb[i]; mixf(dot);
    for (int i = 0; i < 64; i++) fc[i] = fa[i] * 0.75f + fb[i]; for (int i = 0; i < 64; i++) mixf(fc[i]);
    for (int i = 0; i < 64; i++) fc[i] = fa[i] > fb[i] ? fa[i] : fb[i]; for (int i = 0; i < 64; i++) mixf(fc[i]);
    for (int i = 0; i < 64; i++) fc[i] = (float)ia[i] * 0.5f - fa[i]; for (int i = 0; i < 64; i++) mixf(fc[i]);
    int32_t is = 0; for (int i = 0; i < 64; i++) is += ia[i] * ib[i]; mix(is);
    for (int i = 0; i < 64; i++) ia[i] = (ia[i] >> 3) + (ib[i] << 2) - (int32_t)fb[i]; for (int i = 0; i < 64; i++) mix(ia[i]);
    for (int i = 0; i < 64; i++) { int v = sa[i] + sb[i]; sa[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; } for (int i = 0; i < 64; i++) mix(sa[i]);
    for (int i = 0; i < 64; i++) { int v = ba[i] + bb[i]; ba[i] = v > 255 ? 255 : v; } for (int i = 0; i < 64; i++) mix(ba[i]);
    for (int i = 0; i < 64; i++) ib[i] = sa[i] * (int32_t)bb[i]; for (int i = 0; i < 64; i++) mix(ib[i]);
    uint32_t bs = 0; for (int i = 0; i < 64; i++) bs += ba[i]; mix(bs);
    for (int i = 0; i < 64; i++) ba[i] = (ba[i] + bb[i] + 1) >> 1; for (int i = 0; i < 64; i++) mix(ba[i]);
    for (int i = 0; i < 64; i++) fc[i] = fa[i] < 0 ? -fa[i] : fa[i]; for (int i = 0; i < 64; i++) mixf(fc[i]);
    for (int i = 0; i < 64; i++) ia[i] = (int32_t)(fa[i] * 3.0f); for (int i = 0; i < 64; i++) mix(ia[i]);
  }
  line("vector");
}

// physics-style float code: vec3 / quaternion math, normalizing, validity checks like physx's isValid()
typedef struct { float x, y, z; } V3;
static V3 v3(void) { V3 v = { (float)(int)(rnd() % 2001 - 1000) / 37.f, (float)(int)(rnd() % 2001 - 1000) / 11.f, (float)(int)(rnd() % 201 - 100) / 3.f }; return v; }
static int finite(float f) { return f == f && f - f == 0.f; }
static int valid(V3 v) { return finite(v.x) && finite(v.y) && finite(v.z); }
__attribute__((noinline)) static void physics(void) {
  for (int i = 0; i < N; i++) {
    V3 a = v3(), b = v3();
    if (i % 17 == 3) a.y = 0.f / 0.f; if (i % 23 == 5) b.z = 1.f / 0.f;
    V3 c = { a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x };
    float d = a.x * b.x + a.y * b.y + a.z * b.z, l = __builtin_sqrtf(c.x * c.x + c.y * c.y + c.z * c.z);
    mixf(c.x); mixf(c.y); mixf(c.z); mixf(d); mixf(l); mix(valid(a)); mix(valid(c));
    if (l > 1e-6f) { float k = 1.f / l; mixf(c.x * k); mixf(c.y * k); mixf(c.z * k); }
    float q[4] = { a.x, a.y, a.z, d }; float m = __builtin_sqrtf(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (m > 0.f && finite(m)) for (int k = 0; k < 4; k++) mixf(q[k] / m);
    mix(d > l); mix(d < -l); mix(!(d >= 0.f)); mix(a.x <= b.x || a.y > b.y);
    double dd = (double)a.x * b.y - (double)a.y * b.x; mixd(dd); mix(dd != dd); mix(dd > 1e3);
    float mx = a.x > b.x ? a.x : b.x, mn = a.y < b.y ? a.y : b.y; mixf(mx); mixf(mn);
    mixf(a.x * a.x * a.x - b.y / (b.z != 0.f ? b.z : 1.f));
  }
  line("physics");
}

int diff_test(char *buf, int size) {
  out = buf; left = size;
  ints(); longs(); doubles(); floats(); control(); dsp(); vector(); physics();
  return 1;
}
#ifdef HOST
int main(void) { static char b[4 << 20]; diff_test(b, sizeof b); fputs(b, stdout); return 0; }
#endif
