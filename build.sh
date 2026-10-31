#!/bin/bash
# Builds showdown3ds.3dsx (Homebrew Launcher) and showdown3ds.cia (install with FBI).
# Run from PowerShell:  C:\msys64\usr\bin\bash.exe -l /c/Users/Graciela/Downloads/showdown-3ds/build.sh
# Needs: devkitPro 3ds-dev (libctru, citro2d), Node.js 22+, and vendor/ (tools/fetch-vendor.sh).
set -e
cd "$(dirname "$0")"
export DEVKITPRO=/opt/devkitpro DEVKITARM=/opt/devkitpro/devkitARM
export PATH="$DEVKITARM/bin:$DEVKITPRO/tools/bin:/c/Program Files/nodejs:/clangarm64/bin:/c/Users/Graciela/AppData/Local/Programs/Python/Python312-arm64:$PATH"
PS=vendor/pokemon-showdown

[ -d $PS/dist ] || (cd $PS && npm ci --omit=optional --no-audit --no-fund && node build)
node tools/stage-sim.js $PS romfs/ps
node tools/make-client-data.js $PS romfs/data/client.json
node tools/make-tb-data.js $PS romfs/data/tb.json
rm -rf romfs/js && mkdir -p romfs/js && cp js/*.js romfs/js/
cp certs/cacert.pem romfs/data/cacert.pem # Mozilla root CAs (MPL-2.0) for HTTPS login

# Mbed TLS for the console, built once into build/mbedtls-3ds (rebuilt when tls_config.h changes).
MB=build/mbedtls-3ds
if [ ! "$MB/lib/libmbedtls3ds.a" -nt source/tls_config.h ]; then
  mkdir -p $MB/obj $MB/lib
  for f in vendor/mbedtls/library/*.c; do
    arm-none-eabi-gcc -march=armv6k -mtune=mpcore -mfloat-abi=hard -mtp=soft -O2 -ffunction-sections -w       -D__3DS__ '-DMBEDTLS_USER_CONFIG_FILE="tls_config.h"' -Isource -Ivendor/mbedtls/include       -I$DEVKITPRO/libctru/include -c $f -o $MB/obj/$(basename $f .c).o
  done
  rm -f $MB/lib/libmbedtls3ds.a && arm-none-eabi-ar rcs $MB/lib/libmbedtls3ds.a $MB/obj/*.o
fi
rm -f showdown3ds.3dsx # romfs changes alone don't make it rebuild
make -j"$(nproc)"

echo "built showdown3ds.3dsx"

# CIA: bannertool (vendor/bannertool, built here once) packs the banner and icon, makerom the CIA.
BT=tools/bin/bannertool.exe
MAKEROM=${MAKEROM:-../3ds-cfw/tools/makerom/makerom.exe}
if [ ! -x $BT ]; then
  B=vendor/bannertool/source
  mkdir -p tools/bin build/bt
  for f in $B/pc/*.c; do clang -O2 -w -c $f -o build/bt/$(basename $f).o; done
  clang++ -O2 -w -std=gnu++11 -I$B -DVERSION_MAJOR=1 -DVERSION_MINOR=2 -DVERSION_MICRO=0 -static     -o $BT $B/*.cpp $B/3ds/*.cpp $B/pc/*.cpp build/bt/*.o
fi
$BT makebanner -i cia/banner.png -a cia/banner.wav -o build/banner.bnr > /dev/null
$BT makesmdh -s "Showdown 3DS" -l "Showdown 3DS - Unofficial Pokemon Showdown client" -p wyrmbound -i icon.png -o build/icon.icn > /dev/null
"$MAKEROM" -f cia -o showdown3ds.cia -elf showdown3ds.elf -rsf cia/showdown3ds.rsf -target t -exefslogo   -icon build/icon.icn -banner build/banner.bnr -major 0 -minor 1 -micro 0   -DAPP_TITLE="Showdown 3DS" -DAPP_PRODUCT_CODE=CTR-H-SD3D -DAPP_UNIQUE_ID=0xF5D3D -DAPP_CATEGORY=Application   -DAPP_ROMFS=romfs -DAPP_ENCRYPTED=false -DAPP_USE_ON_SD=true -DAPP_MEMORY_TYPE=Application   -DAPP_SYSTEM_MODE=64MB -DAPP_SYSTEM_MODE_EXT=Legacy -DAPP_CPU_SPEED=804MHz -DAPP_ENABLE_L2_CACHE=true   -DAPP_VERSION_MAJOR=0
python tools/fix_cia_romfs.py showdown3ds.cia # makerom v0.19.0 writes the wrong RomFS block size
echo "built showdown3ds.cia"
