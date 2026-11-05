# minimal aidl -> java: interfaces with a Stub (no real binder transport; droid runs in one process)
import os, re, sys
roots = sys.argv[1:-1]; out = sys.argv[-1]
for root in roots:
    for dp, _, fs in os.walk(root):
        for f in fs:
            if not f.endswith('.aidl'): continue
            s = open(os.path.join(dp, f), encoding='utf-8', errors='replace').read()
            s = re.sub(r'/\*.*?\*/', '', s, flags=re.S); s = re.sub(r'//[^\n]*', '', s)
            pkg = re.search(r'package\s+([\w.]+)\s*;', s)
            m = re.search(r'(oneway\s+)?interface\s+(\w+)\s*\{(.*)\}', s, re.S)
            if not pkg or not m: continue
            pkg = pkg.group(1); name = m.group(2); body = m.group(3)
            imports = re.findall(r'import\s+([\w.]+)\s*;', s) + ['java.util.List', 'java.util.Map', 'android.os.IBinder']
            methods = []
            for decl in body.split(';'):
                decl = ' '.join(decl.split())
                if not decl or '(' not in decl: continue
                decl = re.sub(r'\boneway\s+', '', decl)
                decl = re.sub(r'=\s*\d+\s*$', '', decl).strip()
                head, args = decl.split('(', 1); args = args.rsplit(')', 1)[0]
                args = re.sub(r'\b(in|out|inout)\s+', '', args)
                methods.append(f'    public {head.strip()}({args}) throws android.os.RemoteException;')
            fq = pkg + '.' + name
            path = os.path.join(out, *pkg.split('.'), name + '.java')
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, 'w').write(f"""package {pkg};
{''.join(f'import {i};' + chr(10) for i in imports)}
public interface {name} extends android.os.IInterface {{
  public static abstract class Stub extends android.os.Binder implements {name} {{
    private static final String DESCRIPTOR = "{fq}";
    public Stub() {{ this.attachInterface(this, DESCRIPTOR); }}
    public static {name} asInterface(android.os.IBinder obj) {{
      if (obj == null) return null;
      android.os.IInterface i = obj.queryLocalInterface(DESCRIPTOR);
      return i instanceof {name} ? ({name}) i : null;
    }}
    @Override public android.os.IBinder asBinder() {{ return this; }}
  }}
{chr(10).join(methods)}
}}
""")
