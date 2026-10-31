#include "js.h"

#include <dirent.h>
#include <stdarg.h>
#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static JSRuntime *rt;
static JSContext *ctx;
static JSValue app = JS_UNDEFINED;
static char last_error[512];
static FILE *log_file;

static void log_line(const char *s) {
	if (log_file) {
		fprintf(log_file, "%s\n", s);
		fflush(log_file);
	}
#ifndef __3DS__
	fprintf(stderr, "%s\n", s);
#endif
}

static void report_exception(void) {
	JSValue e = JS_GetException(ctx);
	const char *msg = JS_ToCString(ctx, e);
	JSValue stack = JS_GetPropertyStr(ctx, e, "stack");
	const char *st = JS_IsUndefined(stack) ? NULL : JS_ToCString(ctx, stack);
	snprintf(last_error, sizeof last_error, "%s\n%s", msg ? msg : "?", st ? st : "");
	log_line(last_error);
	if (st) JS_FreeCString(ctx, st);
	if (msg) JS_FreeCString(ctx, msg);
	JS_FreeValue(ctx, stack);
	JS_FreeValue(ctx, e);
}

const char *js_error(void) { return last_error; }

void js_log(const char *fmt, ...) {
	char buf[256];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(buf, sizeof buf, fmt, ap);
	va_end(ap);
	log_line(buf);
}

// Reads in chunks until EOF instead of seeking to the end for the size: doesn't depend on how
// well a filesystem driver (romfs, sdmc) supports SEEK_END/ftell.
static char *read_file(const char *path, size_t *len) {
	FILE *f = fopen(path, "rb");
	if (!f) return NULL;
	size_t n = 0, cap = 64 * 1024;
	char *buf = malloc(cap + 1);
	while (buf) {
		n += fread(buf + n, 1, cap - n, f);
		if (n < cap) break;
		char *p = realloc(buf, cap * 2 + 1);
		if (!p) {
			free(buf);
			buf = NULL;
		}
		buf = p;
		cap *= 2;
	}
	bool failed = ferror(f);
	fclose(f);
	if (!buf || failed) {
		free(buf);
		return NULL;
	}
	buf[n] = 0;
	if (len) *len = n;
	return buf;
}

static JSValue fn_read_file(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(c, argv[0]);
	if (!path) return JS_EXCEPTION;
	size_t len;
	char *buf = read_file(path, &len);
	JS_FreeCString(c, path);
	if (!buf) return JS_NULL;
	JSValue v = JS_NewStringLen(c, buf, len);
	free(buf);
	return v;
}

static JSValue fn_write_file(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(c, argv[0]);
	size_t len;
	const char *text = JS_ToCStringLen(c, &len, argv[1]);
	bool ok = false;
	if (path && text) {
		FILE *f = fopen(path, "wb");
		if (f) {
			ok = fwrite(text, 1, len, f) == len;
			fclose(f);
		}
	}
	JS_FreeCString(c, path);
	JS_FreeCString(c, text);
	return JS_NewBool(c, ok);
}

static JSValue fn_remove_file(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(c, argv[0]);
	if (!path) return JS_EXCEPTION;
	int r = remove(path);
	JS_FreeCString(c, path);
	return JS_NewBool(c, r == 0);
}

static JSValue fn_list_dir(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(c, argv[0]);
	if (!path) return JS_EXCEPTION;
	DIR *d = opendir(path);
	JS_FreeCString(c, path);
	if (!d) return JS_NULL;
	JSValue arr = JS_NewArray(c);
	int i = 0;
	struct dirent *e;
	while ((e = readdir(d))) {
		if (e->d_name[0] == '.') continue;
		JS_SetPropertyUint32(c, arr, i++, JS_NewString(c, e->d_name));
	}
	closedir(d);
	return arr;
}

static JSValue fn_log(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
	for (int i = 0; i < argc; i++) {
		const char *s = JS_ToCString(c, argv[i]);
		if (s) {
			log_line(s);
			JS_FreeCString(c, s);
		}
	}
	return JS_UNDEFINED;
}

