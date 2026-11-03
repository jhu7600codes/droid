#!/bin/sh
# builds tools/apk2dpk/testapp into test.apk with google's d8 / aapt2 and android.jar (api 16 stubs).
# those tools are only used here, to make a test input; nothing from them ships in droid.
# needs: java, javac, clang + ld.lld, and the tools in .cache (see README.md)
set -e
export JAVA_TOOL_OPTIONS="$JAVA_TOOL_OPTIONS"
cd "$(dirname "$0")"
C=.cache
OUT=$C/build
rm -rf $OUT && mkdir -p $OUT/res $OUT/gen $OUT/classes $OUT/lib/armeabi-v7a
$C/aapt2 compile --dir testapp/res -o $OUT/res.zip
$C/aapt2 link -o $OUT/base.apk -I $C/android.jar --manifest testapp/AndroidManifest.xml --java $OUT/gen $OUT/res.zip --min-sdk-version 9 --target-sdk-version 19
javac -nowarn --release 8 -classpath $C/android.jar -d $OUT/classes $(find testapp/src $OUT/gen -name '*.java') 2>&1 | grep -v "warning" || true
java -cp $C/r8.jar com.android.tools.r8.D8 --min-api 19 --lib $C/android.jar --output $OUT $(find $OUT/classes -name '*.class') 2>&1 | grep -v JAVA_TOOL || true
# arm mode for now; thumb-2 comes with the next runtime step
clang --target=armv7a-linux-androideabi19 -marm -O1 -fPIC -shared -nostdlib -fuse-ld=lld -fno-builtin -Wl,-soname,libhello.so -o $OUT/lib/armeabi-v7a/libhello.so testapp/jni/hello.c
cp $OUT/base.apk test.apk
(cd $OUT && zip -q ../../test.apk classes.dex lib/armeabi-v7a/libhello.so)
ls -la test.apk && unzip -l test.apk
