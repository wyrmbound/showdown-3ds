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
# v0.15.1: the newest release before the arena allocator (v0.16+), which runs out of memory at
# once on the 3DS's 32-bit CPU as soon as the battle engine allocates a typed array.
fetch quickjs https://github.com/quickjs-ng/quickjs.git fd0a0210b7be00957751871e7e01b8291268fc29
fetch mbedtls https://github.com/Mbed-TLS/mbedtls.git 107ea89daaefb9867ea9121002fbbdf926780e98 # v3.6.2, HTTPS login
fetch bannertool https://github.com/diasurgical/bannertool.git 16d8c5a0ce02a5e06e64ab42275132fca57c04a2 # for the CIA banner
curl -sSfL -o vendor/stb/stb_image.h https://raw.githubusercontent.com/nothings/stb/003501f6d7a8/stb_image.h
# stb bug: the "two frames back" pointer for GIF disposal 3 points before the buffer and crashes
# on Showdown's front-view animations.
sed -i 's/two_back = out - 2 * stride;/two_back = out + (layers - 2) * stride;/' vendor/stb/stb_image.h
grep -q "two_back = out + (layers - 2) * stride;" vendor/stb/stb_image.h
# stb bug: GIF disposal 3 ("restore previous") restores from two frames back, so runs of such
# frames pile up on each other. g->background already holds the canvas from before the previous
# frame, which is what disposal 2's branch restores, so send disposal 3 there.
sed -i 's/      if ((dispose == 3) \&\& (two_back == 0)) {/      if (dispose == 3) {/' vendor/stb/stb_image.h
grep -q "      if (dispose == 3) {\$" vendor/stb/stb_image.h
# stb paints a GIF's (opaque) background colour into pixels the first frame doesn't draw;
# browsers keep them transparent, and Showdown's sprites expect that.
sed -i 's|            if (first_frame \&\& (g->bgindex > 0)) {|            if (0 \&\& first_frame \&\& (g->bgindex > 0)) { // patched: keep undrawn pixels transparent, like browsers|' vendor/stb/stb_image.h
grep -q "if (0 && first_frame" vendor/stb/stb_image.h
echo "vendor/ ready"
