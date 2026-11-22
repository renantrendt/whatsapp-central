// Inicia o Node dentro do app e manda o que ele escreve (console.log) para o
// log do Android, que se lê com: adb logcat -s WCNode
#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "node.h"

static int out_pipe[2];
static int err_pipe[2];

static void *pump(void *arg) {
  int fd = *static_cast<int *>(arg);
  int prio = fd == err_pipe[0] ? ANDROID_LOG_ERROR : ANDROID_LOG_INFO;
  char buf[2048];
  ssize_t n;
  while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
    if (buf[n - 1] == '\n') --n;
    buf[n] = 0;
    __android_log_write(prio, "WCNode", buf);
  }
  return nullptr;
}

static void redirect_output() {
  setvbuf(stdout, nullptr, _IOLBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  pipe(out_pipe);
  pipe(err_pipe);
  dup2(out_pipe[1], STDOUT_FILENO);
  dup2(err_pipe[1], STDERR_FILENO);
  pthread_t t1, t2;
  pthread_create(&t1, nullptr, pump, &out_pipe[0]);
  pthread_create(&t2, nullptr, pump, &err_pipe[0]);
  pthread_detach(t1);
  pthread_detach(t2);
}

extern "C" JNIEXPORT jint JNICALL
Java_app_whatsappcentral_NodeService_startNode(JNIEnv *env, jobject, jobjectArray args) {
  jsize argc = env->GetArrayLength(args);
  // O Node exige que os argumentos fiquem num único bloco contínuo de memória.
  size_t total = 0;
  for (jsize i = 0; i < argc; i++) {
    auto s = (jstring) env->GetObjectArrayElement(args, i);
    const char *c = env->GetStringUTFChars(s, nullptr);
    total += strlen(c) + 1;
    env->ReleaseStringUTFChars(s, c);
  }
  char *block = static_cast<char *>(calloc(total, 1));
  char **argv = static_cast<char **>(calloc(argc + 1, sizeof(char *)));
  char *p = block;
  for (jsize i = 0; i < argc; i++) {
    auto s = (jstring) env->GetObjectArrayElement(args, i);
    const char *c = env->GetStringUTFChars(s, nullptr);
    size_t len = strlen(c);
    memcpy(p, c, len);
    argv[i] = p;
    p += len + 1;
    env->ReleaseStringUTFChars(s, c);
  }
  redirect_output();
  return jint(node::Start(argc, argv));
}
