// null pointer faults reaching a SIGSEGV handler: leaving by longjmp, and by editing the ucontext
// (moving pc on, the way mono turns a fault into NullReferenceException)
typedef unsigned long size_t;
int snprintf(char *, size_t, const char *, ...);
struct sigaction_ { void (*fn)(int, void *, void *); unsigned mask; int flags; void *restorer; };
int sigaction(int, const struct sigaction_ *, struct sigaction_ *);
typedef long jmp_buf[64];
int setjmp(jmp_buf); void longjmp(jmp_buf, int);
static jmp_buf jb; static volatile int hits, mode; static volatile unsigned fault_addr;
static void handler(int sig, void *info, void *ucv) {
  hits++;
  fault_addr = ((unsigned *)info)[3];
  if (mode == 0) longjmp(jb, 1);
  unsigned *mc = (unsigned *)((char *)ucv + 20);
  mc[3 + 0] = 4242; // r0: the value the faulting load "returns"
  mc[3 + 15] += (mc[19] & 0x20) ? 2 : 4; // pc: skip the load (16-bit thumb ldr / arm ldr)
}
__attribute__((noinline)) static int load(volatile int *p) { return *p; }
__attribute__((noinline, naked)) static int load_r0(int *p) { __asm__ volatile("ldr r0, [r0, #8]\n bx lr"); }
int faults_test(char *out, int size) {
  struct sigaction_ sa = { handler, 0, 4 /* SA_SIGINFO */, 0 };
  sigaction(11, &sa, 0);
  int ok = 1, n = 0;
  mode = 0;
  if (!setjmp(jb)) { load((int *)16); ok = 0; }
  if (hits != 1 || fault_addr != 16) ok = 0;
  mode = 1;
  int v = load_r0((int *)0);
  if (v != 4242 || hits != 2 || fault_addr != 8) ok = 0;
  for (int i = 0; i < 50; i++) { mode = 0; if (!setjmp(jb)) load((int *)(i * 4)); } // many, without growing anything
  if (hits != 52) ok = 0;
  n = snprintf(out, size, "faults: hits %d, last at 0x%x, value %d\n", hits, fault_addr, v);
  (void)n;
  return ok;
}
