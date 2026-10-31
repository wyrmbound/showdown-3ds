#pragma once
#include <stdlib.h>
#include "3ds.h"
typedef struct { void *data; int w, h; } C3D_Tex;
typedef struct { u16 width, height; float left, top, right, bottom; } Tex3DS_SubTexture;
typedef struct { C3D_Tex *tex; const Tex3DS_SubTexture *subtex; } C2D_Image;
static inline bool C3D_TexInit(C3D_Tex *t, int w, int h, int f) { t->data = malloc(w * h * 2); t->w = w; t->h = h; return t->data != NULL; }
static inline void C3D_TexDelete(C3D_Tex *t) { free(t->data); }
static inline void C3D_TexFlush(C3D_Tex *t) {}
static inline void C3D_TexSetFilter(C3D_Tex *t, int a, int b) {}
