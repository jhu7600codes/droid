#!/bin/sh
# builds diff.c for the host (expected output) and for arm / thumb at -O0 and -O2
set -e
cd "$(dirname "$0")"
clang -DHOST -O1 -ffp-contract=off -o /tmp/diff-host diff.c -lm && /tmp/diff-host > diff-expected.txt
for mode in arm thumb; do for o in 0 2; do
  clang --target=armv7a-linux-androideabi19 -m$mode -mfpu=neon -mfloat-abi=softfp -O$o -ffp-contract=off -fPIC -shared -nostdlib -fuse-ld=lld -ffreestanding -Wl,-soname,libdiff.so -o libdiff-$mode-O$o.so diff.c
done; done
ls -la libdiff-*.so
