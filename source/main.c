// Showdown 3DS: an unofficial Pokemon Showdown client and offline COM battler.
// The app logic is JavaScript (romfs/js) running in QuickJS; this file is the 3DS host loop.
#include <3ds.h>
#include <citro2d.h>
#include <dirent.h>
#include <malloc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "js.h"
#include "net.h"
#include "sound.h"

#define TICKS_MS (SYSCLOCK_ARM11 / 1000)
#include "sprites.h"
#include "tls.h"
#include "ui.h"

#define DATA_DIR "sdmc:/3ds/showdown3ds"
#define SOC_SIZE 0x100000

// QuickJS recursion in the battle engine needs far more than the default 32 KB.
u32 __stacksize__ = 1024 * 1024;

static ws_t ws = {.fd = -1};
static bool quit;
static volatile bool woke; // set when the console wakes from sleep (lid opened)

static void on_apt(APT_HookType hook, void *param) {
	if (hook == APTHOOK_ONWAKEUP) woke = true;
}
static C3D_RenderTarget *top, *bottom;

static void on_ws(const char *msg, size_t len, void *user) { js_net_event("message", msg, len); }

static void message_frame(const char *title, const char *body) {
	C3D_FrameBegin(C3D_FRAME_SYNCDRAW);
	ui_draw_message(top, bottom, title, body);
	C3D_FrameEnd(0);
}

static void keyboard(const char *tag, const char *hint, const char *initial, int max, bool hidden) {
	SwkbdState kb;
	char buf[1024] = ""; // UTF-8: up to 4 bytes per character
	swkbdInit(&kb, SWKBD_TYPE_NORMAL, 2, max > 0 && max <= 200 ? max : 200);
	swkbdSetHintText(&kb, hint);
	swkbdSetInitialText(&kb, initial);
	swkbdSetValidation(&kb, SWKBD_NOTEMPTY_NOTBLANK, 0, 0);
	if (hidden) swkbdSetPasswordMode(&kb, SWKBD_PASSWORD_HIDE_DELAY);
	SwkbdButton pressed = swkbdInputText(&kb, buf, sizeof buf);
	js_keyboard_done(tag, pressed == SWKBD_BUTTON_CONFIRM ? buf : NULL);
	memset(buf, 0, sizeof buf); // may have held a password
}

// Deletes the files in dir and, one level down, in its sub-folders (the sprite cache's style folders).
static void clear_dir(const char *dir, int depth) {
	DIR *d = opendir(dir);
	if (!d) return;
	struct dirent *e;
	char path[512];
	while ((e = readdir(d))) {
		if (e->d_name[0] == '.') continue;
		snprintf(path, sizeof path, "%s/%s", dir, e->d_name);
		if (remove(path) != 0 && depth > 0) clear_dir(path, depth - 1);
	}
	closedir(d);
}

static void on_cmd(int argc, const char **argv) {
	const char *c = argv[0];
	if (!strcmp(c, "ws_open") && argc >= 4) {
		const char *err = NULL;
		ws_close(&ws);
		if (ws_connect(&ws, argv[1], atoi(argv[2]), argv[3], &err) == 0) js_net_event("open", NULL, 0);
		else js_net_event("closed", err, strlen(err));
	} else if (!strcmp(c, "ws_send") && argc >= 2) {
		ws_send(&ws, argv[1], strlen(argv[1]));
	} else if (!strcmp(c, "ws_close")) {
		ws_close(&ws);
		js_net_event("closed", NULL, 0);
	} else if (!strcmp(c, "http_get") && argc >= 3) {
		int status;
		char *body;
		size_t len;
		if (http_get(argv[2], &status, &body, &len) < 0) js_http_done(argv[1], 0, NULL, 0, NULL);
		else {
			js_http_done(argv[1], status, body, len, NULL);
			free(body);
		}
	} else if (!strcmp(c, "https") && argc >= 5) { // tag, url, form body ("" = GET), cookie
		int status;
		char *body, cookies[1024];
		size_t len;
		const char *err = "";
		if (https_request(argv[2], argv[3][0] ? argv[3] : NULL, argv[4], &status, &body, &len, cookies, sizeof cookies, &err) < 0)
			js_http_done(argv[1], 0, err, strlen(err), NULL);
		else {
			js_http_done(argv[1], status, body, len, cookies);
			free(body);
		}
	} else if (!strcmp(c, "keyboard") && argc >= 5) {
		keyboard(argv[1], argv[2], argv[3], atoi(argv[4]), argc > 5 && !strcmp(argv[5], "password"));
	} else if (!strcmp(c, "clear_cache")) {
		clear_dir(DATA_DIR "/sprites", 1);
	} else if (!strcmp(c, "exit")) {
		quit = true;
	}
}

