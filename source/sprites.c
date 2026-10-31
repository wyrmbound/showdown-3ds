#include "sprites.h"

#include <3ds.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "js.h"
#include "net.h"

#define STBI_ONLY_PNG
#define STBI_ONLY_GIF
#define STBI_NO_STDIO
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"

#define SPRITE_URL "http://play.pokemonshowdown.com/sprites/"
#define LOGO_URL "http://play.pokemonshowdown.com/pokemonshowdownbeta@2x.png" // path "logo"
#define MAX_SPRITES 40
#define MAX_ANIMATED 4        // full-size animation sheets: up to 2 MB of video memory each
#define MAX_SMALL_ANIMATED 14 // half-size ones (party, team preview): up to 512 KB each
#define MAX_SHEET 1024 // largest texture side the GPU takes

enum { FREE, QUEUED, LOADING, DECODED, READY, MISSING };

// Every sprite is a sheet of frames in one texture; a still image is a one-frame sheet.
typedef struct {
	char path[64];
	int state;
	u16 *pix;           // RGBA5551 sheet, already in the GPU's tile order (worker -> main thread)
	int sw, sh;         // sheet size
	int fw, fh, cols;   // frame size, frames per sheet row
	int nframes;
	u16 *delays;        // ms per frame, NULL for still images
	u32 total;          // sum of delays
	u64 used;
	u64 retry_at;       // frame after which a failed (not 404) download is tried again; 0 = never
	C3D_Tex tex;
	Tex3DS_SubTexture sub;
	C2D_Image img;
} sprite_t;

static sprite_t sprites[MAX_SPRITES];
static LightLock lock;
static LightEvent wake;
static Thread worker;
static volatile bool stopping;
static char cache[128];
static u64 frame;

static bool is_small(const char *path) { return !strncmp(path, "s:", 2); }
// Paths are Showdown sprite folders: "ani..." (current default), "gen5ani..." (BW style), "gen5..." (still).
static bool is_animated(const char *path) {
	if (is_small(path)) path += 2;
	return !strncmp(path, "ani", 3) || !strncmp(path, "gen5ani", 7);
}

static int pow2(int n) {
	int p = 8;
	while (p < n) p <<= 1;
	return p;
}

static char *read_all(const char *path, size_t *len) {
	FILE *f = fopen(path, "rb");
	if (!f) return NULL;
	fseek(f, 0, SEEK_END);
	long n = ftell(f);
	fseek(f, 0, SEEK_SET);
	char *buf = n > 0 ? malloc(n) : NULL;
	if (buf && fread(buf, 1, n, f) != (size_t)n) {
		free(buf);
		buf = NULL;
	}
	fclose(f);
	*len = n;
	return buf;
}

// Counts a GIF's frames by walking its blocks (no decoding), so we know how many to keep.
static int gif_frame_count(const unsigned char *d, size_t len) {
	if (len < 13 || memcmp(d, "GIF", 3)) return 0;
	size_t i = 13 + (d[10] & 0x80 ? 3 * (2 << (d[10] & 7)) : 0);
	int n = 0;
	while (i < len) {
		unsigned char b = d[i++];
		if (b == 0x21) { // extension: label, then data sub-blocks
			i++;
			while (i < len && d[i]) i += d[i] + 1;
			i++;
		} else if (b == 0x2C) { // image: descriptor, optional palette, LZW size, data sub-blocks
			if (i + 9 > len) break;
			unsigned char lf = d[i + 8];
			i += 9 + (lf & 0x80 ? 3 * (2 << (lf & 7)) : 0) + 1;
			while (i < len && d[i]) i += d[i] + 1;
			i++;
			n++;
		} else {
			break; // 0x3B trailer or junk
		}
	}
	return n;
}

