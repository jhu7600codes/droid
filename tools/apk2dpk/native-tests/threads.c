// native runtime test: pthreads, mutexes, conditions, semaphores, keys, once, sleep, signals
// (a stop-the-world handshake like a garbage collector's), setjmp / longjmp, stdio, files, qsort.
// built with clang -nostdlib, so libc is declared by hand (bionic arm abi).
typedef unsigned int size_t;
typedef long pthread_t;
typedef struct { int v; } pthread_mutex_t;
typedef struct { int v; } pthread_cond_t;
typedef struct { unsigned int c; } sem_t;
typedef int pthread_key_t;
typedef int pthread_once_t;
typedef struct { unsigned long b[64]; } jmp_buf;
typedef struct { void (*h)(int); unsigned long mask; int flags; void (*r)(void); } sigact;
typedef void FILE;
extern int pthread_create(pthread_t *, void *, void *(*)(void *), void *);
extern int pthread_join(pthread_t, void **);
extern pthread_t pthread_self(void);
extern int pthread_mutex_init(pthread_mutex_t *, void *);
extern int pthread_mutex_lock(pthread_mutex_t *);
extern int pthread_mutex_unlock(pthread_mutex_t *);
extern int pthread_cond_init(pthread_cond_t *, void *);
extern int pthread_cond_wait(pthread_cond_t *, pthread_mutex_t *);
extern int pthread_cond_signal(pthread_cond_t *);
extern int pthread_cond_broadcast(pthread_cond_t *);
extern int sem_init(sem_t *, int, unsigned);
extern int sem_wait(sem_t *);
extern int sem_post(sem_t *);
extern int pthread_key_create(pthread_key_t *, void *);
extern int pthread_setspecific(pthread_key_t, const void *);
extern void *pthread_getspecific(pthread_key_t);
extern int pthread_once(pthread_once_t *, void (*)(void));
extern int pthread_kill(pthread_t, int);
extern int sigaction(int, const sigact *, sigact *);
extern int sigsuspend(const unsigned long *);
extern int usleep(unsigned);
extern int setjmp(jmp_buf *);
extern void longjmp(jmp_buf *, int);
extern int snprintf(char *, size_t, const char *, ...);
extern int sscanf(const char *, const char *, ...);
extern FILE *fopen(const char *, const char *);
extern int fclose(FILE *);
extern size_t fwrite(const void *, size_t, size_t, FILE *);
extern char *fgets(char *, int, FILE *);
extern int fprintf(FILE *, const char *, ...);
extern void qsort(void *, size_t, size_t, int (*)(const void *, const void *));
extern void *malloc(size_t);
extern void *realloc(void *, size_t);
extern void free(void *);
extern int strcmp(const char *, const char *);
extern unsigned int strlen(const char *);
extern double sqrt(double);
extern int __android_log_print(int, const char *, const char *, ...);
#define LOG(...) __android_log_print(4, "nt", __VA_ARGS__)

static pthread_mutex_t mu; static int counter;
static void *adder(void *a) { for (int i = 0; i < 2000; i++) { pthread_mutex_lock(&mu); int v = counter; if ((i & 63) == 0) usleep(1); counter = v + 1; pthread_mutex_unlock(&mu); } return a; }

static pthread_cond_t cv; static int queue[8], qn, produced, consumed_sum;
static void *producer(void *a) { for (int i = 1; i <= 100; i++) { pthread_mutex_lock(&mu); while (qn == 8) pthread_cond_wait(&cv, &mu); queue[qn++] = i; pthread_cond_broadcast(&cv); pthread_mutex_unlock(&mu); } return 0; }
static void *consumer(void *a) { int got = 0; while (got < 100) { pthread_mutex_lock(&mu); while (qn == 0) pthread_cond_wait(&cv, &mu); consumed_sum += queue[--qn]; got++; pthread_cond_broadcast(&cv); pthread_mutex_unlock(&mu); } return 0; }

static sem_t ping, pong; static int rounds;
static void *ponger(void *a) { for (int i = 0; i < 50; i++) { sem_wait(&ping); rounds++; sem_post(&pong); } return 0; }

static pthread_key_t key; static pthread_once_t once; static int once_count;
static void init_once(void) { once_count++; }
static void *keyer(void *a) { pthread_once(&once, init_once); pthread_setspecific(key, a); usleep(2000); return pthread_getspecific(key); }

// stop the world: the "collector" signals a thread, waits for its ack, then lets it go on
#define SUSPEND 30
#define RESTART 31
static sem_t ack; static volatile int suspended, resumed, worker_spins, stop_worker;
static void on_restart(int s) { resumed++; }
static void on_suspend(int s) { suspended++; sem_post(&ack); unsigned long mask = 0; sigsuspend(&mask); sem_post(&ack); }
static void *worker(void *a) { while (!stop_worker) { worker_spins++; if ((worker_spins & 1023) == 0) usleep(1); } return 0; }

