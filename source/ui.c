#include "ui.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "js.h"
#include "sound.h"
#include "sprites.h"

#define TOP_W 400
#define BOT_W 320
#define SCR_H 240
#define MAX_BTNS 48 // the on-screen keyboard
#define SMALL_Y 204 // the small-button row at the bottom

#define RGB(hex) C2D_Color32((hex) >> 16 & 0xff, (hex) >> 8 & 0xff, (hex) & 0xff, 0xff)
#define WHITE C2D_Color32(0xff, 0xff, 0xff, 0xff)
#define INK C2D_Color32(0x1c, 0x22, 0x33, 0xff)
#define MUTED C2D_Color32(0x8a, 0x94, 0xa8, 0xff)
#define PANEL C2D_Color32(0x1b, 0x22, 0x38, 0xff)
#define PANEL_LIGHT C2D_Color32(0xf4, 0xf6, 0xfb, 0xf0)
#define BTN C2D_Color32(0x3b, 0x6f, 0xd6, 0xff)
#define BTN_SMALL C2D_Color32(0x2b, 0x34, 0x50, 0xff)
#define BTN_OFF C2D_Color32(0x3a, 0x40, 0x52, 0xff)
#define SHADOW C2D_Color32(0x0a, 0x0d, 0x18, 0xff)
#define ACCENT C2D_Color32(0x5b, 0x8d, 0xef, 0xff)
#define FOCUS C2D_Color32(0xff, 0xd3, 0x4a, 0xff)
#define BG_BOTTOM C2D_Color32(0x12, 0x17, 0x2a, 0xff)
#define CHAT C2D_Color32(0x8f, 0xd3, 0xff, 0xff)

typedef struct {
	char id[32];
	float x, y, w, h;
	bool enabled;
} btn_t;

static C2D_TextBuf tbuf;
static bool sound_on = true; // the Sound setting, from app.view
static int last_fx_id;
static btn_t btns[MAX_BTNS];
static int nbtns, sel;
static char btn_sig[MAX_BTNS * 32];

void ui_init(void) { tbuf = C2D_TextBufNew(8192); }
void ui_exit(void) { C2D_TextBufDelete(tbuf); }

static void text(float x, float y, float scale, u32 color, u32 flags, float wrap, const char *s) {
	if (!s || !*s) return;
	C2D_Text t;
	C2D_TextParse(&t, tbuf, s);
	C2D_TextOptimize(&t);
	if (flags & C2D_WordWrap) C2D_DrawText(&t, flags | C2D_WithColor, x, y, 0.5f, scale, scale, color, wrap);
	else C2D_DrawText(&t, flags | C2D_WithColor, x, y, 0.5f, scale, scale, color);
}

static void rect(float x, float y, float w, float h, u32 c) { C2D_DrawRectSolid(x, y, 0.5f, w, h, c); }
static void round_rect(float x, float y, float w, float h, float r, u32 c) {
	C2D_DrawRectSolid(x + r, y, 0.5f, w - 2 * r, h, c);
	C2D_DrawRectSolid(x, y + r, 0.5f, r, h - 2 * r, c);
	C2D_DrawRectSolid(x + w - r, y + r, 0.5f, r, h - 2 * r, c);
	C2D_DrawCircleSolid(x + r, y + r, 0.5f, r, c);
	C2D_DrawCircleSolid(x + w - r, y + r, 0.5f, r, c);
	C2D_DrawCircleSolid(x + r, y + h - r, 0.5f, r, c);
	C2D_DrawCircleSolid(x + w - r, y + h - r, 0.5f, r, c);
}

static void frame_rect(float x, float y, float w, float h, float t, u32 c) {
	rect(x, y, w, t, c);
	rect(x, y + h - t, w, t, c);
	rect(x, y, t, h, c);
	rect(x + w - t, y, t, h, c);
}

static u32 hp_color(int pct) { return pct > 50 ? RGB(0x4cd964) : pct > 20 ? RGB(0xffcc00) : RGB(0xff3b30); }

