#!/bin/sh
# bisect.sh <category> <arm|thumb> <O0|O2> <N>: host vs emulator hash of one category over N iterations
cd "$(dirname "$0")"
sed "s/^  ints(); longs(); doubles(); floats(); control(); dsp(); vector(); physics();/  $1();/" diff.c > /tmp/diff-b.c
clang -DHOST -DN=$4 -O1 -ffp-contract=off -o /tmp/diff-b /tmp/diff-b.c -lm 2>/dev/null && /tmp/diff-b > /tmp/want-b.txt
clang --target=armv7a-linux-androideabi19 -m$2 -mfpu=neon -mfloat-abi=softfp -$3 -DN=$4 -ffp-contract=off -fPIC -shared -nostdlib -fuse-ld=lld -ffreestanding -o /tmp/libb.so /tmp/diff-b.c 2>/dev/null
node run-detail.mjs /tmp/libb.so /tmp/want-b.txt
