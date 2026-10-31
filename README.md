# Showdown 3DS

An unofficial [Pokémon Showdown](https://pokemonshowdown.com) client for the Nintendo 3DS / 2DS.

- **Play online** against real players on the main Showdown server: ladder search or
  challenges by name.
- **Play vs COM** fully offline. Showdown's own battle engine runs on the console, so the
  damage, abilities and items are identical to the website's.
- Formats: **[Gen 9] Random Battle, OU, Ubers, UU, RU, NU, PU**.
- **Teambuilder** on the console (Teams in the menu), import from **pokepast.es** links, or
  Showdown export files on the SD card.
- In battle: type-effectiveness hints on moves, team overview dots, item/ability/moves of the
  highlighted party member, the battle timer, reconnecting after a dropped connection or sleep.
- COM difficulty (Easy / Normal / Hard), original synthesized sound effects, and a Settings
  screen (animations, sprite style, COM, sound, server, clear caches).
- Showdown's current animated sprites everywhere (battle, party, team preview), falling back to
  its gen5 animations and then still sprites. Battle animations (lunges, type-coloured hits, HP
  draining, fainting, switching, stat changes) play while the log fills in instantly; Skip jumps ahead.
- Log in with your Showdown account (password over HTTPS), chat in battles and send private
  messages. The console stays logged in until you choose **Account → Log out**.

Not affiliated with Nintendo, Game Freak, The Pokémon Company or Smogon. The app ships no
Pokémon artwork. The first time it needs a sprite, it downloads it from Showdown's sprite
server (`play.pokemonshowdown.com/sprites/gen5…`), the same place the website loads it from,
and caches it on the SD card.

## Install

Either way works; the console needs Wi-Fi for online play and for downloading sprites, while
COM battles work without it.

- **HOME Menu icon (CIA):** copy `showdown3ds.cia` to the SD card, open FBI, choose
  *SD → the file → Install CIA*. Showdown 3DS then appears on the HOME Menu with its own banner.
  Uninstall it from FBI's *Titles* list (title ID `000400000F5D3D00`).
- **Homebrew Launcher (3DSX):** copy `showdown3ds.3dsx` to `sdmc:/3ds/` and start it from the
  Homebrew Launcher.

The app keeps its files in `sdmc:/3ds/showdown3ds/`:

| Path | What |
|---|---|
| `config.txt` | your name (`name=`) and, optionally, `server=host:port` |
| `teams/*.txt` | your teams (see below) |
| `sprites/` | downloaded sprite cache (safe to delete) |
| `log.txt` | log of the last session, useful for bug reports |

## Teams for OU and Ubers

In the Showdown website's teambuilder, open a team, choose **Import/Export**, and save the
text as a `.txt` file in `sdmc:/3ds/showdown3ds/teams/`. A file can also hold several teams
in Showdown's backup format (`=== [gen9ou] Team name ===` headers). Teams with a format
header only appear for that format.

No team? Pick **Rental team**: a ready-made competitive team built from Showdown's Battle
Factory sets for that tier. The COM always uses rental teams.

## Controls

- D-pad + **A**, or tap: choose. **B**: back.
- In battle, **A** or a tap moves the battle text along.
- **Tera** toggles Terastallization for your next move. **Switch** opens your party.

## Online notes

- The app connects to `sim3.psim.us:8000` over plain websockets, the same server as the website.
- Unregistered names can battle, but Showdown only lets **registered** accounts chat, send private
  messages, and (on some internet providers) send challenges. Log in under **Account → Log in
  with password**.
- The password is sent only over HTTPS to `play.pokemonshowdown.com`, with the certificate checked
  against Mozilla's root list (`certs/cacert.pem`), and it is never saved. What is saved in
  `config.txt` is Showdown's session cookie (`sid=`), so treat that file like a logged-in browser:
  anyone with it can use your account until you log out.
- Teams are checked by the server. If it rejects a rental team, the app rolls a new one
  (up to three times). If it rejects one of your teams, the reason is shown on screen.

## Build

Needs devkitPro (`3ds-dev`: libctru, citro2d, citro3d), Node.js 22+, Python 3 with Pillow
(icon only) and MSYS2 on Windows.

```bash
bash tools/fetch-vendor.sh   # pinned Showdown, QuickJS-ng and stb_image sources
C:/msys64/usr/bin/bash.exe -l build.sh
```

`build.sh` builds Showdown's compiled engine, copies only what the three formats need
(about 3 MB) into `romfs/ps`, writes a small lookup file (`romfs/data/client.json`), copies
`js/` into romfs, and runs `make`. It then builds the CIA: it compiles bannertool once
(`tools/bin/`), packs `cia/banner.png` + `cia/banner.wav` and the icon, and runs makerom with
`cia/showdown3ds.rsf` (SD-card file access only, 1 MB stack). Set `MAKEROM=` if makerom isn't
at `../3ds-cfw/tools/makerom/makerom.exe`. `python tools/make_icon.py` regenerates the
icon, banner and banner chime (all original art).

## How it works

| Part | Where |
|---|---|
| App logic: screens, online protocol, COM battles, team loading | `js/app.js` |
| Battle protocol → state + one message per event | `js/tracker.js` |
| COM opponent (damage estimate, status/setup/recovery rules, switching) | `js/ai.js` |
| CommonJS loader that runs Showdown's compiled `dist/` in QuickJS | `js/require.js` |
| QuickJS host and view accessors | `source/js.c` |
| Websocket + HTTP over plain TCP (3DS and PC) | `source/net.c` |
| Sprite download, SD cache and textures | `source/sprites.c` |
| Drawing and input | `source/ui.c`, `source/main.c` |

The C side draws `app.view` and runs the commands the app queues (websocket, HTTP,
keyboard). Everything else is JavaScript, so the same code runs in node for the tests.

## Testing

```bash
bash tests/run_all.sh          # COM battles in node and through the C glue
```

The online tests need a local Showdown server (`vendor/pokemon-showdown`) with
`exports.noguestsecurity = true` and `exports.noipchecks = true` in `config/config.js`,
started with `node pokemon-showdown start 8001`. With that running, `run_all.sh` also:

- logs two clients in, sends a challenge in OU (rental vs. imported team), plays it out,
  then plays a Random Battle found through ladder search;
- plays a battle between the C client (`host/host_main.c`, which uses the 3DS app's own
  `js.c` and `net.c`) and a node bot.

Measured on a PC: the engine plus a battle uses about 14 MB of JavaScript memory. That's
64-bit; expect less on the 3DS's 32-bit CPU. The Old 3DS/2DS CPU is far slower than a PC,
so loading the engine for a COM battle takes several seconds there.

## Status

Built and tested on a PC as described above. **Not yet run on real hardware.** The drawing,
touch and keyboard code, sprite textures and the 3DS network stack only run on a console.