static u32 status_color(const char *s) {
	if (!strcmp(s, "BRN")) return RGB(0xee5533);
	if (!strcmp(s, "PAR")) return RGB(0xd8b020);
	if (!strcmp(s, "SLP")) return RGB(0x8888aa);
	if (!strcmp(s, "FRZ")) return RGB(0x55aadd);
	if (!strcmp(s, "PSN") || !strcmp(s, "TOX")) return RGB(0xa040a0);
	return RGB(0x555555);
}

// Next sprite to try when Showdown has none at `p` (edited in place; false = nothing left):
// "ani..." (current style) -> "gen5ani..." (BW animation) -> "gen5..." (still) -> no back view.
static bool next_sprite(char *p, size_t size) {
	char *core = !strncmp(p, "s:", 2) ? p + 2 : p, *back;
	char rest[64];
	if (!strncmp(core, "ani", 3)) {
		snprintf(rest, sizeof rest, "%s", core + 3);
		snprintf(core, size - (core - p), "gen5ani%s", rest);
	} else if (!strncmp(core, "gen5ani", 7)) {
		memmove(core + 4, core + 7, strlen(core + 7) + 1);
	} else if ((back = strstr(core, "-back"))) {
		memmove(back, back + 5, strlen(back + 5) + 1);
	} else {
		return false;
	}
	return true;
}

// Draws a sprite with its feet at (cx, base_y), or a name plate if it isn't available. `scale`
// is relative to the sprite's real size, and the result is shrunk to stay within max_h pixels
// ("ani" sprites can be twice the height of gen5 ones). "s:" sheets are stored at half size.
// Per-sprite animation transform: offset, opacity and growth (1 = normal size).
typedef struct {
	float dx, dy, alpha, grow;
} xform_t;
static const xform_t XF_NONE = {0, 0, 1, 1};

static void draw_sprite_xf(const char *path, const char *name, float cx, float base_y, float scale, float max_h, const xform_t *xf) {
	if (xf->alpha <= 0.02f) return;
	cx += xf->dx;
	base_y += xf->dy;
	bool missing;
	char try[64];
	snprintf(try, sizeof try, "%s", path);
	const C2D_Image *img = sprite_get(try, &missing);
	while (!img && missing && next_sprite(try, sizeof try)) img = sprite_get(try, &missing);
	if (img) {
		float s = !strncmp(try, "s:", 2) ? scale * 2 : scale;
		if (img->subtex->height * s > max_h) s = max_h / img->subtex->height;
		s *= xf->grow;
		float w = img->subtex->width * s, h = img->subtex->height * s;
		C2D_ImageTint tint;
		if (xf->alpha < 1) C2D_AlphaImageTint(&tint, xf->alpha);
		C2D_DrawImageAt(*img, cx - w / 2, base_y - h, 0.5f, xf->alpha < 1 ? &tint : NULL, s, s);
	} else {
		float w = 90 * scale, h = 26 * scale;
		rect(cx - w / 2, base_y - h - 10 * scale, w, h, C2D_Color32(0, 0, 0, 0x50));
		text(cx, base_y - h - 6 * scale, 0.45f * scale, WHITE, C2D_AlignCenter, 0, missing ? name : "...");
	}
}

static void draw_sprite(const char *path, const char *name, float cx, float base_y, float scale, float max_h) {
	draw_sprite_xf(path, name, cx, base_y, scale, max_h, &XF_NONE);
}

#define PI 3.14159265f
static u32 rgba(int hex, float a) { return C2D_Color32(hex >> 16 & 0xff, hex >> 8 & 0xff, hex & 0xff, (u8)(a * 255)); }

// Battle animation (top.fx from the app): moves the sprites, then draws the effect on top.
// Original abstract effects (bursts, sparks, arrows), drawn from the move type's colour.
typedef struct {
	char kind[12];
	bool on_me, status;
	float k; // progress 0..1
	int color;
} fx_t;

static void fx_xforms(const fx_t *fx, xform_t *me, xform_t *foe) {
	xform_t *self = fx->on_me ? me : foe;
	float k = fx->k, toward = fx->on_me ? 1 : -1; // my Pokemon lunges up-right, the foe down-left
	if (!strcmp(fx->kind, "move") && !fx->status) {
		float d = sinf(k * PI) * 18;
		self->dx = d * toward;
		self->dy = -d * 0.5f * toward;
	} else if (!strcmp(fx->kind, "hit")) {
		self->alpha = (int)(k * 8) % 2 ? 0.3f : 1;
		self->dx = sinf(k * PI * 6) * 3;
	} else if (!strcmp(fx->kind, "faint")) {
		self->dy = k * 45;
		self->alpha = 1 - k;
	} else if (!strcmp(fx->kind, "switch")) {
		self->grow = 0.3f + 0.7f * k;
		self->alpha = k;
	}
}

