// the android framework's native methods, written for the web platform. the framework itself is
// the real android 4.4 code (tools/aosp/build.py builds it to framework.dex); what android does in
// c++ (skia, the resource table, the log, the looper...) droid does here.
import type { VM } from '../dalvik.ts'
import { jstr } from '../java.ts'
import { registerParcel } from './parcel.ts'

const LEVEL = ['', '', 'V', 'D', 'I', 'W', 'E', 'A']

export function registerAospNatives(vm: VM) {
  const text = (x: any) => (x == null ? '' : jstr(vm, x))
  registerParcel(vm)

  vm.registerNatives('Landroid/util/Log;', {
    'isLoggable(Ljava/lang/String;I)Z': (v, s, [, level]) => (level >= 4 ? 1 : 0),
    'println_native(IILjava/lang/String;Ljava/lang/String;)I': (v, s, [, prio, tag, msg]) => {
      const line = `${LEVEL[prio] || '?'}/${text(tag)}: ${text(msg)}`
      if (prio >= 6) console.error(line); else if (prio === 5) console.warn(line); else console.log(line)
      return line.length
    },
  })
  vm.registerNatives('Landroid/os/SystemClock;', {
    'uptimeMillis()J': () => BigInt(Math.floor(performance.now())),
    'elapsedRealtime()J': () => BigInt(Math.floor(performance.now())),
    'elapsedRealtimeNanos()J': () => BigInt(Math.floor(performance.now() * 1e6)),
    'currentThreadTimeMillis()J': () => BigInt(Math.floor(performance.now())),
    'currentThreadTimeMicro()J': () => BigInt(Math.floor(performance.now() * 1000)),
    'currentTimeMicro()J': () => BigInt(Date.now()) * 1000n,
    'setCurrentTimeMillis(J)Z': () => 0,
  })
  vm.registerNatives('Landroid/os/Process;', {
    'myPid()I': () => 1000, 'myTid()I': () => vm.current.id, 'myUid()I': () => 10000,
    'setThreadPriority(I)V': () => {}, 'setThreadPriority(II)V': () => {}, 'getThreadPriority(I)I': () => 0,
    'setCanSelfBackground(Z)V': () => {}, 'getElapsedCpuTime()J': () => BigInt(Math.floor(performance.now())),
  })
  vm.registerNatives('Landroid/os/Binder;', {
    'getCallingPid()I': () => 1000, 'getCallingUid()I': () => 10000, 'clearCallingIdentity()J': () => 0n,
    'restoreCallingIdentity(J)V': () => {}, 'flushPendingCommands()V': () => {}, 'joinThreadPool()V': () => {},
    'setThreadStrictModePolicy(I)V': () => {}, 'getThreadStrictModePolicy()I': () => 0,
    'init()V': () => {}, 'destroy()V': () => {},
  })
  vm.registerNatives('Landroid/os/SystemProperties;', {
    'native_get(Ljava/lang/String;)Ljava/lang/String;': (v, s, [k]) => PROPS[text(k)] ?? '',
    'native_get(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [k, d]) => PROPS[text(k)] ?? d,
    'native_get_int(Ljava/lang/String;I)I': (v, s, [k, d]) => (PROPS[text(k)] != null ? parseInt(PROPS[text(k)]) | 0 : d),
    'native_get_long(Ljava/lang/String;J)J': (v, s, [k, d]) => (PROPS[text(k)] != null ? BigInt(parseInt(PROPS[text(k)])) : d),
    'native_get_boolean(Ljava/lang/String;Z)Z': (v, s, [k, d]) => { const x = PROPS[text(k)]; return x == null ? d : x === '1' || x === 'true' ? 1 : 0 },
    'native_set(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [k, x]) => { PROPS[text(k)] = text(x) },
    'native_add_change_callback()V': () => {},
  })
}

const PROPS: Record<string, string> = {
  'ro.build.version.sdk': '19', 'ro.build.version.release': '4.4.4', 'ro.build.id': 'KTU84Q', 'ro.product.model': 'Droid',
  'ro.product.manufacturer': 'Danen', 'ro.product.brand': 'droid', 'ro.product.device': 'droid', 'ro.hardware': 'droid',
  'ro.sf.lcd_density': '320', 'ro.config.low_ram': 'false', 'ro.debuggable': '0', 'ro.secure': '1',
}
