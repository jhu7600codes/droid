// the native part of the test apk: a few jni functions plus calls into libc and liblog,
// so the droid arm runtime has to load an elf, resolve imports and run arm code.
typedef void *jobject;
typedef jobject jstring;
typedef const void *const *JNIEnv; // pointer to the function table; we index it directly
typedef jstring (*NewStringUTF_t)(JNIEnv *, const char *);
#define JNI(env, i, T) ((T)((*(env))[i]))
#define NEW_STRING_UTF 167

extern unsigned int strlen(const char *s);
extern void *malloc(unsigned int n);
extern void free(void *p);
extern int __android_log_print(int prio, const char *tag, const char *fmt, ...);

static const char msg[] = "Hello from ARM native code";

jstring Java_com_droid_hellojni_MainActivity_stringFromJNI(JNIEnv *env, jobject thiz) {
  unsigned int n = strlen(msg);
  char *buf = malloc(n + 16);
  for (unsigned int i = 0; i < n; i++) buf[i] = msg[i];
  const char *tail = " (armeabi-v7a)";
  unsigned int j = 0;
  while (tail[j]) { buf[n + j] = tail[j]; j++; }
  buf[n + j] = 0;
  __android_log_print(3, "hello", "stringFromJNI: %d chars", (int)(n + j));
  jstring s = JNI(env, NEW_STRING_UTF, NewStringUTF_t)(env, buf);
  free(buf);
  return s;
}

int Java_com_droid_hellojni_MainActivity_add(JNIEnv *env, jobject thiz, int a, int b) {
  return a + b;
}

long long Java_com_droid_hellojni_MainActivity_fib(JNIEnv *env, jobject thiz, int n) {
  long long a = 0, b = 1;
  for (int i = 0; i < n; i++) { long long t = a + b; a = b; b = t; }
  return a;
}