static void fx_draw(const fx_t *fx) {
	// Centres of the two Pokemon on screen.
	float mx = 105, my = 140, ox = 300, oy = 70;
	float sx = fx->on_me ? mx : ox, sy = fx->on_me ? my : oy; // the side the event is about
	float tx = fx->on_me ? ox : mx, ty = fx->on_me ? oy : my; // its opponent
	float k = fx->k;
	if (!strcmp(fx->kind, "move")) {
		if (fx->status) { // a glow pulsing around the user
			C2D_DrawCircleSolid(sx, sy, 0.5f, 26 + 12 * sinf(k * PI), rgba(fx->color, 0.35f * sinf(k * PI)));
		} else if (k > 0.35f) { // a burst on the target once the lunge connects
			float u = (k - 0.35f) / 0.65f;
			C2D_DrawCircleSolid(tx, ty, 0.5f, 8 + 30 * u, rgba(fx->color, 0.45f * (1 - u)));
			C2D_DrawCircleSolid(tx, ty, 0.5f, 4 + 14 * u, rgba(0xffffff, 0.5f * (1 - u)));
			for (int i = 0; i < 8; i++) {
				float a = i * PI / 4 + 0.4f, r = 10 + 36 * u;
				C2D_DrawCircleSolid(tx + cosf(a) * r, ty + sinf(a) * r * 0.8f, 0.5f, 3 * (1 - u) + 1, rgba(fx->color, 1 - u));
			}
		}
	} else if (!strcmp(fx->kind, "heal")) {
		for (int i = 0; i < 6; i++) {
			float x = sx - 30 + i * 12, y = sy + 25 - k * 50 - (i % 2) * 10;
			C2D_DrawCircleSolid(x, y, 0.5f, 3, rgba(0x6be37a, 1 - k));
		}
	} else if (!strcmp(fx->kind, "boost") || !strcmp(fx->kind, "drop")) {
		bool up = fx->kind[0] == 'b';
		u32 c = rgba(up ? 0x4a90ff : 0xff5a4a, 1 - k);
		for (int i = 0; i < 3; i++) {
			float x = sx - 24 + i * 24, y = up ? sy + 20 - k * 45 - i * 6 : sy - 25 + k * 45 + i * 6, d = up ? -1 : 1;
			C2D_DrawTriangle(x - 7, y, c, x + 7, y, c, x, y + 10 * d, c, 0.5f);
		}
	} else if (!strcmp(fx->kind, "status")) {
		for (int i = 0; i < 6; i++) {
			float a = i * PI / 3 + k * 2 * PI;
			C2D_DrawCircleSolid(sx + cosf(a) * 28, sy + sinf(a) * 14, 0.5f, 3, rgba(0xb36bd6, 1 - k * 0.7f));
		}
	}
}

