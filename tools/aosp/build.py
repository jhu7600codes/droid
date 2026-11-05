#!/usr/bin/env python3
# builds the real android 4.4 framework for droid's android runtime, from aosp source (apache 2.0):
#   framework.dex      android.view / widget / graphics / text / app ... compiled with javac + d8
#   framework-res.apk  android's own resources (holo themes, styles, layouts, drawables), aapt2
# java.* stays droid's own (the runtime's js shims); the framework's natives are written in the
# runtime (canvas, paint, assets ...). droid's replacements for system-side classes live in
# overlay/ (they win over the aosp file of the same name); small source fixes are in patches.py.
#
# usage: python3 tools/aosp/build.py [--out dist/runtime/aosp] [--skip-res]
# sources are cached in tools/aosp/.cache (never in git). no google branding is shipped: branded
# drawables are replaced by a blank image (the same names as tools/import-aosp excludes).
import os, re, sys, shutil, subprocess, tarfile, urllib.request, zipfile, glob

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '../..'))
CACHE = os.path.join(HERE, '.cache')
TOOLS = os.path.join(CACHE, 'tools')
R8_URL = 'https://dl.google.com/android/maven2/com/android/tools/r8/8.5.35/r8-8.5.35.jar'
AAPT2_URL = 'https://dl.google.com/android/maven2/com/android/tools/build/aapt2/8.5.0-11315950/aapt2-8.5.0-11315950-linux.jar'
OUT = os.path.join(ROOT, sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else 'dist/runtime/aosp')
TAG = 'refs/tags/android-4.4.4_r2'
G = 'https://android.googlesource.com/platform'
SOURCES = [  # (repo, path in repo, where it goes)
    ('frameworks/base', 'core/java', 'src'), ('frameworks/base', 'graphics/java', 'src'),
    ('frameworks/base', 'media/java', 'src'), ('frameworks/base', 'telephony/java', 'src'),
    ('frameworks/base', 'location/java', 'src'), ('frameworks/base', 'opengl/java', 'src'),
    ('frameworks/base', 'wifi/java', 'src'), ('frameworks/base', 'core/res', 'res'),
    ('external/apache-http', 'src', 'src'), ('external/tagsoup', 'src', 'src'), ('external/libphonenumber', 'java/src', 'src'),
    ('libcore', 'luni/src/main/java', 'libcore'), ('libcore', 'dalvik/src/main/java', 'libcore'),
    ('libcore', 'xml/src/main/java', 'libcore'),
]
# from libcore only these packages: java.* / javax.* are droid's own
LIBCORE_KEEP = ['libcore', 'dalvik', 'org/apache/harmony', 'org/xmlpull', 'org/kxml2', 'org/xml/sax']
EXCLUDE = [r'^sym_def_app_icon', r'android_logo', r'^ic_launcher_android', r'robot', r'google', r'market', r'you_?tube', r'platlogo', r'_android(\.|_|$)']
# what the framework build starts from; javac pulls in everything they reach
SEEDS = ['android/view/View', 'android/view/ViewGroup', 'android/view/LayoutInflater', 'android/view/WindowManagerGlobal',
         'android/widget/TextView', 'android/widget/LinearLayout', 'android/widget/FrameLayout', 'android/widget/RelativeLayout',
         'android/widget/ListView', 'android/widget/GridView', 'android/widget/ImageView', 'android/widget/Button', 'android/widget/EditText',
         'android/widget/ScrollView', 'android/widget/HorizontalScrollView', 'android/widget/Spinner', 'android/widget/TabHost',
         'android/widget/SeekBar', 'android/widget/CheckBox', 'android/widget/RadioGroup', 'android/widget/ToggleButton', 'android/widget/Switch',
         'android/widget/ProgressBar', 'android/widget/AutoCompleteTextView', 'android/widget/ViewFlipper', 'android/widget/TableLayout',
         'android/widget/Toast', 'android/widget/PopupWindow', 'android/widget/ArrayAdapter', 'android/widget/SimpleAdapter',
         'android/app/Activity', 'android/app/Dialog', 'android/app/AlertDialog', 'android/app/ProgressDialog', 'android/app/FragmentManager',
         'android/app/LoaderManager', 'android/app/ListActivity', 'android/app/TabActivity', 'android/preference/PreferenceActivity',
         'android/webkit/WebView', 'android/widget/VideoView']

