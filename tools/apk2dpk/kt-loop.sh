#!/bin/sh
# rebuild the runtime and rerun the kotlin flow, print the first runtime problem
cd "$(dirname "$0")/../.."
npx vite build -c vite.android.config.ts >/dev/null 2>&1 && cp public/runtime/android-runtime.js dist/runtime/
L=/tmp/claude-0/-home-user-droid/c6f23d82-1f7c-556b-a34a-7f2d25328f99/scratchpad/kt.log
FLOW=./flow-kt.mjs NODE_PATH=$(npm root -g) timeout 120 node tools/screens/flow.mjs /tmp/claude-0/-home-user-droid/c6f23d82-1f7c-556b-a34a-7f2d25328f99/scratchpad/kt > $L 2>&1
grep -E "console:|^shot" $L | head -3 | cut -c1-400