static void info_box(JSValue mon, float x, float y, bool mine) {
	if (!jsv_is(mon)) return;
	char name[48], buf[48], status[8], tera[16];
	float w = 184, h = mine ? 58 : 50;
	rect(x, y, w, h, PANEL_LIGHT);
	rect(x, y + h - 3, w, 3, mine ? RGB(0x3d5a9e) : RGB(0xc0504d));
	jsv_str(mon, "name", name, sizeof name);
	text(x + 6, y + 3, 0.55f, INK, 0, 0, name);
	snprintf(buf, sizeof buf, "Lv%d", jsv_int(mon, "level", 100));
	text(x + w - 6, y + 4, 0.45f, INK, C2D_AlignRight, 0, buf);
	int pct = jsv_int(mon, "pct", 0);
	float bx = x + 34, bw = w - 42;
	text(x + 6, y + 23, 0.38f, RGB(0xd08000), 0, 0, "HP");
	rect(bx, y + 25, bw, 7, RGB(0x505860));
	rect(bx + 1, y + 26, (bw - 2) * pct / 100.0f, 5, hp_color(pct));
	jsv_str(mon, "status", status, sizeof status);
	if (status[0]) {
		rect(x + 6, y + 35, 30, 12, status_color(status));
		text(x + 21, y + 35, 0.38f, WHITE, C2D_AlignCenter, 0, status);
	}
	jsv_str(mon, "tera", tera, sizeof tera);
	if (tera[0]) {
		snprintf(buf, sizeof buf, "Tera %s", tera);
		text(x + (status[0] ? 40 : 6), y + 35, 0.38f, RGB(0x2a8a80), 0, 0, buf);
	}
	text(x + w - 6, y + 34, mine ? 0.5f : 0.42f, INK, C2D_AlignRight, 0, jsv_str(mon, "hpText", buf, sizeof buf));

	// Stat changes as a vertical list of labels: under the foe's box, above mine (below mine is
	// the message box). Blue for raised stats, red for lowered ones.
	JSValue boosts = jsv_get(mon, "boosts");
	int n = jsv_len(boosts);
	for (int i = 0; i < n; i++) {
		char k[12];
		snprintf(k, sizeof k, "%d", i);
		jsv_str(boosts, k, buf, sizeof buf);
		float cy = mine ? y - 17 - (i + 1) * 15 : y + h + 17 + i * 15; // past the team dots
		rect(x, cy, 80, 13, buf[0] == '-' ? C2D_Color32(0xc0, 0x50, 0x4d, 0xe0) : C2D_Color32(0x3d, 0x5a, 0x9e, 0xe0));
		text(x + 4, cy, 0.38f, WHITE, 0, 0, buf);
	}
	jsv_free(boosts);
}

// One dot per team member next to an HP box: healthy, statused, fainted, or not seen yet.
static void team_dots(JSValue dots, float x, float y) {
	int n = jsv_len(dots);
	for (int i = 0; i < n && i < 6; i++) {
		char k[4], st[12];
		snprintf(k, sizeof k, "%d", i);
		jsv_str(dots, k, st, sizeof st);
		float cx = x + 6 + i * 13, cy = y + 5;
		C2D_DrawCircleSolid(cx, cy, 0.5f, 5, C2D_Color32(0x20, 0x26, 0x38, 0xc0));
		u32 fill = !strcmp(st, "fnt") ? RGB(0x606878) : !strcmp(st, "status") ? RGB(0xf0c040)
			: !strcmp(st, "unknown") ? C2D_Color32(0xff, 0xff, 0xff, 0x40) : RGB(0xf4f6fb);
		C2D_DrawCircleSolid(cx, cy, 0.5f, 3.5f, fill);
	}
}

