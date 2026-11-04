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

// ---------- opengl es 2: a spinning triangle with a shader, plus a busy loop so a frame takes a while ----------
typedef unsigned int GLuint; typedef int GLint; typedef unsigned int GLenum; typedef float GLfloat;
extern GLuint glCreateShader(GLenum); extern void glShaderSource(GLuint, int, const char *const *, const int *);
extern void glCompileShader(GLuint); extern GLuint glCreateProgram(void); extern void glAttachShader(GLuint, GLuint);
extern void glLinkProgram(GLuint); extern void glUseProgram(GLuint); extern GLint glGetAttribLocation(GLuint, const char *);
extern GLint glGetUniformLocation(GLuint, const char *); extern void glUniform1f(GLint, GLfloat);
extern void glVertexAttribPointer(GLuint, int, GLenum, unsigned char, int, const void *); extern void glEnableVertexAttribArray(GLuint);
extern void glDrawArrays(GLenum, int, int); extern void glClearColor(GLfloat, GLfloat, GLfloat, GLfloat); extern void glClear(unsigned);
extern void glViewport(int, int, int, int); extern void glGetShaderiv(GLuint, GLenum, GLint *); extern void glGetProgramiv(GLuint, GLenum, GLint *);
extern float sinf(float); extern float cosf(float);
static GLuint prog; static GLint aPos, uAngle; static int frames;
static const char *vs = "attribute vec2 pos; uniform float angle; varying vec3 col;"
  "void main() { float c = cos(angle), s = sin(angle); gl_Position = vec4(c * pos.x - s * pos.y, s * pos.x + c * pos.y, 0.0, 1.0); col = vec3(pos * 0.8 + 0.5, 0.9); }";
static const char *fs = "precision mediump float; varying vec3 col; void main() { gl_FragColor = vec4(col, 1.0); }";
static GLuint compile(GLenum type, const char *src) { GLuint s = glCreateShader(type); glShaderSource(s, 1, &src, 0); glCompileShader(s); return s; }
void Java_com_droid_hellojni_GlActivity_glInit(void *env, void *cls, int w, int h) {
  prog = glCreateProgram();
  glAttachShader(prog, compile(0x8B31, vs)); glAttachShader(prog, compile(0x8B30, fs));
  glLinkProgram(prog);
  GLint ok = 0; glGetProgramiv(prog, 0x8B82, &ok);
  __android_log_print(4, "gl", "program linked %d, viewport %dx%d", ok, w, h);
  aPos = glGetAttribLocation(prog, "pos"); uAngle = glGetUniformLocation(prog, "angle");
  glViewport(0, 0, w, h);
}
int Java_com_droid_hellojni_GlActivity_glFrame(void *env, void *cls, long long ms) {
  static const GLfloat tri[] = { 0.0f, 0.7f, -0.6f, -0.5f, 0.6f, -0.5f };
  volatile int spin = 0; for (int i = 0; i < 200000; i++) spin += i; // heavy enough to cross a time slice
  glClearColor(0.05f, 0.1f, 0.2f, 1.0f); glClear(0x4000);
  glUseProgram(prog);
  glUniform1f(uAngle, (float)ms / 500.0f);
  glVertexAttribPointer(aPos, 2, 0x1406, 0, 0, tri); // client-side array
  glEnableVertexAttribArray(aPos);
  glDrawArrays(4, 0, 3);
  if (++frames % 60 == 0) __android_log_print(4, "gl", "%d frames", frames);
  return frames;
}
