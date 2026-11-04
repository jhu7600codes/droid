#!/bin/sh
# detail.sh <category> <arm|thumb> <O0|O2>: every value of one category, host vs emulator, first differences
cd "$(dirname "$0")"
sed "s/^  ints(); longs(); doubles(); floats(); control(); dsp(); vector(); physics();/  $1();/" diff.c > /tmp/diff-one.c
clang -DHOST -DDETAIL -DN=${N:-60} -O1 -ffp-contract=off -o /tmp/diff-one /tmp/diff-one.c -lm 2>/dev/null && /tmp/diff-one > /tmp/want.txt
clang --target=armv7a-linux-androideabi19 -m$2 -mfpu=neon -mfloat-abi=softfp -$3 -DDETAIL -DN=${N:-60} -ffp-contract=off -fPIC -shared -nostdlib -fuse-ld=lld -ffreestanding -o /tmp/libone.so /tmp/diff-one.c 2>/dev/null
node run-detail.mjs /tmp/libone.so /tmp/want.txt