static void draw_top_battle(JSValue top, const char *detail) {
	// Sky, ground and the two platforms (plain shapes, no game art).
	C2D_DrawRectangle(0, 0, 0.5f, TOP_W, 130, RGB(0x8fc6ef), RGB(0x8fc6ef), RGB(0xd8eefa), RGB(0xd8eefa));
	C2D_DrawRectangle(0, 130, 0.5f, TOP_W, 110, RGB(0xb5d68a), RGB(0xb5d68a), RGB(0x8fbf62), RGB(0x8fbf62));
	C2D_DrawEllipseSolid(225, 100, 0.5f, 150, 34, RGB(0x7aa84e));
	C2D_DrawEllipseSolid(20, 172, 0.5f, 170, 40, RGB(0x6e9b45));

	JSValue preview = jsv_get(top, "preview");
	int np = jsv_len(preview);
	char buf[64], path[64], name[48];
	if (np) {
		rect(0, 0, TOP_W, 192, C2D_Color32(0x16, 0x1b, 0x29, 0xe0));
		text(TOP_W / 2, 6, 0.55f, WHITE, C2D_AlignCenter, 0, jsv_str(top, "foeName", buf, sizeof buf));
		for (int i = 0; i < np && i < 6; i++) {
			JSValue p = jsv_idx(preview, i);
			float cx = 70 + (i % 3) * 130, by = 96 + (i / 3) * 78; // names stay above the message box
			draw_sprite(jsv_str(p, "sprite", path, sizeof path), jsv_str(p, "name", name, sizeof name), cx, by, 0.8f, 70);
			text(cx, by, 0.42f, WHITE, C2D_AlignCenter, 0, name);
			jsv_free(p);
		}
	}
	jsv_free(preview);
	JSValue foe = jsv_get(top, "foe"), me = jsv_get(top, "me"), fxv = jsv_get(top, "fx");
	if (!np) {
		fx_t fx = {.k = jsv_int(fxv, "t", 0) / 1000.0f, .color = jsv_int(fxv, "color", 0xffffff), .status = jsv_bool(fxv, "status", false)};
		char who[8];
		jsv_str(fxv, "kind", fx.kind, sizeof fx.kind);
		fx.on_me = !strcmp(jsv_str(fxv, "who", who, sizeof who), "me");
		xform_t xme = XF_NONE, xfoe = XF_NONE;
		if (fx.kind[0]) fx_xforms(&fx, &xme, &xfoe);
		int fx_id = jsv_int(fxv, "id", 0);
		if (fx.kind[0] && fx_id != last_fx_id) { // a new animation just started: its sound
			last_fx_id = fx_id;
			if (sound_on) sound_play(!strcmp(fx.kind, "move") && fx.status ? "status" : fx.kind);
		}
		if (jsv_is(foe)) draw_sprite_xf(jsv_str(foe, "sprite", path, sizeof path), jsv_str(foe, "name", name, sizeof name), 300, 118, 1.0f, 105, &xfoe);
		if (jsv_is(me)) draw_sprite_xf(jsv_str(me, "sprite", path, sizeof path), jsv_str(me, "name", name, sizeof name), 105, 200, 1.25f, 135, &xme);
		if (fx.kind[0]) fx_draw(&fx);
		info_box(foe, 8, 8, false);
		info_box(me, 208, 128, true);
		JSValue mine = jsv_get(top, "myTeam"), theirs = jsv_get(top, "foeTeam");
		if (jsv_is(foe)) team_dots(theirs, 8, 61);
		if (jsv_is(me)) team_dots(mine, 208, 115);
		jsv_free(mine);
		jsv_free(theirs);
		int turn = jsv_int(top, "turn", 0);
		if (turn) {
			snprintf(buf, sizeof buf, "Turn %d", turn);
			text(TOP_W - 6, 4, 0.45f, INK, C2D_AlignRight, 0, buf);
		}
		float ty = 20;
		if (jsv_str(top, "weather", buf, sizeof buf)[0]) {
			text(TOP_W - 6, ty, 0.4f, INK, C2D_AlignRight, 0, buf);
			ty += 14;
		}
		int timer = jsv_int(top, "timer", -1);
		if (timer >= 0) {
			snprintf(buf, sizeof buf, "Timer %d:%02d", timer / 60, timer % 60);
			text(TOP_W - 6, ty, 0.45f, timer <= 30 ? RGB(0xd03030) : INK, C2D_AlignRight, 0, buf);
		}
	}
	jsv_free(foe);
	jsv_free(me);
	jsv_free(fxv);
	// Message box.
	char msg[512];
	rect(0, 192, TOP_W, 48, PANEL);
	rect(0, 192, TOP_W, 2, FOCUS);
	// While a party member is highlighted, its item / ability / moves replace the battle text.
	if (detail && *detail) text(10, 196, 0.42f, WHITE, C2D_WordWrap, TOP_W - 20, detail);
	else text(10, 198, 0.5f, WHITE, C2D_WordWrap, TOP_W - 20, jsv_str(top, "msg", msg, sizeof msg));
}

