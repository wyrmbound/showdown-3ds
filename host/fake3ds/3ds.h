// Stand-ins for the few libctru pieces sprites.c uses, so its image code can be tested on a PC.
#pragma once
#include <stdbool.h>
#include <stdint.h>
typedef uint8_t u8; typedef uint16_t u16; typedef uint32_t u32; typedef uint64_t u64; typedef int32_t s32; typedef s32 Result;
typedef int LightLock; typedef int LightEvent; typedef void *Thread;
#define R_SUCCEEDED(r) ((r) >= 0)
#define RESET_ONESHOT 0
#define CUR_THREAD_HANDLE 0
#define GPU_RGBA5551 0
#define GPU_NEAREST 0
static inline void LightLock_Init(LightLock *l) {}
static inline void LightLock_Lock(LightLock *l) {}
static inline void LightLock_Unlock(LightLock *l) {}
static inline void LightEvent_Init(LightEvent *e, int m) {}
static inline void LightEvent_Signal(LightEvent *e) {}
static inline void LightEvent_Wait(LightEvent *e) {}
static inline Result svcGetThreadPriority(s32 *p, int h) { return 0; }
static inline Thread threadCreate(void (*f)(void *), void *a, int s, int p, int c, bool d) { return 0; }
static inline Result threadJoin(Thread t, u64 ns) { return 0; }
static inline void threadFree(Thread t) {}
static inline u64 osGetTime(void) { return 0; }
static inline u32 linearSpaceFree(void) { return 0; }
