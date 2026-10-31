#!/bin/bash
# Downloads the pinned third-party sources into vendor/ (not checked in).
set -e
cd "$(dirname "$0")/.."
mkdir -p vendor/stb
fetch() { # dir url commit
  [ -d "vendor/$1/.git" ] || git clone -q "$2" "vendor/$1"
  git -C "vendor/$1" fetch -q --depth 1 origin "$3" && git -C "vendor/$1" checkout -q "$3"
}
fetch pokemon-showdown https://github.com/smogon/pokemon-showdown.git 2e0a951377bbd3f7193a4300656b010609351beb
fetch quickjs https://github.com/quickjs-ng/quickjs.git fd0a0210b7be00957751871e7e01b8291268fc29 # v0.15.1 release
fetch mbedtls https://github.com/Mbed-TLS/mbedtls.git 107ea89daaefb9867ea9121002fbbdf926780e98 # v3.6.2, HTTPS login
fetch bannertool https://github.com/diasurgical/bannertool.git 16d8c5a0ce02a5e06e64ab42275132fca57c04a2 # for the CIA banner
curl -sSfL -o vendor/stb/stb_image.h https://raw.githubusercontent.com/nothings/stb/003501f6d7a8/stb_image.h
python tools/patch-stb.py vendor/stb/stb_image.h # GIF frame fixes, see the script
echo "vendor/ ready"