static void draw_top_title(void) {
	C2D_DrawRectangle(0, 0, 0.5f, TOP_W, SCR_H, RGB(0x1d2b52), RGB(0x1d2b52), RGB(0x0e1426), RGB(0x0e1426));
	C2D_DrawEllipseSolid(-60, 150, 0.5f, 260, 160, C2D_Color32(0xc0, 0x50, 0x4d, 0x50));
	C2D_DrawEllipseSolid(200, -80, 0.5f, 260, 160, C2D_Color32(0x3d, 0x5a, 0x9e, 0x60));
	bool missing;
	const C2D_Image *logo = sprite_get("logo", &missing); // Showdown's own logo, fetched and cached like a sprite
	if (logo) C2D_DrawImageAt(*logo, (TOP_W - logo->subtex->width) / 2, 46, 0.5f, NULL, 1, 1);
	else text(TOP_W / 2, 64, 1.3f, WHITE, C2D_AlignCenter, 0, "Pok\xc3\xa9mon Showdown");
	round_rect(TOP_W / 2 - 92, 140, 184, 26, 13, C2D_Color32(0, 0, 0, 0x60));
	text(TOP_W / 2, 145, 0.52f, WHITE, C2D_AlignCenter, 0, "Unofficial  \xc2\xb7  3DS");
	text(TOP_W / 2, 196, 0.38f, MUTED, C2D_AlignCenter | C2D_WordWrap, 360,
		"Battle engine: Pok\xc3\xa9mon Showdown (MIT). Sprites load from play.pokemonshowdown.com. "
		"Not affiliated with Nintendo, Game Freak or The Pok\xc3\xa9mon Company.");
}

// Rows of wrapped text at the 0.42-0.43 scales used here.
// shortcut: ~5.6 px per character (citro2d measures unwrapped text only); fine for notices and log lines.
static int text_rows(const char *s, float width) {
	int rows = 0, len = 0;
	for (;; s++) {
		if (*s && *s != '\n') { len++; continue; }
		rows += 1 + (int)(len * 5.6f / width);
		len = 0;
		if (!*s) return rows;
	}
}

// Computes button rectangles for the current layout. Big buttons stack (or form a 2-column grid)
// from y0 down to the small-button row, shrinking to fit; the keyboard layout places each key
// where the app says.
static void layout_buttons(JSValue view, JSValue list, float y0) {
	char layout[16];
	jsv_str(view, "layout", layout, sizeof layout);
	bool keys = !strcmp(layout, "keys");
	int n = jsv_len(list);
	if (n > MAX_BTNS) n = MAX_BTNS;
	nbtns = n;
	bool small[MAX_BTNS];
	int nsmall = 0, nbig = 0;
	for (int i = 0; i < n; i++) {
		JSValue b = jsv_idx(list, i);
		jsv_str(b, "id", btns[i].id, sizeof btns[i].id);
		btns[i].enabled = jsv_bool(b, "enabled", true);
		small[i] = jsv_bool(b, "small", false);
		if (small[i]) nsmall++; else nbig++;
		if (keys) {
			btns[i].x = jsv_int(b, "x", 0);
			btns[i].y = jsv_int(b, "y", 0);
			btns[i].w = jsv_int(b, "w", 29);
			btns[i].h = jsv_int(b, "h", 26);
		}
		jsv_free(b);
	}
	bool grid = !strcmp(layout, "moves") || !strcmp(layout, "party") || !strcmp(layout, "grid");
	bool log = !strcmp(layout, "log");
	if (log) nsmall = n;
	int rows = grid ? (nbig + 1) / 2 : nbig;
	float rowh = !strcmp(layout, "moves") ? 62 : 40;
	if (rows) rowh = fmaxf(24, fminf(rowh, (SMALL_Y - 4 - y0) / rows));
	int big = 0, sm = 0;
	for (int i = 0; i < n && !keys; i++) {
		btn_t *b = &btns[i];
		if (small[i] || log) {
			float w = (BOT_W - 8 - (nsmall - 1) * 4) / (float)nsmall;
			if (w > 150) w = 150;
			float total = nsmall * w + (nsmall - 1) * 4;
			b->x = (BOT_W - total) / 2 + sm++ * (w + 4);
			b->y = SMALL_Y;
			b->w = w;
			b->h = 30;
		} else if (grid) {
			b->x = 4 + (big % 2) * 158;
			b->y = y0 + (big / 2) * rowh;
			b->w = 154;
			b->h = rowh - 4;
			big++;
		} else {
			b->x = 20;
			b->y = y0 + big * rowh;
			b->w = BOT_W - 40;
			b->h = rowh - 6;
			big++;
		}
	}
	// Keep the focus when the same buttons are shown again; reset it otherwise.
	char sig[sizeof btn_sig] = "";
	for (int i = 0; i < n; i++) strncat(sig, btns[i].id, sizeof sig - strlen(sig) - 1);
	if (strcmp(sig, btn_sig)) {
		strcpy(btn_sig, sig);
		sel = 0;
		while (sel < n - 1 && !btns[sel].enabled) sel++;
	}
	if (sel >= n) sel = n ? n - 1 : 0;
}

