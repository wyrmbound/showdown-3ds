#!/bin/bash
# Runs every host-side test. The online tests need a local Showdown server with
# noguestsecurity and noipchecks on (see README, "Testing").
set -e
cd "$(dirname "$0")/.."
SERVER=${1:-localhost:8001}
node tests/teambuilder-node.js
bash host/build.sh
if node -e "fetch('http://$SERVER').then(()=>process.exit(0),()=>process.exit(1))"; then
  node tests/online-node.js "$SERVER"
  (node tests/online-node.js "$SERVER" --bot &)
  sleep 1
  ./build-host/host_main.exe online "$SERVER" "C Host $RANDOM" | tail -1 # unique name: the server rejoins old battles by name
else
  echo "(skipping online tests: no server at $SERVER)"
fi

# Sprite sheet builder (sprites.c) on real Showdown sprites, if the sprite server is reachable.
mkdir -p build/gifs
for s in gen5ani/garchomp gen5ani-back/garchomp gen5ani/greattusk gen5/garchomp; do
  ext=gif; [ "${s#gen5ani}" = "$s" ] && ext=png
  curl -sfA showdown-3ds -o "build/gifs/$(echo $s | tr / _).$ext" "http://play.pokemonshowdown.com/sprites/$s.$ext" || true
done
if ls build/gifs/*.* >/dev/null 2>&1; then
  (cd host && /c/msys64/clangarm64/bin/clang -O1 -w -Ifake3ds -I../source -I../vendor/stb -I../vendor/quickjs -o ../build-host/sprites_test.exe sprites_test.c)
  ./build-host/sprites_test.exe build/gifs/*.*
fi
