#include "sound.h"

#include <3ds.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define RATE 22050
#define CHANNELS 4 // a few effects can overlap (a move whoosh, then its hit)

typedef struct {
	const char *name;
	s16 *pcm;
	u32 samples;
} sfx_t;

static sfx_t sfx[9];
static int nsfx, next_chn;
static ndspWaveBuf bufs[CHANNELS];
static bool ready;

static float noise(void) { return (rand() / (float)RAND_MAX) * 2 - 1; }

// Builds one effect: tone sweeps from f0 to f1 Hz with `buzz` noise mixed in, shaped by a quick
// attack and an exponential decay. `notes` > 1 splits it into steps (arpeggios for stat changes).
static void make(const char *name, float ms, float f0, float f1, float buzz, int notes, float vol) {
	u32 n = (u32)(RATE * ms / 1000);
	s16 *pcm = linearAlloc(n * sizeof *pcm);
	if (!pcm) return;
	float phase = 0;
	for (u32 i = 0; i < n; i++) {
		float k = i / (float)n;
		float step = notes > 1 ? floorf(k * notes) / (notes - 1) : k;
		float f = f0 + (f1 - f0) * step;
		phase += 2 * (float)M_PI * f / RATE;
		float local = notes > 1 ? fmodf(k * notes, 1.0f) : k; // each note gets its own envelope
		float env = fminf(1, local * 40) * expf(-4 * local);
		float v = (sinf(phase) * (1 - buzz) + noise() * buzz) * env * vol;
		pcm[i] = (s16)(v * 32767);
	}
	DSP_FlushDataCache(pcm, n * sizeof *pcm);
	sfx[nsfx++] = (sfx_t){name, pcm, n};
}

bool sound_init(void) {
	if (R_FAILED(ndspInit())) return false;
	ndspSetOutputMode(NDSP_OUTPUT_STEREO);
	for (int c = 0; c < CHANNELS; c++) {
		ndspChnReset(c);
		ndspChnSetInterp(c, NDSP_INTERP_LINEAR);
		ndspChnSetRate(c, RATE);
		ndspChnSetFormat(c, NDSP_FORMAT_MONO_PCM16);
		float mix[12] = {0.8f, 0.8f};
		ndspChnSetMix(c, mix);
	}
	//    name      ms   from   to     noise notes volume
	make("select",   45, 1200,  1500,  0.0f, 1, 0.35f);
	make("move",    160,  300,   900,  0.6f, 1, 0.35f); // whoosh
	make("hit",     140,  160,    60,  0.8f, 1, 0.6f);  // thud with crunch
	make("faint",   520,  700,   120,  0.1f, 1, 0.45f); // falling tone
	make("switch",  220,  500,  1100,  0.4f, 1, 0.35f);
	make("heal",    360,  660,  1320,  0.0f, 3, 0.35f); // rising chime
	make("boost",   300,  520,  1040,  0.0f, 3, 0.35f); // rising steps
	make("drop",    300, 1040,   520,  0.0f, 3, 0.35f); // falling steps
	make("status",  260,  220,   180,  0.5f, 1, 0.35f); // low buzz
	ready = true;
	return true;
}

void sound_exit(void) {
	if (!ready) return;
	ndspExit();
	for (int i = 0; i < nsfx; i++) linearFree(sfx[i].pcm);
	ready = false;
}

void sound_play(const char *name) {
	if (!ready) return;
	for (int i = 0; i < nsfx; i++) {
		if (strcmp(sfx[i].name, name)) continue;
		int c = next_chn;
		next_chn = (next_chn + 1) % CHANNELS;
		ndspChnWaveBufClear(c);
		bufs[c] = (ndspWaveBuf){.data_vaddr = sfx[i].pcm, .nsamples = sfx[i].samples};
		ndspChnWaveBufAdd(c, &bufs[c]);
		return;
	}
}
