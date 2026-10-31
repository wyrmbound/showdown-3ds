// PC test harness: runs the 3DS app's C glue (js.c, net.c) without graphics and plays like a
// random player by reading app.view through the same jsv_* accessors the renderer uses.
//   host_main com <format> [team]          COM battle (team: rental | team-0 ...)
//   host_main online <host:port> <name>    log in (no login server) and play one random battle
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
#include <windows.h>
#define sleep_ms(ms) Sleep(ms)
#else
#include <unistd.h>
#define sleep_ms(ms) usleep((ms) * 1000)
#endif
#include "js.h"
#include "net.h"
#include "tls.h"

static ws_t ws = {.fd = -1};
static int want_exit;
static const char *name_answer = "Host Tester";

static int trace;
static void on_ws(const char *msg, size_t len, void *user) {
	if (trace) printf("<< %.300s\n", msg);
	js_net_event("message", msg, len);
}

static void on_cmd(int argc, const char **argv) {
	const char *c = argv[0];
	if (!strcmp(c, "ws_open")) {
		const char *err = NULL;
		if (ws_connect(&ws, argv[1], atoi(argv[2]), argv[3], &err) == 0) js_net_event("open", NULL, 0);
		else js_net_event("closed", err, strlen(err));
	} else if (!strcmp(c, "ws_send")) {
		if (trace) printf(">> %s\n", argv[1]);
		ws_send(&ws, argv[1], strlen(argv[1]));
	} else if (!strcmp(c, "ws_close")) {
		ws_close(&ws);
		js_net_event("closed", NULL, 0);
	} else if (!strcmp(c, "http_get")) {
		int status;
		char *body;
		size_t len;
		if (http_get(argv[2], &status, &body, &len) < 0) js_http_done(argv[1], 0, NULL, 0, NULL);
		else {
			js_http_done(argv[1], status, body, len, NULL);
			free(body);
		}
	} else if (!strcmp(c, "https")) {
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
	} else if (!strcmp(c, "keyboard")) {
		// A password prompt means the name is registered: the harness has no password, so cancel.
		js_keyboard_done(argv[1], !strcmp(argv[1], "password") ? getenv("SD3DS_PASSWORD") : name_answer);
	} else if (!strcmp(c, "exit")) {
		want_exit = 1;
	}
}

// One decision per call, from what's on screen. Returns 1 once a battle has finished.
static int play(int online) {
	JSValue v = js_view();
	char screen[32], id[32], layout[16];
	jsv_str(v, "screen", screen, sizeof screen);
	jsv_str(v, "layout", layout, sizeof layout);
	static char last[160];
	char title[128], now_s[160];
	snprintf(now_s, sizeof now_s, "%s / %s", screen, jsv_str(v, "title", title, sizeof title));
	if (strcmp(now_s, last)) printf("[screen %.2f] %s\n", (double)clock() / CLOCKS_PER_SEC, strcpy(last, now_s));
	JSValue btns = jsv_get(v, "buttons");
	int n = jsv_len(btns), ids = 0, done = 0;
	char pick[8][32];
	for (int i = 0; i < n; i++) {
		JSValue b = jsv_idx(btns, i);
		jsv_str(b, "id", id, sizeof id);
		if (jsv_bool(b, "enabled", true) && ids < 8) strcpy(pick[ids++], id);
		jsv_free(b);
	}
	jsv_free(btns);
	jsv_free(v);
	static int searched;
	if (!strcmp(screen, "lobby") && online == 1 && !searched++) {
		js_select("search");
		js_select("gen9randombattle");
		return 0;
	}
	if (strcmp(screen, "battle") || !ids) return 0;
	for (int i = 0; i < ids; i++) {
		if (!strcmp(pick[i], "continue")) done = 1;
		if (!strcmp(pick[i], "continue") || !strcmp(pick[i], "skip")) {
			js_select(pick[i]);
			return done;
		}
	}
	const char *prefix = !strcmp(layout, "moves") ? "move" : !strcmp(layout, "party") ? "mon" : NULL;
	if (!prefix) return 0;
	int choices[8], nc = 0;
	for (int i = 0; i < ids; i++)
		if (!strncmp(pick[i], prefix, strlen(prefix))) choices[nc++] = i;
	if (nc) js_select(pick[choices[rand() % nc]]);
	return 0;
}

int main(int argc, char **argv) {
	if (argc < 3) {
		fprintf(stderr, "usage: host_main com <format> [team] | online <host:port> <name>\n");
		return 2;
	}
	setvbuf(stdout, NULL, _IONBF, 0);
	trace = getenv("SD3DS_TRACE") != NULL;
	srand((unsigned)time(NULL));
	net_init();
	tls_set_ca_file("certs/cacert.pem");
	const char *data = getenv("SD3DS_DATA") ? getenv("SD3DS_DATA") : "build-host/sd";
	if (!js_init("js", "romfs/ps", "romfs/data/client.json", data)) {
		fprintf(stderr, "init failed: %s\n", js_error());
		return 1;
	}
	if (!strcmp(argv[1], "https")) { // host_main https <url> [post-body]: one request, prints status + start of body
		int status;
		char *body, cookies[512];
		size_t len;
		const char *err = "";
		int r = https_request(argv[2], argc > 3 ? argv[3] : NULL, NULL, &status, &body, &len, cookies, sizeof cookies, &err);
		if (r < 0) printf("https: FAILED (%s)\n", err);
		else printf("https: %d, %u bytes, cookies [%s]: %.120s\n", status, (unsigned)len, cookies, body);
		free(body);
		return r < 0 ? 3 : 0;
	}
	int online = !strcmp(argv[1], "online");
	if (online) {
		char cfg[256], path[256];
		snprintf(path, sizeof path, "%s/config.txt", data);
		snprintf(cfg, sizeof cfg, "name=%s\nserver=%s\nlogin=\n", argc > 3 ? argv[3] : "Host Tester", argv[2]);
		FILE *f = fopen(path, "w");
		fputs(cfg, f);
		fclose(f);
		js_quit();
		if (!js_init("js", "romfs/ps", "romfs/data/client.json", data)) return 1;
	}
	uint64_t now = 0;
	js_tick(now);
	if (online) js_select("online");
	else {
		js_select("com");
		js_select(argv[2]);
		if (argc > 3) js_select(argv[3]);
	}
	int finished = 0;
	clock_t t0 = clock();
	for (int i = 0; i < 200000 && !finished && !want_exit; i++) {
		now += 1200;
		js_tick(now);
		js_take_commands(on_cmd);
		if (ws.fd >= 0 && ws_poll(&ws, on_ws, NULL) < 0) js_net_event("closed", NULL, 0);
		finished = play(online);
		if (online) sleep_ms(5);
		if (online && (clock() - t0) / CLOCKS_PER_SEC > 240) break;
	}
	JSValue v = js_view();
	JSValue lg = jsv_get(v, "log");
	char line[200];
	for (int i = 0; i < jsv_len(lg); i++) {
		char k[4];
		snprintf(k, sizeof k, "%d", i);
		printf("  | %s\n", jsv_str(lg, k, line, sizeof line));
	}
	jsv_free(lg);
	jsv_free(v);
	printf("%s: battle %s, JS memory %.1f MB%s%s\n", argv[1], finished ? "finished" : "NOT finished",
		js_memory_used() / 1048576.0, js_error()[0] ? ", last error: " : "", js_error());
	js_quit();
	return finished ? 0 : 1;
}
