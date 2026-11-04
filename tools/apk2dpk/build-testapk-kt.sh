#!/bin/sh
# builds testapp-kt (kotlin) into test-kt.apk: kotlinc + r8 (shrinks the kotlin stdlib) + aapt2
set -e
cd "$(dirname "$0")"
C=.cache; OUT=$C/build-kt
rm -rf $OUT && mkdir -p $OUT/gen $OUT/classes
$C/aapt2 compile --dir testapp-kt/res -o $OUT/res.zip
$C/aapt2 link -o $OUT/base.apk -I $C/android.jar --manifest testapp-kt/AndroidManifest.xml --java $OUT/gen $OUT/res.zip --min-sdk-version 14 --target-sdk-version 19
$C/kotlinc/bin/kotlinc -nowarn -jvm-target 1.8 -cp $C/android.jar -d $OUT/app.jar testapp-kt/src $(find $OUT/gen -name '*.java') 2>&1 | grep -v JAVA_TOOL || true
javac -nowarn --release 8 -cp $C/android.jar:$OUT/app.jar -d $OUT/classes $(find $OUT/gen -name '*.java') 2>&1 | grep -v -e JAVA_TOOL -e warning || true
(cd $OUT/classes && jar uf ../app.jar com) 2>/dev/null || true
printf -- '-keep class com.droid.kt.** { *; }\n-dontwarn **\n-dontobfuscate\n-allowaccessmodification\n' > $OUT/rules.pro
java -cp $C/r8.jar com.android.tools.r8.R8 --release --min-api 19 --lib $C/android.jar --lib /usr/lib/jvm/java-21-openjdk-amd64 --pg-conf $OUT/rules.pro --output $OUT $OUT/app.jar $C/kotlinc/lib/kotlin-stdlib.jar 2>&1 | grep -v JAVA_TOOL | tail -3 || true
cp $OUT/base.apk test-kt.apk
(cd $OUT && zip -q ../../test-kt.apk classes.dex)
unzip -l test-kt.apk | tail -n +4
