// droid wasm demo: a plasma effect drawn into a framebuffer by c, shown by a tiny js loader.
// build: clang --target=wasm32 -O2 -nostdlib -Wl,--no-entry -Wl,--export-dynamic -o demo.wasm src/demo.c
// imports come from the droid import table (docs/sdk.md), strings are pointer + length.

#define EXPORT __attribute__((visibility("default")))
#define IMPORT(name) __attribute__((import_module("env"), import_name(name)))

IMPORT("droid_toast") void droid_toast(const char *s, int n);
IMPORT("droid_title") void droid_title(const char *s, int n);
IMPORT("droid_vibrate") void droid_vibrate(int ms);

#define MAXW 512
#define MAXH 512
static unsigned int fb[MAXW * MAXH];
static int W = 256, H = 256, taps = 0;

static int len(const char *s) { int n = 0; while (s[n]) n++; return n; }
static void say(const char *s) { droid_toast(s, len(s)); }

// fixed point sine table, 256 steps, values -127..127
static signed char sine[256];
static void make_sine(void) {
  // parabola approximation of sin, good enough for colors
  for (int i = 0; i < 256; i++) {
    int x = i < 128 ? i : i - 128;           // 0..127
    int y = (x * (128 - x)) >> 5;           // 0..128
    sine[i] = (signed char)(i < 128 ? (y > 127 ? 127 : y) : -(y > 127 ? 127 : y));
  }
}

EXPORT unsigned int *init(int w, int h) {
  W = w > MAXW ? MAXW : w;
  H = h > MAXH ? MAXH : h;
  make_sine();
  const char *t = "wasm demo (c)";
  droid_title(t, len(t));
  return fb;
}

EXPORT int width(void) { return W; }
EXPORT int height(void) { return H; }

// t: time in ms
EXPORT void frame(int t) {
  int a = t / 16, b = t / 23, c = t / 31;
  for (int y = 0; y < H; y++) {
    for (int x = 0; x < W; x++) {
      int v = sine[(x + a) & 255] + sine[(y + b) & 255] + sine[((x + y) / 2 + c) & 255] + sine[((x - y) / 3 - a) & 255];
      int i = (v + 512) >> 2; // 0..255
      // holo-ish palette: dark -> holo blue -> white
      int r = sine[(i + 0) & 255] / 3 + 20;
      int g = (i * 181) >> 8;
      int bl = 120 + (sine[(i * 2) & 255] >> 1);
      if (r < 0) r = 0;
      if (bl > 255) bl = 255;
      fb[y * W + x] = 0xff000000u | ((unsigned)bl << 16) | ((unsigned)g << 8) | (unsigned)r;
    }
  }
}

EXPORT void tap(int x, int y) {
  taps++;
  droid_vibrate(15);
  if (taps == 1) say("hello from c");
  else if (taps == 5) say("five taps, still running in wasm");
}
