#!/bin/sh
# local only: rebuild the android runtime, rerun the big-apk flow (dist/apk-test/ss.apk), print the first problems
cd "$(dirname "$0")/../.."
[ "$1" = full ] && npm run build >/dev/null 2>&1
npx vite build -c vite.android.config.ts >/dev/null 2>&1 && cp public/runtime/android-runtime.js dist/runtime/
mkdir -p dist/apk-test && cp tools/apk2dpk/test.apk tools/apk2dpk/test-kt.apk dist/apk-test/ 2>/dev/null
[ -f dist/apk-test/ss.apk ] || cp /tmp/claude-0/-home-user-droid/c6f23d82-1f7c-556b-a34a-7f2d25328f99/scratchpad/ss/ss.apk dist/apk-test/ss.apk
L=/tmp/claude-0/-home-user-droid/c6f23d82-1f7c-556b-a34a-7f2d25328f99/scratchpad/ss.log
FLOW=./flow-ss.mjs timeout 300 node tools/screens/flow.mjs /tmp/claude-0/-home-user-droid/c6f23d82-1f7c-556b-a34a-7f2d25328f99/scratchpad/ss 360 640 1 > $L 2>&1
grep -E "console:|overlay:|pageerror" $L | grep -v "^\s*at " | head -${2:-8} | cut -c1-600