def sh(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    return r.returncode, (r.stdout + r.stderr).replace('Picked up JAVA_TOOL_OPTIONS', '')

def fetch():
    os.makedirs(CACHE, exist_ok=True)
    # google's build tools (d8, aapt2): only used here, nothing from them ships
    os.makedirs(TOOLS, exist_ok=True)
    if not os.path.exists(os.path.join(TOOLS, 'r8.jar')): urllib.request.urlretrieve(R8_URL, os.path.join(TOOLS, 'r8.jar'))
    if not os.path.exists(os.path.join(TOOLS, 'aapt2')):
        jar = os.path.join(TOOLS, 'aapt2.jar'); urllib.request.urlretrieve(AAPT2_URL, jar)
        with zipfile.ZipFile(jar) as z: z.extract('aapt2', TOOLS)
        os.chmod(os.path.join(TOOLS, 'aapt2'), 0o755)
    for repo, path, dest in SOURCES:
        tgz = os.path.join(CACHE, (repo + '_' + path).replace('/', '_') + '.tgz')
        if not os.path.exists(tgz):
            print('fetch', repo, path)
            urllib.request.urlretrieve(f'{G}/{repo}/+archive/{TAG}/{path}.tar.gz', tgz)
        d = os.path.join(CACHE, dest)
        marker = os.path.join(d, '.got-' + os.path.basename(tgz))
        if os.path.exists(marker): continue
        os.makedirs(d, exist_ok=True)
        if dest == 'libcore':
            tmp = os.path.join(CACHE, 'tmp'); shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
            with tarfile.open(tgz) as t: t.extractall(tmp, filter='data')
            for p in LIBCORE_KEEP:
                if os.path.isdir(os.path.join(tmp, p)): shutil.copytree(os.path.join(tmp, p), os.path.join(d, p), dirs_exist_ok=True)
            shutil.rmtree(tmp)
        else:
            with tarfile.open(tgz) as t: t.extractall(d, filter='data')
        open(marker, 'w').close()

def _png1x1():
    import struct, zlib
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\x00\x00\x00\x00')) + chunk(b'IEND', b'')
BLANK_PNG = _png1x1()

def resources():
    src = os.path.join(CACHE, 'res/res'); dst = os.path.join(CACHE, 'fres')
    shutil.rmtree(dst, ignore_errors=True); os.makedirs(dst)
    for d in ['values', 'color', 'anim', 'animator', 'interpolator', 'layout', 'menu', 'xml', 'drawable', 'drawable-nodpi', 'raw', 'transition', 'mipmap-xhdpi']:
        if os.path.isdir(f'{src}/{d}'): shutil.copytree(f'{src}/{d}', f'{dst}/{d}')
    # layouts that only exist for other screens (tablets ...): the default folder gets them too
    for d in sorted(os.listdir(src)):
        if d.startswith('layout-'):
            for f in os.listdir(f'{src}/{d}'):
                if not os.path.exists(f'{dst}/layout/{f}'): shutil.copy(f'{src}/{d}/{f}', f'{dst}/layout/{f}')
    # ids made only in those other layouts still have to exist
    ids = set()
    for d in os.listdir(src):
        if d.startswith('layout'):
            for f in os.listdir(f'{src}/{d}'): ids |= set(re.findall(r'@\+(?:android:)?id/(\w+)', open(f'{src}/{d}/{f}', errors='replace').read()))
    ids |= set(re.findall(r'<java-symbol type="id" name="(\w+)"', open(f'{src}/values/symbols.xml').read()))
    open(f'{dst}/values/droid_ids.xml', 'w').write('<resources>\n' + ''.join(f'  <item type="id" name="{i}"/>\n' for i in sorted(ids)) + '</resources>\n')
    # one density per drawable: the sharpest there is
    seen = set()
    for d in ['drawable', 'drawable-nodpi']:
        seen |= {f.split('.')[0] for f in os.listdir(f'{src}/{d}')}
    for d in ['drawable-xhdpi', 'drawable-hdpi', 'drawable-mdpi', 'drawable-xxhdpi', 'drawable-ldpi']:
        for f in sorted(os.listdir(f'{src}/{d}')):
            n = f.split('.')[0]
            if n in seen: continue
            seen.add(n); os.makedirs(f'{dst}/{d}', exist_ok=True); shutil.copy(f'{src}/{d}/{f}', f'{dst}/{d}/{f}')
    # strings for other languages and the system-only symbol list are not needed
    os.remove(f'{dst}/values/symbols.xml')
    s = open(f'{dst}/values/styles.xml').read().replace('parent="@android:attr/textAppearanceMedium"', 'parent="@android:style/TextAppearance.Medium"')
    open(f'{dst}/values/styles.xml', 'w').write(s)
    # no branding: those images become blank (the names stay, code refers to them)
    for p in glob.glob(f'{dst}/*/*.png'):
        n = os.path.basename(p).split('.')[0]
        if any(re.search(x, n, re.I) for x in EXCLUDE):
            open(p.replace('.9.png', '.png') if p.endswith('.9.png') else p, 'wb').write(BLANK_PNG)
            if p.endswith('.9.png'): os.remove(p)
    aapt2 = os.path.join(TOOLS, 'aapt2')
    flat = os.path.join(CACHE, 'flat.zip'); gen = os.path.join(CACHE, 'gen')
    shutil.rmtree(gen, ignore_errors=True); os.makedirs(gen)
    code, out = sh([aapt2, 'compile', '--legacy', '--dir', dst, '-o', flat])
    if code: sys.exit('aapt2 compile failed:\n' + out[-3000:])
    code, out = sh([aapt2, 'link', '--manifest', os.path.join(CACHE, 'res/AndroidManifest.xml'), '--no-auto-version', '--java', gen, '-o', os.path.join(CACHE, 'framework-res.apk'), flat])
    if code: sys.exit('aapt2 link failed:\n' + out[-3000:])
    r = open(f'{gen}/android/R.java').read()
    os.makedirs(f'{gen}/com/android/internal', exist_ok=True)
    open(f'{gen}/com/android/internal/R.java', 'w').write(r.replace('package android;', 'package com.android.internal;', 1))
    m = open(f'{gen}/android/Manifest.java').read()
    open(f'{gen}/android/Manifest.java', 'w').write(m.replace('@android.annotation.Hide', ''))

def generated():
    gen = os.path.join(CACHE, 'gen')
    sh([sys.executable, os.path.join(HERE, 'aidl.py'), os.path.join(CACHE, 'src'), gen])
    # event log tags: just the constants and writeEvent helpers the code calls
    for lt in glob.glob(os.path.join(CACHE, 'src', '**', '*.logtags'), recursive=True):
        txt = open(lt).read()
        pkg = re.search(r'option java_package ([\w.]+)', txt)
        if not pkg: continue
        consts, writers = [], []
        for line in txt.splitlines():
            m = re.match(r'^(\d+)\s+(\w+)(.*)$', line.strip())
            if not m: continue
            num, name, rest = m.groups()
            cname = name.upper()
            consts.append(f'  public static final int {cname} = {num};')
            fields = re.findall(r'\((\w+)\|(\d)', rest)
            jt = {'1': 'int', '2': 'long', '3': 'String', '4': 'Object[]', '5': 'float'}
            params = ', '.join(f'{jt.get(t, "Object")} {n}' for n, t in fields)
            camel = re.sub(r'_(\w)', lambda x: x.group(1).upper(), name)
            writers.append(f'  public static void write{camel[0].upper() + camel[1:]}({params}) {{}}')
        path = os.path.join(gen, *pkg.group(1).split('.'), 'EventLogTags.java')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, 'w').write(f'package {pkg.group(1)};\npublic class EventLogTags {{\n' + '\n'.join(consts + writers) + '\n}\n')

