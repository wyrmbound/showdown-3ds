// Compiles the vendored QuickJS-ng source as part of the 3DS build.
// v0.15.1 passes int* where it means int32_t*; on the 3DS int32_t is a (32-bit) long, so GCC 14+
// rejects it although both are the same size. Newer QuickJS fixed this; it only affects this file.
#pragma GCC diagnostic ignored "-Wincompatible-pointer-types"
#include "../../vendor/quickjs/quickjs.c"
