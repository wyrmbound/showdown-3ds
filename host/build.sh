#!/bin/bash
# Builds the PC test harness (build-host/host_main.exe) with MSYS2 clang.
set -e
cd "$(dirname "$0")/.."
export PATH=/c/msys64/clangarm64/bin:/c/msys64/usr/bin:$PATH
mkdir -p build-host/obj
Q=vendor/quickjs
for f in quickjs libregexp libunicode dtoa; do
  [ build-host/obj/$f.o -nt $Q/$f.c ] || clang -O2 -w -c $Q/$f.c -o build-host/obj/$f.o
done
M=vendor/mbedtls
TLSDEF='-DMBEDTLS_USER_CONFIG_FILE="tls_config.h"'
mkdir -p build-host/mbedtls
for f in $M/library/*.c; do
  o=build-host/mbedtls/$(basename $f .c).o
  [ $o -nt $f ] && [ $o -nt source/tls_config.h ] || clang -O2 -w "$TLSDEF" -Isource -I$M/include -c $f -o $o
done
clang -O1 -g -Wall -I$Q -Isource -I$M/include "$TLSDEF" -o build-host/host_main.exe host/host_main.c source/js.c source/net.c source/tls.c   build-host/obj/*.o build-host/mbedtls/*.o -lws2_32 -lbcrypt -lm
echo built build-host/host_main.exe