def workcopy():
    # patches and rewrites go into a fresh copy each build, the extracted sources stay pristine
    w = os.path.join(CACHE, 'work'); shutil.rmtree(w, ignore_errors=True)
    for base in ('src', 'libcore'): shutil.copytree(os.path.join(CACHE, base), os.path.join(w, base))

def patch():
    sys.path.insert(0, HERE)
    import patches
    for rel, old, new in patches.PATCHES:
        for base in ('src', 'libcore'):
            p = os.path.join(CACHE, 'work', base, rel)
            if os.path.exists(p): break
        else: sys.exit('patch target missing: ' + rel)
        s = open(p, encoding='utf-8', errors='replace').read()
        if new in s and old not in s: continue
        if old not in s: sys.exit(f'patch does not apply: {rel}: {old[:60]!r}')
        open(p, 'w', encoding='utf-8').write(s.replace(old, new))

# libcore's own additions to java.* and a few vm hooks: rewritten to droid.Compat (overlay/droid)
REWRITES = [
    (r'\bArrays\.checkOffsetAndCount\(', 'droid.Compat.checkOffsetAndCount('),
    (r'\b([\w.]+(?:\(\))?)\.getInt\$\(\)', r'droid.Compat.getInt(\1)'),
    (r'\b([\w.]+(?:\(\))?)\.setInt\$\(', r'droid.Compat.setInt(\1, '),
    (r'\b([\w.]+(?:\(\))?)\.getFileDescriptor\$\(\)', r'droid.Compat.getFileDescriptor(\1)'),
    (r'\bSystem\.log([EWI])\(', r'droid.Compat.log\1('),
    (r'\bInetAddress\.parseNumericAddress\(', 'droid.Compat.parseNumericAddress('),
    (r'\bInetAddress\.clearDnsCache\(\)', 'droid.Compat.noop()'),
    (r'\bIntegralToString\.', 'droid.Compat.'),
    (r'\bByte\.toHexString\(', 'droid.Compat.byteToHexString('),
    (r'\b([\w.]+)\.eldest\(\)', r'droid.Compat.eldest(\1)'),
    (r'@FindBugsSuppressWarnings\([^)]*\)', ''),
    (r'import java\.nio\.NioUtils;', ''),
    (r'\bNioUtils\.', 'droid.Compat.'),
    (r'\bDaemons\.(start|stop)\(\)', 'droid.Compat.noop()'),
    (r'\b(\w+)\.setReceivedLength\(', r'droid.Compat.setReceivedLength(\1, '),
    (r'new InetSocketAddress\(\)', 'new InetSocketAddress(0)'),
    (r'\bInet4Address\.ANY\b', 'droid.Compat.inet4Any()'),
    (r'\bInet6Address\.ANY\b', 'droid.Compat.inet6Any()'),
    (r'new (BindException|ConnectException|SocketException|SocketTimeoutException|PortUnreachableException)\(([^;]+?), (\w+)\)(?=;)', r'droid.Compat.withCause(new \1(\2), \3)'),
    (r'new (SocketException|SocketTimeoutException)\((ex|errnoException|e|cause)\)', r'droid.Compat.withCause(new \1(\2.getMessage()), \2)'),
]
def rewrite():
    rs = [(re.compile(a), b) for a, b in REWRITES]
    for base in ('src', 'libcore'):
        for dp, _, fs in os.walk(os.path.join(CACHE, 'work', base)):
            for f in fs:
                if not f.endswith('.java'): continue
                p = os.path.join(dp, f)
                s = open(p, encoding='utf-8', errors='replace').read()
                t = s
                for r, b in rs: t = r.sub(b, t)
                if t != s: open(p, 'w', encoding='utf-8').write(t)