// Writes one RGBA frame (shrunk by `shrink`, nearest pixel) into the tiled RGBA5551 sheet at (ox, oy).
static void put_frame(u16 *pix, int sw, const unsigned char *rgba, int w, int h, int shrink, int ox, int oy) {
	for (int y = 0; y < h / shrink; y++) {
		for (int x = 0; x < w / shrink; x++) {
			const unsigned char *p = rgba + ((y * shrink) * w + x * shrink) * 4;
			int X = ox + x, Y = oy + y;
			// The GPU reads textures in 8x8 Morton-ordered tiles.
			u32 off = (((Y >> 3) * (sw >> 3) + (X >> 3)) << 6) +
				((X & 1) | ((Y & 1) << 1) | ((X & 2) << 1) | ((Y & 2) << 2) | ((X & 4) << 2) | ((Y & 4) << 3));
			pix[off] = (p[0] >> 3) << 11 | (p[1] >> 3) << 6 | (p[2] >> 3) << 1 | (p[3] >= 128);
		}
	}
}

// Decodes a PNG or GIF into s->pix as a sheet of frames, each `shrink` times smaller. Animations
// too long for one max_sheet x max_sheet sheet keep every 2nd (3rd, ...) frame and show each one
// longer, so they still play at the right speed. GIFs are decoded one frame at a time straight
// into the sheet: stb's all-frames loader needs the whole animation in memory, twice over while
// it grows its buffer, which big Showdown animations can't afford on an Old 3DS.
static bool build_sheet(sprite_t *s, const char *data, size_t len, int shrink, int max_sheet) {
	if (!data) return false;
	const stbi_uc *bytes = (const stbi_uc *)data;
	bool gif = len > 13 && !memcmp(data, "GIF", 3);
	int n = 1, w, h, comp;
	unsigned char *still = NULL;
	if (gif) {
		n = gif_frame_count(bytes, len);
		w = bytes[6] | bytes[7] << 8;
		h = bytes[8] | bytes[9] << 8;
	} else {
		still = stbi_load_from_memory(bytes, len, &w, &h, &comp, 4);
		if (!still) return false;
	}
	// Sprites are at most 256 px; a still (the logo) only has to fit one sheet.
	if (n < 1 || w < shrink || h < shrink || (gif && (w > 256 || h > 256)) || w > max_sheet || h > max_sheet) {
		stbi_image_free(still);
		return false;
	}
	// Frames sit in cells one pixel bigger than the frame, so sampling at a frame's edge picks up
	// transparent padding instead of the neighbouring frame.
	int fw = w / shrink, fh = h / shrink, cw = fw + 1, ch = fh + 1;
	int cols = max_sheet / cw, cap = cols * (max_sheet / ch);
	int step = (n + cap - 1) / cap, kept = (n + step - 1) / step;
	int sw = pow2((kept < cols ? kept : cols) * cw), sh = pow2((kept + cols - 1) / cols * ch);
	u16 *pix = calloc(sw * sh, 2);
	u16 *d = kept > 1 ? calloc(kept, sizeof *d) : NULL;
	stbi__gif *g = gif ? calloc(1, sizeof *g) : NULL;
	bool ok = pix && (kept < 2 || d) && (!gif || g);
	u32 total = 0;
	if (ok && !gif) {
		put_frame(pix, sw, still, w, h, shrink, 0, 0);
	} else if (ok) {
		stbi__context ctx;
		stbi__start_mem(&ctx, bytes, (int)len);
		int got = 0;
		for (int i = 0; i < n; i++) {
			stbi_uc *f = stbi__gif_load_next(&ctx, g, &comp, 4, NULL);
			if (!f || f == (stbi_uc *)&ctx) break;
			if (g->w != w || g->h != h) break;
			if (i % step == 0) put_frame(pix, sw, f, w, h, shrink, (got % cols) * cw, (got / cols) * ch), got++;
			if (d) {
				u32 ms = g->delay > 10 ? g->delay : 100;
				d[got - 1] += ms;
				total += ms;
			}
		}
		STBI_FREE(g->out);
		STBI_FREE(g->history);
		STBI_FREE(g->background);
		if (got < 1) ok = false;
		kept = got;
	}
	stbi_image_free(still);
	free(g);
	if (!ok) {
		free(pix);
		free(d);
		return false;
	}
	s->pix = pix;
	s->sw = sw;
	s->sh = sh;
	s->fw = fw;
	s->fh = fh;
	s->cols = cols;
	s->nframes = kept;
	s->delays = kept > 1 ? d : (free(d), NULL);
	s->total = kept > 1 ? total : 0;
	return true;
}

