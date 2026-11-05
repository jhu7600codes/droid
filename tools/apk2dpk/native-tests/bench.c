// cpu benchmark for the arm emulator: integer loops, memory, floats, calls and branches
typedef unsigned int u32;
static u32 buf[4096];
static float fa[1024], fb[1024];
__attribute__((noinline)) static u32 crc(const unsigned char *p, int n) { u32 c = ~0u; for (int i = 0; i < n; i++) { c ^= p[i]; for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xedb88320u & -(c & 1)); } return ~c; }
__attribute__((noinline)) static void sort(u32 *a, int n) { for (int i = 1; i < n; i++) { u32 v = a[i]; int j = i - 1; while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; } a[j + 1] = v; } }
__attribute__((noinline)) static float dot(int n) { float s = 0; for (int i = 0; i < n; i++) s += fa[i] * fb[i]; return s; }
__attribute__((noinline)) static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
int bench(int which) {
  u32 x = 1; for (int i = 0; i < 4096; i++) { x = x * 1103515245u + 12345u; buf[i] = x >> 8; }
  for (int i = 0; i < 1024; i++) { fa[i] = (float)(i % 17) * 0.5f; fb[i] = (float)(i % 13) - 3.f; }
  u32 r = 0;
  if (which == 0 || which == 9) for (int k = 0; k < 20; k++) r += crc((const unsigned char *)buf, 16384);
  if (which == 1 || which == 9) { sort(buf, 2500); r += buf[100]; }
  if (which == 2 || which == 9) for (int k = 0; k < 300; k++) r += (u32)dot(1024);
  if (which == 3 || which == 9) r += fib(24);
  return (int)r;
}