static int cmp(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }

int threads_test(char *out, int n) {
  int ok = 1; char *p = out; int left = n;
#define CHECK(cond, ...) do { int k = snprintf(p, left, __VA_ARGS__); p += k; left -= k; if (!(cond)) { ok = 0; k = snprintf(p, left, " FAIL\n"); } else k = snprintf(p, left, " ok\n"); p += k; left -= k; } while (0)
  pthread_mutex_init(&mu, 0); pthread_cond_init(&cv, 0);
  pthread_t t[4];
  for (int i = 0; i < 4; i++) pthread_create(&t[i], 0, adder, (void *)i);
  for (int i = 0; i < 4; i++) pthread_join(t[i], 0);
  CHECK(counter == 8000, "mutex counter %d", counter);
  pthread_t pr, co;
  pthread_create(&co, 0, consumer, 0); pthread_create(&pr, 0, producer, 0);
  pthread_join(pr, 0); pthread_join(co, 0);
  CHECK(consumed_sum == 5050, "cond queue sum %d", consumed_sum);
  sem_init(&ping, 0, 0); sem_init(&pong, 0, 0);
  pthread_t pg; pthread_create(&pg, 0, ponger, 0);
  for (int i = 0; i < 50; i++) { sem_post(&ping); sem_wait(&pong); }
  pthread_join(pg, 0);
  CHECK(rounds == 50, "semaphore ping pong %d", rounds);
  pthread_key_create(&key, 0);
  pthread_t k1, k2; void *r1, *r2;
  pthread_create(&k1, 0, keyer, (void *)11); pthread_create(&k2, 0, keyer, (void *)22);
  pthread_join(k1, &r1); pthread_join(k2, &r2);
  CHECK((int)r1 == 11 && (int)r2 == 22 && once_count == 1, "keys %d %d, once %d", (int)r1, (int)r2, once_count);
  sigact sa = { on_suspend, 0, 0, 0 }, sr = { on_restart, 0, 0, 0 };
  sigaction(SUSPEND, &sa, 0); sigaction(RESTART, &sr, 0);
  sem_init(&ack, 0, 0);
  pthread_t w; pthread_create(&w, 0, worker, 0);
  usleep(5000);
  pthread_kill(w, SUSPEND); sem_wait(&ack);
  int frozen = worker_spins; usleep(5000); int still = worker_spins == frozen;
  pthread_kill(w, RESTART); sem_wait(&ack);
  usleep(5000); int moved = worker_spins != frozen;
  stop_worker = 1; pthread_join(w, 0);
  CHECK(suspended == 1 && resumed == 1 && still && moved, "stop the world: suspended %d resumed %d frozen %d moved %d", suspended, resumed, still, moved);
  jmp_buf jb; volatile int jumps = 0;
  if (setjmp(&jb) < 3) { jumps++; longjmp(&jb, jumps); }
  CHECK(jumps == 3, "setjmp / longjmp %d", jumps);
  char buf[128]; int a = 0; float f = 0; char word[16];
  snprintf(buf, sizeof buf, "%d %5.2f %s %x %c %lld", -42, 3.14159, "pigeon", 255, 'Z', 1234567890123LL);
  CHECK(strcmp(buf, "-42  3.14 pigeon ff Z 1234567890123") == 0, "printf \"%s\"", buf);
  int got = sscanf("17 2.5 coo", "%d %f %15s", &a, &f, word);
  CHECK(got == 3 && a == 17 && f == 2.5f && strcmp(word, "coo") == 0, "sscanf %d %d %s", got, a, word);
  FILE *fp = fopen("/data/data/test/notes.txt", "w");
  fprintf(fp, "line one\nline %d\n", 2); fclose(fp);
  fp = fopen("/data/data/test/notes.txt", "r");
  char l1[32], l2[32]; fgets(l1, 32, fp); fgets(l2, 32, fp); fclose(fp);
  CHECK(strcmp(l1, "line one\n") == 0 && strcmp(l2, "line 2\n") == 0, "files");
  int arr[] = { 5, 3, 9, 1, 7 }; qsort(arr, 5, 4, cmp);
  CHECK(arr[0] == 1 && arr[4] == 9, "qsort %d %d %d %d %d", arr[0], arr[1], arr[2], arr[3], arr[4]);
  void *blocks[200]; for (int i = 0; i < 200; i++) blocks[i] = malloc(i * 37 + 1);
  for (int i = 0; i < 200; i += 2) free(blocks[i]);
  char *big = realloc(blocks[1], 100000); big[99999] = 7;
  CHECK(big[99999] == 7, "malloc / realloc");
  CHECK(sqrt(2.0) > 1.414 && sqrt(2.0) < 1.415, "soft float sqrt");
  return ok;
}