// Loads one sprite: SD cache first, then the network (saving what it downloads).
static void load(sprite_t *s, const char *path) {
	// "s:" asks for a half-size sheet (party and team preview), which costs a quarter of the memory.
	bool small = !strncmp(path, "s:", 2);
	int shrink = small ? 2 : 1, max_sheet = small ? 512 : MAX_SHEET;
	if (small) path += 2;
	bool logo = !strcmp(path, "logo");
	const char *ext = !logo && is_animated(path) ? "gif" : "png";
	char file[256], tmp[260];
	snprintf(file, sizeof file, "%s/%s.%s", cache, path, ext);
	size_t len = 0;
	int status = 0;
	sprite_t built = {0};
	char *data = read_all(file, &len);
	bool ok = build_sheet(&built, data, len, shrink, max_sheet);
	free(data);
	if (!ok) {
		remove(file); // missing or corrupt cache entry
		char url[160];
		if (logo) snprintf(url, sizeof url, LOGO_URL);
		else snprintf(url, sizeof url, SPRITE_URL "%s.%s", path, ext);
		data = NULL;
		if (http_get(url, &status, &data, &len) == 0 && status == 200 && build_sheet(&built, data, len, shrink, max_sheet)) {
			ok = true;
			// Write to a temp file first so an interrupted write never leaves a broken cache entry.
			snprintf(tmp, sizeof tmp, "%s.tmp", file);
			FILE *f = fopen(tmp, "wb");
			if (f) {
				bool written = fwrite(data, 1, len, f) == len;
				fclose(f);
				if (!written || rename(tmp, file) != 0) remove(tmp);
			}
		}
		free(data);
	}
	LightLock_Lock(&lock);
	if (ok) {
		s->pix = built.pix;
		s->sw = built.sw;
		s->sh = built.sh;
		s->fw = built.fw;
		s->fh = built.fh;
		s->cols = built.cols;
		s->nframes = built.nframes;
		s->delays = built.delays;
		s->total = built.total;
	}
	s->state = ok ? DECODED : MISSING;
	// No connection or a server hiccup: try again in about 10 seconds. A 404, or a file we can't
	// decode, is final.
	s->retry_at = !ok && status != 404 && status != 200 ? frame + 600 : 0;
	LightLock_Unlock(&lock);
}

static void worker_main(void *arg) {
	while (!stopping) {
		LightEvent_Wait(&wake);
		for (;;) {
			sprite_t *job = NULL;
			char path[64];
			LightLock_Lock(&lock);
			for (int i = 0; i < MAX_SPRITES && !job; i++)
				if (sprites[i].state == QUEUED) job = &sprites[i];
			if (job) {
				job->state = LOADING;
				strcpy(path, job->path);
			}
			LightLock_Unlock(&lock);
			if (!job || stopping) break;
			load(job, path);
		}
	}
}

void sprites_init(const char *cache_dir) {
	snprintf(cache, sizeof cache, "%s", cache_dir);
	mkdir(cache, 0777);
	static const char *dirs[] = {"gen5", "gen5-back", "gen5-shiny", "gen5-back-shiny",
		"gen5ani", "gen5ani-back", "gen5ani-shiny", "gen5ani-back-shiny",
		"ani", "ani-back", "ani-shiny", "ani-back-shiny"};
	for (size_t i = 0; i < sizeof dirs / sizeof *dirs; i++) {
		char d[160];
		snprintf(d, sizeof d, "%s/%s", cache, dirs[i]);
		mkdir(d, 0777);
	}
	LightLock_Init(&lock);
	LightEvent_Init(&wake, RESET_ONESHOT);
	s32 prio = 0x30;
	svcGetThreadPriority(&prio, CUR_THREAD_HANDLE);
	// Lower priority than the UI so downloads only use time the main loop leaves idle. The GIF
	// decoder keeps ~40 KB of tables on the stack, hence the roomy stack.
	worker = threadCreate(worker_main, NULL, 256 * 1024, prio + 1, -2, false);
}

static void release(sprite_t *s) {
	if (s->state == READY) C3D_TexDelete(&s->tex);
	free(s->pix);
	free(s->delays);
	s->pix = NULL;
	s->delays = NULL;
	s->state = FREE;
}

