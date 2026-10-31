// Pokemon sprites, downloaded from Showdown's sprite server the first time they're needed
// and cached on the SD card. Nothing is bundled with the app.
#pragma once
#include <citro2d.h>
#include <stdbool.h>

void sprites_init(const char *cache_dir);
void sprites_exit(void);
// path like "gen5/garchomp" or "gen5-back-shiny/pikachu". Returns NULL while loading;
// *missing is set when the server has no such sprite (or there's no connection).
const C2D_Image *sprite_get(const char *path, bool *missing);
// Main thread, once per frame: turns decoded downloads into GPU textures.
void sprites_update(void);
