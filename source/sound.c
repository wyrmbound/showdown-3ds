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
#define MUSIC_CHN CHANNELS
static s16 *music;
static u32 music_n;
static ndspWaveBuf music_buf;
static bool music_on;

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

// ---- Background music: an original chiptune loop (square lead, triangle bass, noise drums) ----
// 16 bars in C major at 164 BPM; notes are MIDI numbers, lengths in eighths.
#define BPM 164
#define EIGHTHS 128
typedef struct { u8 note, len; } step_t;
static const step_t LEAD[] = {
	{76,1},{79,1},{84,2},{83,1},{84,1},{79,2},  {81,1},{79,1},{76,2},{74,1},{76,1},{72,2},
	{76,1},{79,1},{84,2},{86,1},{84,1},{83,2},  {81,1},{83,1},{84,1},{81,1},{79,4},
	{77,1},{81,1},{84,2},{81,1},{77,1},{81,2},  {76,1},{79,1},{83,2},{79,1},{76,1},{79,2},
	{74,1},{77,1},{81,1},{84,1},{83,1},{81,1},{79,1},{77,1},  {76,2},{79,2},{84,3},{0,1},
	{76,1},{79,1},{84,2},{83,1},{84,1},{88,2},  {86,1},{84,1},{83,2},{81,1},{79,1},{81,2},
	{76,1},{79,1},{84,2},{86,1},{84,1},{83,2},  {81,1},{83,1},{84,1},{86,1},{88,4},
	{77,1},{81,1},{86,2},{84,1},{81,1},{77,2},  {76,1},{79,1},{84,2},{83,1},{79,1},{76,2},
	{74,1},{77,1},{81,1},{83,1},{84,1},{86,1},{88,1},{86,1},  {84,2},{79,2},{72,2},{0,2},
};
static const u8 ROOTS[16] = {48, 45, 41, 43, 41, 48, 50, 43, 48, 45, 41, 43, 41, 48, 50, 43}; // C Am F G | F C Dm G
static const u8 BOUNCE[8] = {0, 12, 7, 12, 0, 12, 7, 12}; // bass offsets per eighth

static float hz(int midi) { return 440 * powf(2, (midi - 69) / 12.0f); }

static void make_music(void) {
	u32 per_eighth = (u32)(RATE * 60.0f / BPM / 2);
	music_n = per_eighth * EIGHTHS;
	music = linearAlloc(music_n * sizeof *music);
	if (!music) return;
	// Which lead note sounds in each eighth, and when it started.
	u8 note[EIGHTHS], start[EIGHTHS], len[EIGHTHS];
	for (u32 e = 0, k = 0; k < sizeof LEAD / sizeof *LEAD; k++)
		for (int j = 0; j < LEAD[k].len && e < EIGHTHS; j++, e++) { note[e] = LEAD[k].note; start[e] = e - j; len[e] = LEAD[k].len; }
	float lead_ph = 0, bass_ph = 0;
	for (u32 i = 0; i < music_n; i++) {
		u32 e = i / per_eighth;
		float t = (i % per_eighth) / (float)RATE;         // seconds into this eighth
		float ts = t + (e - start[e]) * per_eighth / (float)RATE; // seconds into the lead note
		float v = 0;
		if (note[e]) {
			float f = hz(note[e]) * (1 + 0.004f * sinf(2 * (float)M_PI * 6 * ts));
			lead_ph += f / RATE;
			float env = fminf(1, ts * 200) * (0.5f + 0.5f * expf(-3 * ts));
			if (ts > len[e] * per_eighth / (float)RATE - 0.03f) env = 0; // a breath between notes
			v += (fmodf(lead_ph, 1) < 0.5f ? 1 : -1) * env * 0.17f;
		}
		bass_ph += hz(ROOTS[e / 8] + BOUNCE[e % 8]) / RATE;
		float bf = fmodf(bass_ph, 1);
		v += (4 * fabsf(bf - 0.5f) - 1) * fminf(1, t * 300) * expf(-6 * t) * 0.2f;
		int beat = e % 8;
		if (beat == 0 || beat == 4) v += sinf(2 * (float)M_PI * (40 + 80 * expf(-30 * t)) * t) * expf(-18 * t) * 0.3f; // kick
		if (beat == 2 || beat == 6) v += noise() * expf(-16 * t) * 0.18f; // snare
		v += noise() * expf(-70 * t) * 0.06f; // hat
		music[i] = (s16)(fmaxf(-1, fminf(1, v)) * 32767);
	}
	DSP_FlushDataCache(music, music_n * sizeof *music);
}

bool sound_init(void) {
	if (R_FAILED(ndspInit())) return false;
	ndspSetOutputMode(NDSP_OUTPUT_STEREO);
	for (int c = 0; c <= MUSIC_CHN; c++) {
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
	make_music();
	ready = true;
	return true;
}

void sound_exit(void) {
	if (!ready) return;
	ndspExit();
	for (int i = 0; i < nsfx; i++) linearFree(sfx[i].pcm);
	linearFree(music);
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

void sound_music(bool on) {
	if (!ready || !music || on == music_on) return;
	music_on = on;
	ndspChnWaveBufClear(MUSIC_CHN);
	if (!on) return;
	music_buf = (ndspWaveBuf){.data_vaddr = music, .nsamples = music_n, .looping = true};
	ndspChnWaveBufAdd(MUSIC_CHN, &music_buf);
}