def compile_java():
    cls = os.path.join(CACHE, 'classes'); shutil.rmtree(cls, ignore_errors=True); os.makedirs(cls)
    W = os.path.join(CACHE, 'work')
    path = ':'.join([os.path.join(HERE, 'overlay'), os.path.join(W, 'src'), os.path.join(W, 'libcore'), os.path.join(CACHE, 'gen')])
    def find(s):
        for b in [os.path.join(HERE, 'overlay'), os.path.join(W, 'src'), os.path.join(W, 'libcore'), os.path.join(CACHE, 'gen')]:
            if os.path.exists(os.path.join(b, s + '.java')): return os.path.join(b, s + '.java')
        sys.exit('seed missing: ' + s)
    seeds = [find(s) for s in SEEDS]
    # overlay files always go in (they replace system-side pieces the seeds may not reach directly)
    seeds += [os.path.join(dp, f) for dp, _, fs in os.walk(os.path.join(HERE, 'overlay')) for f in fs if f.endswith('.java')]
    code, out = sh(['javac', '--release', '8', '-nowarn', '-proc:none', '-implicit:class', '-encoding', 'UTF-8', '-Xmaxerrs', '100000', '-sourcepath', path, '-d', cls, *sorted(set(seeds))])
    open(os.path.join(CACHE, 'javac.log'), 'w').write(out)
    errs = out.count(': error:')
    if code:
        print(out[:6000]); sys.exit(f'javac: {errs} errors (all in tools/aosp/.cache/javac.log)')
    return cls

def dex(cls):
    os.makedirs(OUT, exist_ok=True)
    files = [os.path.join(dp, f) for dp, _, fs in os.walk(cls) for f in fs if f.endswith('.class')]
    tmp = os.path.join(CACHE, 'dex'); shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
    lst = os.path.join(CACHE, 'classes.txt'); open(lst, 'w').write('\n'.join(files))
    code, out = sh(['java', '-cp', os.path.join(TOOLS, 'r8.jar'), 'com.android.tools.r8.D8', '--min-api', '19', '--release', '--lib', os.environ.get('JAVA_HOME') or '/usr/lib/jvm/java-21-openjdk-amd64', '--output', tmp, f'@{lst}'])
    if code: sys.exit('d8 failed:\n' + out[-3000:])
    shutil.copy(os.path.join(tmp, 'classes.dex'), os.path.join(OUT, 'framework.dex'))
    shutil.copy(os.path.join(CACHE, 'framework-res.apk'), os.path.join(OUT, 'framework-res.apk'))
    print('framework.dex', os.path.getsize(os.path.join(OUT, 'framework.dex')), 'bytes,', len(files), 'classes')

if __name__ == '__main__':
    fetch()
    if '--skip-res' not in sys.argv or not os.path.exists(os.path.join(CACHE, 'framework-res.apk')): resources()
    generated()
    workcopy()
    patch()
    rewrite()
    dex(compile_java())
