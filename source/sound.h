// Short sound effects, synthesized at start-up (no audio files). Silent if the console has no
// DSP firmware dump (sdmc:/3ds/dspfirm.cdc).
#pragma once
#include <stdbool.h>

bool sound_init(void);
void sound_exit(void);
// name: "select", "move", "hit", "faint", "switch", "heal", "boost", "drop", "status".
void sound_play(const char *name);
// Plays the named music track ("lobby", "rival", "legend"), or stops with "" (the Music setting).
void sound_music(const char *track);
