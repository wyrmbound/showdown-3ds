// Draws app.view on both screens and turns buttons/touch into app.select() calls.
#pragma once
#include <3ds.h>
#include <citro2d.h>

void ui_init(void);
void ui_exit(void);
void ui_input(u32 down, const touchPosition *touch);
void ui_draw(C3D_RenderTarget *top, C3D_RenderTarget *bottom);
// Single full-screen message (startup, fatal errors) without a JS view.
void ui_draw_message(C3D_RenderTarget *top, C3D_RenderTarget *bottom, const char *title, const char *body);