static bool eval_file(const char *path) {
	size_t len;
	char *src = read_file(path, &len);
	if (!src) {
		snprintf(last_error, sizeof last_error, "Can't read %s (%s)", path, strerror(errno));
		log_line(last_error);
		return false;
	}
	JSValue r = JS_Eval(ctx, src, len, path, JS_EVAL_TYPE_GLOBAL);
	free(src);
	if (JS_IsException(r)) {
		report_exception();
		return false;
	}
	JS_FreeValue(ctx, r);
	return true;
}

bool js_init(const char *script_dir, const char *client_data, const char *data_dir) {
	char path[256];
	snprintf(path, sizeof path, "%s/log.txt", data_dir);
	log_file = fopen(path, "w");
	rt = JS_NewRuntime();
	JS_SetMemoryLimit(rt, 48 * 1024 * 1024);
	JS_SetMaxStackSize(rt, 768 * 1024); // the main thread gets 1 MB (__stacksize__ in main.c)
	ctx = JS_NewContext(rt);
	JSValue g = JS_GetGlobalObject(ctx);
	JS_SetPropertyStr(ctx, g, "__readFile", JS_NewCFunction(ctx, fn_read_file, "__readFile", 1));
	JS_SetPropertyStr(ctx, g, "__writeFile", JS_NewCFunction(ctx, fn_write_file, "__writeFile", 2));
	JS_SetPropertyStr(ctx, g, "__listDir", JS_NewCFunction(ctx, fn_list_dir, "__listDir", 1));
	JS_SetPropertyStr(ctx, g, "__removeFile", JS_NewCFunction(ctx, fn_remove_file, "__removeFile", 1));
	JS_SetPropertyStr(ctx, g, "__DATA", JS_NewString(ctx, data_dir));
	JS_SetPropertyStr(ctx, g, "__CLIENT_DATA", JS_NewString(ctx, client_data));
	JSValue console = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, console, "log", JS_NewCFunction(ctx, fn_log, "log", 1));
	JS_SetPropertyStr(ctx, console, "error", JS_NewCFunction(ctx, fn_log, "error", 1));
	JS_SetPropertyStr(ctx, console, "warn", JS_NewCFunction(ctx, fn_log, "warn", 1));
	JS_SetPropertyStr(ctx, g, "console", console);
	static const char *scripts[] = {"tracker.js", "app.js", "teambuilder.js"};
	bool ok = true;
	for (size_t i = 0; ok && i < sizeof scripts / sizeof *scripts; i++) {
		snprintf(path, sizeof path, "%s/%s", script_dir, scripts[i]);
		ok = eval_file(path);
	}
	if (ok) {
		JSValue r = JS_Eval(ctx, "new App()", 9, "<init>", JS_EVAL_TYPE_GLOBAL);
		if (JS_IsException(r)) {
			report_exception();
			ok = false;
		} else {
			app = r;
		}
	}
	JS_FreeValue(ctx, g);
	return ok;
}

void js_quit(void) {
	JS_FreeValue(ctx, app);
	JS_FreeContext(ctx);
	JS_FreeRuntime(rt);
	if (log_file) fclose(log_file);
}

// Calls app[method](...args) and runs pending promise jobs; errors go to the log.
static void call(const char *method, int argc, JSValue *argv) {
	JSValue fn = JS_GetPropertyStr(ctx, app, method);
	JSValue r = JS_Call(ctx, fn, app, argc, argv);
	if (JS_IsException(r)) report_exception();
	JS_FreeValue(ctx, r);
	JS_FreeValue(ctx, fn);
	for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
	JSContext *c;
	int r2;
	while ((r2 = JS_ExecutePendingJob(rt, &c)) > 0) {}
	if (r2 < 0) report_exception();
}

static JSValue str_or_null(const char *s, size_t len) { return s ? JS_NewStringLen(ctx, s, len) : JS_NULL; }

