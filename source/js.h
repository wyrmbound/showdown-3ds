// QuickJS host for the app logic in js/*.js: loads the scripts, exposes file access to them,
// and forwards input/network events to the global `app` object.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "quickjs.h"

// script_dir holds the app scripts (js/), data_dir is the SD folder.
bool js_init(const char *script_dir, const char *client_data, const char *data_dir);
void js_quit(void);
const char *js_error(void); // last error text, for the crash screen
void js_log(const char *fmt, ...); // a line in the SD card's log.txt (after js_init)

void js_tick(uint64_t now_ms);
void js_select(const char *id);
void js_back(void);
void js_keyboard_done(const char *tag, const char *text);
void js_http_done(const char *tag, int status, const char *body, size_t len, const char *cookies);
void js_net_event(const char *type, const char *data, size_t len);

// Calls fn once per queued command, e.g. {"ws_send", "|/search gen9ou"}.
typedef void (*js_cmd_fn)(int argc, const char **argv);
void js_take_commands(js_cmd_fn fn);

// Read access to app.view for the renderer. Returned JSValues must be freed with jsv_free.
JSValue js_view(void);
JSValue jsv_get(JSValue obj, const char *key);
JSValue jsv_idx(JSValue arr, int i);
int jsv_len(JSValue arr);
bool jsv_is(JSValue v); // not null/undefined
const char *jsv_str(JSValue obj, const char *key, char *buf, size_t n);
int jsv_int(JSValue obj, const char *key, int def);
bool jsv_bool(JSValue obj, const char *key, bool def);
void jsv_free(JSValue v);
size_t js_memory_used(void);