static void draw_bottom(JSValue view) {
	char title[128], label[64], sub[64], path[64], body[512];
	rect(0, 0, BOT_W, 26, PANEL);
	rect(0, 26, BOT_W, 2, ACCENT);
	text(BOT_W / 2, 5, 0.5f, WHITE, C2D_AlignCenter, 0, jsv_str(view, "title", title, sizeof title));

	// Notice text sits under the title; the buttons start below it.
	float y0 = 32;
	if (jsv_str(view, "text", body, sizeof body)[0]) {
		int color = jsv_int(view, "textColor", 0xffb3a8); // notices are pink unless the screen says otherwise
		text(12, 30, 0.42f, RGB(color), C2D_WordWrap, BOT_W - 24, body);
		y0 = fminf(140, 32 + text_rows(body, BOT_W - 24) * 14 + 6);
	}
	JSValue list = jsv_get(view, "buttons");
	layout_buttons(view, list, y0);

	// Battle log in the space left between the big buttons and the small row (the whole screen in
	// the log layout): newest line at the bottom, older ones above it until the space runs out.
	JSValue log = jsv_get(view, "log");
	int nlog = jsv_len(log);
	if (nlog) {
		float top = y0;
		for (int i = 0; i < nbtns; i++) if (btns[i].y < SMALL_Y) top = fmaxf(top, btns[i].y + btns[i].h);
		char line[256], k[12];
		float y = SMALL_Y - 6;
		for (int i = nlog - 1; i >= 0; i--) {
			snprintf(k, sizeof k, "%d", i);
			jsv_str(log, k, line, sizeof line);
			const char *s = line[0] == 1 ? line + 1 : line; // \x01 marks a chat line
			y -= text_rows(s, BOT_W - 16) * 14 + 6;
			if (y < top) break;
			text(8, y, 0.43f, line[0] == 1 ? CHAT : i == nlog - 1 ? WHITE : MUTED, C2D_WordWrap, BOT_W - 16, s);
		}
	}
	jsv_free(log);

	for (int i = 0; i < nbtns; i++) {
		JSValue b = jsv_idx(list, i);
		btn_t *r = &btns[i];
		bool small = jsv_bool(b, "small", false);
		int color = jsv_int(b, "color", -1);
		u32 fill = !r->enabled ? BTN_OFF : color >= 0 ? RGB(color) : small ? BTN_SMALL : BTN;
		float rad = fminf(6, r->h / 3);
		if (i == sel) round_rect(r->x - 2, r->y - 2, r->w + 4, r->h + 4, rad + 2, FOCUS);
		else round_rect(r->x, r->y + 2, r->w, r->h, rad, SHADOW);
		round_rect(r->x, r->y, r->w, r->h, rad, fill);
		if (color >= 0 && r->enabled) round_rect(r->x + 4, r->y + r->h - 5, r->w - 8, 3, 1.5f, C2D_Color32(0, 0, 0, 0x50));
		jsv_str(b, "label", label, sizeof label);
		jsv_str(b, "sub", sub, sizeof sub);
		u32 ink = r->enabled ? WHITE : MUTED;
		float tx = r->x + r->w / 2;
		if (jsv_str(b, "sprite", path, sizeof path)[0]) {
			draw_sprite(path, "", r->x + 24, r->y + r->h + 4, 0.5f, 44);
			tx = r->x + 50 + (r->w - 50) / 2;
			int pct = jsv_int(b, "pct", 0);
			rect(r->x + 52, r->y + r->h - 7, r->w - 58, 4, RGB(0x505860));
			rect(r->x + 52, r->y + r->h - 7, (r->w - 58) * pct / 100.0f, 4, hp_color(pct));
		}
		if (sub[0]) {
			// Two lines centred as a pair: works for the 30-58 px button heights in use.
			text(tx, r->y + r->h / 2 - (small ? 14 : 16), small ? 0.42f : 0.5f, ink, C2D_AlignCenter, 0, label);
			text(tx, r->y + r->h / 2 + 2, 0.38f, ink, C2D_AlignCenter, 0, sub);
		} else {
			text(tx, r->y + r->h / 2 - (small ? 8 : 10), small ? 0.45f : 0.55f, ink, C2D_AlignCenter, 0, label);
		}
		jsv_free(b);
	}
	jsv_free(list);
}

