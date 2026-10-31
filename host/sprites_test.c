// Checks sprites.c's sheet builder on real GIF/PNG files: every kept frame, read back out of the
// tiled sheet, must equal stb's decode of that frame, and delays must add up.
// Usage: sprites_test file.gif|file.png ...
#include <direct.h>
#include <io.h>
#include <sys/stat.h>
#define mkdir(p, m) _mkdir(p) // MinGW mkdir takes no mode
#include "../source/sprites.c"

int http_get(const char *url, int *status, char **body, size_t *len) { return -1; }
void js_log(const char *fmt, ...) {}

static u16 texel(const sprite_t *s, int X, int Y) {
	u32 off = (((Y >> 3) * (s->sw >> 3) + (X >> 3)) << 6) +
		((X & 1) | ((Y & 1) << 1) | ((X & 2) << 1) | ((Y & 2) << 2) | ((X & 4) << 2) | ((Y & 4) << 3));
	return s->pix[off];
}

// Checks one file at one size: every kept frame must equal stb's all-frames decode (sampled every
// `shrink` pixels), and the delays must add up to the whole animation's length.
static int check(const char *path, const char *data, size_t len, int shrink, int max_sheet) {
	sprite_t s = {0};
	if (!build_sheet(&s, data, len, shrink, max_sheet)) { printf("FAIL %s: not decoded\n", path); return 1; }
	int w, h, n = 1, comp, *delays = NULL;
	unsigned char *px = !memcmp(data, "GIF", 3)
		? stbi_load_gif_from_memory((stbi_uc *)data, len, &delays, &w, &h, &n, &comp, 4)
		: stbi_load_from_memory((stbi_uc *)data, len, &w, &h, &comp, 4);
	int step = (n + s.nframes - 1) / s.nframes, bad = 0;
	u32 want_total = 0;
	for (int i = 0; i < n && delays; i++) want_total += delays[i] > 10 ? delays[i] : 100;
	for (int k = 0; k < s.nframes; k++)
		for (int y = 0; y < s.fh; y++)
			for (int x = 0; x < s.fw; x++) {
				const unsigned char *p = px + ((size_t)k * step * w * h + (y * shrink) * w + x * shrink) * 4;
				u16 want = (p[0] >> 3) << 11 | (p[1] >> 3) << 6 | (p[2] >> 3) << 1 | (p[3] >= 128);
				if (texel(&s, (k % s.cols) * (s.fw + 1) + x, (k / s.cols) * (s.fh + 1) + y) != want) bad++;
			}
	bool ok = !bad && s.sw <= max_sheet && s.sh <= max_sheet && (n == 1 || s.total == want_total);
	printf("%s %-30s x%d %3dx%-3d frames %3d -> %3d  sheet %4dx%-4d %4.0f KB  loop %u ms\n", ok ? "ok  " : "FAIL",
		strrchr(path, '/') ? strrchr(path, '/') + 1 : path, shrink, w, h, n, s.nframes, s.sw, s.sh, s.sw * s.sh * 2 / 1024.0, s.total);
	stbi_image_free(px);
	free(delays);
	free(s.pix);
	free(s.delays);
	return !ok;
}

int main(int argc, char **argv) {
	int failed = 0;
	for (int a = 1; a < argc; a++) {
		size_t len;
		char *data = read_all(argv[a], &len);
		if (!data || (memcmp(data, "GIF", 3) && memcmp(data, "\x89PNG", 4))) { free(data); continue; } // e.g. a saved 404 page
		failed += check(argv[a], data, len, 1, MAX_SHEET);  // battle sprites
		failed += check(argv[a], data, len, 2, 512);        // party / team preview
		free(data);
	}
	return failed != 0;
}
