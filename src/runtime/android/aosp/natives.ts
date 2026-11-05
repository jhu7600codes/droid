// the android framework's native methods, written for the web platform. the framework itself is
// the real android 4.4 code (tools/aosp/build.py builds it to framework.dex); what android does in
// c++ (skia, the resource table, the log, the looper...) droid does here.
import type { VM } from '../dalvik.ts'
import { jstr } from '../java.ts'
import { registerParcel } from './parcel.ts'
import { registerAospRes } from './res.ts'

const LEVEL = ['', '', 'V', 'D', 'I', 'W', 'E', 'A']

export function registerAospNatives(vm: VM) {
  const text = (x: any) => (x == null ? '' : jstr(vm, x))
  registerParcel(vm)
  registerAospRes(vm)
  registerIcu(vm, text)

  vm.registerNatives('Landroid/util/Log;', {
    'isLoggable(Ljava/lang/String;I)Z': (v, s, [, level]) => (level >= 4 ? 1 : 0),
    'println_native(IILjava/lang/String;Ljava/lang/String;)I': (v, s, [, prio, tag, msg]) => {
      const line = `${LEVEL[prio] || '?'}/${text(tag)}: ${text(msg)}`
      if (prio >= 6) console.error(line); else if (prio === 5) console.warn(line); else console.log(line)
      return line.length
    },
  })
  vm.registerNatives('Landroid/os/Trace;', {
    'nativeGetEnabledTags()J': () => 0n, 'nativeTraceCounter(JLjava/lang/String;I)V': () => {},
    'nativeTraceBegin(JLjava/lang/String;)V': () => {}, 'nativeTraceEnd(J)V': () => {},
    'nativeAsyncTraceBegin(JLjava/lang/String;I)V': () => {}, 'nativeAsyncTraceEnd(JLjava/lang/String;I)V': () => {},
    'nativeSetAppTracingAllowed(Z)V': () => {}, 'nativeSetTracingEnabled(Z)V': () => {},
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

// libcore's ICU on the browser's Intl
function registerIcu(vm: VM, text: (x: any) => string) {
  const tag = (l: string) => text(l).replace(/_/g, '-') || 'en'
  const strs = (l: string[]) => { const a = vm.newArray('[Ljava/lang/String;', l.length); l.forEach((x, i) => (a.data[i] = x)); return a }
  const locales = ['en_US', 'en_GB', 'ru_RU', 'de_DE', 'fr_FR', 'es_ES', 'it_IT', 'ja_JP', 'ko_KR', 'zh_CN', 'pt_BR', 'uk_UA', 'pl_PL', 'tr_TR', 'nl_NL']
  const display = (type: 'language' | 'region', code: string, loc: string) => { try { return new Intl.DisplayNames([tag(loc)], { type }).of(code) ?? code } catch { return code } }
  vm.registerNatives('Llibcore/icu/ICU;', {
    'addLikelySubtags(Ljava/lang/String;)Ljava/lang/String;': (v, s, [l]) => { try { const m = new Intl.Locale(tag(l)).maximize(); return [m.language, m.script, m.region].filter(Boolean).join('_') } catch { return text(l) } },
    'getScript(Ljava/lang/String;)Ljava/lang/String;': (v, s, [l]) => { try { return new Intl.Locale(tag(l)).maximize().script ?? '' } catch { return '' } },
    'getCldrVersion()Ljava/lang/String;': () => '23', 'getIcuVersion()Ljava/lang/String;': () => '51.1', 'getUnicodeVersion()Ljava/lang/String;': () => '6.2',
    'toLowerCase(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [x, l]) => text(x).toLocaleLowerCase(tag(l)),
    'toUpperCase(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [x, l]) => text(x).toLocaleUpperCase(tag(l)),
    'getAvailableLocalesNative()[Ljava/lang/String;': () => strs(locales),
    'getAvailableBreakIteratorLocalesNative()[Ljava/lang/String;': () => strs(locales), 'getAvailableCalendarLocalesNative()[Ljava/lang/String;': () => strs(locales),
    'getAvailableCollatorLocalesNative()[Ljava/lang/String;': () => strs(locales), 'getAvailableDateFormatLocalesNative()[Ljava/lang/String;': () => strs(locales),
    'getAvailableNumberFormatLocalesNative()[Ljava/lang/String;': () => strs(locales),
    'getAvailableCurrencyCodes()[Ljava/lang/String;': () => strs(['USD', 'EUR', 'GBP', 'RUB', 'JPY', 'CNY', 'UAH']),
    'getCurrencyCode(Ljava/lang/String;)Ljava/lang/String;': (v, s, [c]) => ({ US: 'USD', GB: 'GBP', RU: 'RUB', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', JP: 'JPY', CN: 'CNY', UA: 'UAH', BR: 'BRL' } as Record<string, string>)[text(c)] ?? null,
    'getCurrencyDisplayName(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [l, c]) => { try { return new Intl.DisplayNames([tag(l)], { type: 'currency' }).of(text(c)) ?? text(c) } catch { return text(c) } },
    'getCurrencyFractionDigits(Ljava/lang/String;)I': (v, s, [c]) => (text(c) === 'JPY' ? 0 : 2),
    'getCurrencySymbol(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [l, c]) => { try { return new Intl.NumberFormat(tag(l), { style: 'currency', currency: text(c) }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? text(c) } catch { return text(c) } },
    'getDisplayCountryNative(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [c, l]) => display('region', text(c), l),
    'getDisplayLanguageNative(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [c, l]) => display('language', text(c), l),
    'getDisplayVariantNative(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [x]) => text(x),
    'getISO3CountryNative(Ljava/lang/String;)Ljava/lang/String;': (v, s, [l]) => ({ US: 'USA', GB: 'GBR', RU: 'RUS', DE: 'DEU', FR: 'FRA', UA: 'UKR', JP: 'JPN', CN: 'CHN' } as Record<string, string>)[text(l).split('_')[1] ?? ''] ?? '',
    'getISO3LanguageNative(Ljava/lang/String;)Ljava/lang/String;': (v, s, [l]) => ({ en: 'eng', ru: 'rus', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', ja: 'jpn', zh: 'zho', uk: 'ukr' } as Record<string, string>)[text(l).split('_')[0]] ?? '',
    'getISOLanguagesNative()[Ljava/lang/String;': () => strs(['en', 'ru', 'de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt', 'uk', 'pl', 'tr', 'nl']),
    'getISOCountriesNative()[Ljava/lang/String;': () => strs(['US', 'GB', 'RU', 'DE', 'FR', 'ES', 'IT', 'JP', 'KR', 'CN', 'BR', 'UA', 'PL', 'TR', 'NL']),
    'getBestDateTimePatternNative(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [sk]) => text(sk),
    'initLocaleDataNative(Ljava/lang/String;Llibcore/icu/LocaleData;)Z': (v, s, [, d]) => {
      Object.assign(d.f, {
        firstDayOfWeek: 1, minimalDaysInFirstWeek: 1, amPm: strs(['AM', 'PM']), eras: strs(['BC', 'AD']),
        longMonthNames: strs(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']),
        shortMonthNames: strs(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']),
        tinyMonthNames: strs(['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']),
        longStandAloneMonthNames: strs(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']),
        shortStandAloneMonthNames: strs(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']),
        tinyStandAloneMonthNames: strs(['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']),
        longWeekdayNames: strs(['', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']),
        shortWeekdayNames: strs(['', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']),
        tinyWeekdayNames: strs(['', 'S', 'M', 'T', 'W', 'T', 'F', 'S']),
        longStandAloneWeekdayNames: strs(['', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']),
        shortStandAloneWeekdayNames: strs(['', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']),
        tinyStandAloneWeekdayNames: strs(['', 'S', 'M', 'T', 'W', 'T', 'F', 'S']),
        yesterday: 'Yesterday', today: 'Today', tomorrow: 'Tomorrow',
        fullTimeFormat: 'h:mm:ss a zzzz', longTimeFormat: 'h:mm:ss a z', mediumTimeFormat: 'h:mm:ss a', shortTimeFormat: 'h:mm a',
        fullDateFormat: 'EEEE, MMMM d, y', longDateFormat: 'MMMM d, y', mediumDateFormat: 'MMM d, y', shortDateFormat: 'M/d/yy',
        shortDateFormat4: 'M/d/yyyy', zeroDigit: 48, decimalSeparator: 46, groupingSeparator: 44, patternSeparator: 59, percent: 37, perMill: 8240,
        monetarySeparator: 46, minusSign: 45, exponentSeparator: 'E', infinity: '∞', NaN: 'NaN', currencySymbol: '$', internationalCurrencySymbol: 'USD',
        numberPattern: '#,##0.###', integerPattern: '#,##0', currencyPattern: '¤#,##0.00;(¤#,##0.00)', percentPattern: '#,##0%',
      })
      return 1
    },
  })
}

const PROPS: Record<string, string> = {
  'ro.build.version.sdk': '19', 'ro.build.version.release': '4.4.4', 'ro.build.id': 'KTU84Q', 'ro.product.model': 'Droid',
  'ro.product.manufacturer': 'Danen', 'ro.product.brand': 'droid', 'ro.product.device': 'droid', 'ro.hardware': 'droid',
  'ro.sf.lcd_density': '320', 'ro.config.low_ram': 'false', 'ro.debuggable': '0', 'ro.secure': '1',
}