void sprites_exit(void) {
	stopping = true;
	LightEvent_Signal(&wake);
	// A download gives up after 10 s on its own; don't let a stuck one block quitting forever.
	if (worker && R_SUCCEEDED(threadJoin(worker, 3000000000ULL))) threadFree(worker);
	for (int i = 0; i < MAX_SPRITES; i++) release(&sprites[i]);
}

static bool upload(sprite_t *s) {
	if (!C3D_TexInit(&s->tex, s->sw, s->sh, GPU_RGBA5551)) return false;
	memcpy(s->tex.data, s->pix, s->sw * s->sh * 2);
	C3D_TexFlush(&s->tex);
	C3D_TexSetFilter(&s->tex, GPU_NEAREST, GPU_NEAREST);
	s->img = (C2D_Image){&s->tex, &s->sub};
	return true;
}

// Points the sprite's subtexture at the frame that should show now.
static void pick_frame(sprite_t *s) {
	int k = 0;
	if (s->delays && s->total) {
		u32 t = osGetTime() % s->total;
		while (k < s->nframes - 1 && t >= s->delays[k]) t -= s->delays[k++];
	}
	float ox = (k % s->cols) * (s->fw + 1), oy = (k / s->cols) * (s->fh + 1);
	s->sub = (Tex3DS_SubTexture){(u16)s->fw, (u16)s->fh, ox / s->sw, 1.0f - oy / s->sh,
		(ox + s->fw) / s->sw, 1.0f - (oy + s->fh) / s->sh};
}

void sprites_update(void) {
	frame++;
	LightLock_Lock(&lock);
	for (int i = 0; i < MAX_SPRITES; i++) {
		sprite_t *s = &sprites[i];
		if (s->state != DECODED) continue;
		s->state = upload(s) ? READY : MISSING;
		if (s->state == MISSING) js_log("sprite %s: no video memory for a %dx%d sheet (free %lu KB)", s->path, s->sw, s->sh, (unsigned long)(linearSpaceFree() / 1024));
		free(s->pix);
		s->pix = NULL;
	}
	LightLock_Unlock(&lock);
}

const C2D_Image *sprite_get(const char *path, bool *missing) {
	*missing = false;
	if (!path || !*path) {
		*missing = true;
		return NULL;
	}
	bool animated = is_animated(path), small = is_small(path);
	LightLock_Lock(&lock);
	sprite_t *hit = NULL, *slot = NULL, *oldest = NULL, *oldest_ani = NULL;
	int ani_count = 0;
	for (int i = 0; i < MAX_SPRITES; i++) {
		sprite_t *s = &sprites[i];
		if (s->state != FREE && !strcmp(s->path, path)) { hit = s; break; }
		if (s->state == FREE && !slot) slot = s;
		bool evictable = (s->state == READY || s->state == MISSING) && s->used < frame;
		if (evictable && (!oldest || s->used < oldest->used)) oldest = s;
		// Count animation sheets of the same size class as the one requested.
		if (s->state != FREE && is_animated(s->path) && is_small(s->path) == small) {
			ani_count++;
			if (evictable && (!oldest_ani || s->used < oldest_ani->used)) oldest_ani = s;
		}
	}
	const C2D_Image *img = NULL;
	if (hit) {
		if (hit->state == MISSING && hit->retry_at && frame >= hit->retry_at) {
			hit->state = QUEUED;
			LightEvent_Signal(&wake);
		}
		hit->used = frame;
		if (hit->state == READY) {
			pick_frame(hit);
			img = &hit->img;
		}
		*missing = hit->state == MISSING && !hit->retry_at; // a retry pending is "loading", not missing
	} else {
		// Keep the number of (big) animation sheets bounded, and make room when the table is full.
		if (animated && ani_count >= (small ? MAX_SMALL_ANIMATED : MAX_ANIMATED)) {
			slot = oldest_ani;
			oldest = NULL; // none free yet: wait instead of going over the limit
		}
		if (slot && slot->state != FREE) release(slot);
		if (!slot && oldest) {
			release(oldest);
			slot = oldest;
		}
		if (slot) {
			snprintf(slot->path, sizeof slot->path, "%s", path);
			slot->state = QUEUED;
			slot->used = frame;
			LightEvent_Signal(&wake);
		}
	}
	LightLock_Unlock(&lock);
	return img;
}