int main(void) {
	gfxInitDefault();
	C3D_Init(C3D_DEFAULT_CMDBUF_SIZE);
	C2D_Init(C2D_DEFAULT_MAX_OBJECTS);
	C2D_Prepare();
	top = C2D_CreateScreenTarget(GFX_TOP, GFX_LEFT);
	bottom = C2D_CreateScreenTarget(GFX_BOTTOM, GFX_LEFT);
	Result romfs_rc = romfsInit();
	osSetSpeedupEnable(true); // New 3DS: faster CPU; no effect on Old 3DS/2DS
	ui_init();
	mkdir("sdmc:/3ds", 0777);
	mkdir(DATA_DIR, 0777);
	mkdir(DATA_DIR "/teams", 0777);

	u32 *soc_buf = memalign(0x1000, SOC_SIZE);
	bool net_ok = soc_buf && R_SUCCEEDED(socInit(soc_buf, SOC_SIZE));
	sprites_init(DATA_DIR "/sprites");
	tls_set_ca_file("romfs:/data/cacert.pem");
	bool sound_ok = sound_init(); // needs sdmc:/3ds/dspfirm.cdc

	message_frame("Loading...", "Starting up.");
	if (!js_init("romfs:/js", "romfs:/data/client.json", DATA_DIR)) {
		// Details for a bug report: how the app was launched and what its romfs holds.
		char diag[1024];
		int n = snprintf(diag, sizeof diag, "%s\n\nromfsInit 0x%08lX, launched as %s\nromfs:/ has:", js_error(),
			romfs_rc, envIsHomebrew() ? "3dsx" : "cia");
		DIR *d = opendir("romfs:/");
		struct dirent *e;
		while (d && (e = readdir(d)) && n < (int)sizeof diag - 40) n += snprintf(diag + n, sizeof diag - n, " %s", e->d_name);
		if (d) closedir(d);
		else snprintf(diag + n, sizeof diag - n, " (can't open)");
		while (aptMainLoop()) {
			hidScanInput();
			if (hidKeysDown() & KEY_START) break;
			message_frame("Showdown 3DS couldn't start (START to exit)", diag);
		}
		goto done;
	}
	// Memory split on this console, for tuning the sprite limits (sprites.c) from a real log.
	if (!sound_ok) js_log("sound: off (no DSP firmware at sdmc:/3ds/dspfirm.cdc)");
	js_log("memory: heap %lu KB, linear %lu KB (free %lu KB), JS %lu KB", (unsigned long)(envGetHeapSize() / 1024),
		(unsigned long)(envGetLinearHeapSize() / 1024), (unsigned long)(linearSpaceFree() / 1024), (unsigned long)(js_memory_used() / 1024));

	aptHookCookie apt_cookie;
	aptHook(&apt_cookie, on_apt, NULL);
	while (aptMainLoop() && !quit) {
		// Sleep kills the Wi-Fi connection: drop the socket so the app reconnects (and rejoins a battle).
		if (woke) {
			woke = false;
			if (ws.fd >= 0) {
				ws_close(&ws);
				js_net_event("closed", "woke from sleep", 15);
			}
		}
		u64 t0 = svcGetSystemTick();
		hidScanInput();
		u32 down = hidKeysDown();
		touchPosition touch;
		hidTouchRead(&touch);
		ui_input(down, &touch);
		js_tick(osGetTime());
		u64 tj = svcGetSystemTick();
		if (ws.fd >= 0 && ws_poll(&ws, on_ws, NULL) < 0) js_net_event("closed", NULL, 0);
		sprites_update();

		u64 t1 = svcGetSystemTick();
		C3D_FrameBegin(C3D_FRAME_SYNCDRAW);
		ui_draw(top, bottom);
		C3D_FrameEnd(0);
		u64 t2 = svcGetSystemTick();
		// After drawing, so a "Connecting..." screen is visible while blocking calls run.
		js_take_commands(on_cmd);
		u64 t3 = svcGetSystemTick();
		// Slow-frame diagnostics for log.txt (first 300 of them).
		static int slow_lines;
		if (t3 - t0 > 100 * TICKS_MS && slow_lines++ < 300) {
			js_log("slow frame: %lu ms (js %lu, net+sprites %lu, draw %lu, commands %lu) on %s, JS %lu KB, linear free %lu KB",
				(unsigned long)((t3 - t0) / TICKS_MS), (unsigned long)((tj - t0) / TICKS_MS), (unsigned long)((t1 - tj) / TICKS_MS),
				(unsigned long)((t2 - t1) / TICKS_MS), (unsigned long)((t3 - t2) / TICKS_MS), ui_layout(),
				(unsigned long)(js_memory_used() / 1024), (unsigned long)(linearSpaceFree() / 1024));
		}
	}
	ws_close(&ws);
	// Same line as at startup: the two together show what a session's battles cost.
	js_log("memory at exit: linear free %lu KB, JS %lu KB", (unsigned long)(linearSpaceFree() / 1024), (unsigned long)(js_memory_used() / 1024));
	js_quit();
done:
	sound_exit();
	sprites_exit();
	if (net_ok) socExit();
	ui_exit();
	romfsExit();
	C2D_Fini();
	C3D_Fini();
	gfxExit();
	return 0;
}