void ui_draw(C3D_RenderTarget *top, C3D_RenderTarget *bottom) {
	C2D_TextBufClear(tbuf);
	JSValue view = js_view();
	sound_on = jsv_bool(view, "sound", true);
	char track[16];
	sound_music(jsv_str(view, "music", track, sizeof track));
	JSValue topv = jsv_get(view, "top");
	C2D_TargetClear(top, RGB(0x0e1426));
	C2D_SceneBegin(top);
	char detail[256] = "";
	if (sel < nbtns) { // the highlighted button's details (party screens)
		JSValue btns_v = jsv_get(view, "buttons"), b = jsv_idx(btns_v, sel);
		jsv_str(b, "detail", detail, sizeof detail);
		jsv_free(b);
		jsv_free(btns_v);
	}
	if (jsv_is(topv)) draw_top_battle(topv, detail);
	else draw_top_title();
	jsv_free(topv);
	C2D_TargetClear(bottom, BG_BOTTOM);
	C2D_SceneBegin(bottom);
	draw_bottom(view);
	jsv_free(view);
}

void ui_draw_message(C3D_RenderTarget *top, C3D_RenderTarget *bottom, const char *title, const char *body) {
	C2D_TextBufClear(tbuf);
	C2D_TargetClear(top, RGB(0x0e1426));
	C2D_SceneBegin(top);
	draw_top_title();
	C2D_TargetClear(bottom, BG_BOTTOM);
	C2D_SceneBegin(bottom);
	rect(0, 0, BOT_W, 26, PANEL);
	text(BOT_W / 2, 5, 0.5f, WHITE, C2D_AlignCenter, 0, title);
	text(10, 34, 0.42f, WHITE, C2D_WordWrap, BOT_W - 20, body);
}

// Nearest enabled button in a direction, so the D-pad works the same on lists, grids and the keyboard.
static void move_sel(int dx, int dy) {
	if (sel >= nbtns) return;
	float cx = btns[sel].x + btns[sel].w / 2, cy = btns[sel].y + btns[sel].h / 2, best = 1e9f;
	int found = -1;
	for (int i = 0; i < nbtns; i++) {
		if (i == sel || !btns[i].enabled) continue;
		float bx = btns[i].x + btns[i].w / 2 - cx, by = btns[i].y + btns[i].h / 2 - cy;
		float along = dx * bx + dy * by, across = fabsf(dx * by - dy * bx);
		if (along < 1 || along + 3 * across >= best) continue;
		best = along + 3 * across;
		found = i;
	}
	if (found >= 0) sel = found;
}

void ui_input(u32 down, const touchPosition *touch) {
	if (down & KEY_TOUCH) {
		for (int i = 0; i < nbtns; i++) {
			btn_t *b = &btns[i];
			if (touch->px >= b->x && touch->px < b->x + b->w && touch->py >= b->y && touch->py < b->y + b->h) {
				sel = i;
				if (b->enabled) {
					if (sound_on) sound_play("select");
					js_select(b->id);
				}
				return;
			}
		}
		// Tapping anywhere else advances the battle text, like pressing A.
		for (int i = 0; i < nbtns; i++)
			if (!strcmp(btns[i].id, "skip")) js_select("skip");
		return;
	}
	if (down & KEY_DOWN) move_sel(0, 1);
	if (down & KEY_UP) move_sel(0, -1);
	if (down & KEY_RIGHT) move_sel(1, 0);
	if (down & KEY_LEFT) move_sel(-1, 0);
	if (down & KEY_L) js_select("log-older");
	if (down & KEY_R) js_select("log-newer");
	if ((down & KEY_A) && sel < nbtns && btns[sel].enabled) {
		if (sound_on) sound_play("select");
		js_select(btns[sel].id);
	}
	if (down & KEY_B) js_back();
}