void js_tick(uint64_t now_ms) { call("tick", 1, (JSValue[]){JS_NewFloat64(ctx, (double)now_ms)}); }
void js_select(const char *id) { call("select", 1, (JSValue[]){JS_NewString(ctx, id)}); }
void js_back(void) { call("back", 0, NULL); }

void js_keyboard_done(const char *tag, const char *text) {
	call("keyboardDone", 2, (JSValue[]){JS_NewString(ctx, tag), str_or_null(text, text ? strlen(text) : 0)});
}

void js_http_done(const char *tag, int status, const char *body, size_t len, const char *cookies) {
	call("httpDone", 4, (JSValue[]){JS_NewString(ctx, tag), JS_NewInt32(ctx, status), str_or_null(body, len),
		JS_NewString(ctx, cookies ? cookies : "")});
}

void js_net_event(const char *type, const char *data, size_t len) {
	call("netEvent", 2, (JSValue[]){JS_NewString(ctx, type), str_or_null(data, len)});
}

void js_take_commands(js_cmd_fn fn) {
	JSValue take = JS_GetPropertyStr(ctx, app, "takeCommands");
	JSValue list = JS_Call(ctx, take, app, 0, NULL);
	JS_FreeValue(ctx, take);
	if (JS_IsException(list)) {
		report_exception();
		return;
	}
	int n = jsv_len(list);
	for (int i = 0; i < n; i++) {
		JSValue c = JS_GetPropertyUint32(ctx, list, i);
		int argc = jsv_len(c);
		const char *argv[8] = {0};
		if (argc > 8) argc = 8;
		for (int k = 0; k < argc; k++) {
			JSValue a = JS_GetPropertyUint32(ctx, c, k);
			argv[k] = JS_ToCString(ctx, a);
			JS_FreeValue(ctx, a);
		}
		fn(argc, argv);
		for (int k = 0; k < argc; k++) JS_FreeCString(ctx, argv[k]);
		JS_FreeValue(ctx, c);
	}
	JS_FreeValue(ctx, list);
}

JSValue js_view(void) { return JS_GetPropertyStr(ctx, app, "view"); }
JSValue jsv_get(JSValue obj, const char *key) { return JS_IsObject(obj) ? JS_GetPropertyStr(ctx, obj, key) : JS_UNDEFINED; }
JSValue jsv_idx(JSValue arr, int i) { return JS_IsObject(arr) ? JS_GetPropertyUint32(ctx, arr, i) : JS_UNDEFINED; }
bool jsv_is(JSValue v) { return !JS_IsUndefined(v) && !JS_IsNull(v); }
void jsv_free(JSValue v) { JS_FreeValue(ctx, v); }

int jsv_len(JSValue arr) {
	if (!JS_IsObject(arr)) return 0;
	int64_t n = 0;
	JS_GetLength(ctx, arr, &n);
	return (int)n;
}

const char *jsv_str(JSValue obj, const char *key, char *buf, size_t n) {
	buf[0] = 0;
	JSValue v = jsv_get(obj, key);
	if (jsv_is(v)) {
		const char *s = JS_ToCString(ctx, v);
		if (s) {
			snprintf(buf, n, "%s", s);
			JS_FreeCString(ctx, s);
		}
	}
	JS_FreeValue(ctx, v);
	return buf;
}

int jsv_int(JSValue obj, const char *key, int def) {
	JSValue v = jsv_get(obj, key);
	double d = def;
	if (jsv_is(v)) JS_ToFloat64(ctx, &d, v);
	JS_FreeValue(ctx, v);
	return (int)d;
}

bool jsv_bool(JSValue obj, const char *key, bool def) {
	JSValue v = jsv_get(obj, key);
	bool b = jsv_is(v) ? JS_ToBool(ctx, v) : def;
	JS_FreeValue(ctx, v);
	return b;
}

size_t js_memory_used(void) {
	JSMemoryUsage u;
	JS_ComputeMemoryUsage(rt, &u);
	return (size_t)u.memory_used_size;
}
