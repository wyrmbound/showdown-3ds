// Plain-TCP websocket client and HTTP GET. Builds for the 3DS (libctru soc) and for
// Windows/POSIX hosts so it can be tested on a PC.
#pragma once
#include <stddef.h>
#include <stdint.h>

typedef struct {
	int fd;
	uint8_t *rx;     // received bytes not yet parsed into frames
	size_t rxlen, rxcap;
	uint8_t *msg;    // message being reassembled from fragments
	size_t msglen, msgcap;
} ws_t;

// Called with each complete text message (NUL-terminated, len excludes the NUL).
typedef void (*ws_msg_fn)(const char *msg, size_t len, void *user);

int net_init(void);
// Blocking connect + handshake. Returns 0 or sets *err to a short reason.
int ws_connect(ws_t *ws, const char *host, int port, const char *path, const char **err);
// Non-blocking. Returns 0 while open, -1 once the connection is closed.
int ws_poll(ws_t *ws, ws_msg_fn fn, void *user);
int ws_send(ws_t *ws, const char *text, size_t len);
void ws_close(ws_t *ws);
// Blocking HTTP/1.0 GET of an http:// URL. *body is malloc'd (NUL-terminated); caller frees.
int http_get(const char *url, int *status, char **body, size_t *len);

// Socket helpers shared with tls.c.
int net_tcp_connect(const char *host, int port); // blocking connect; -1 on failure
int net_set_nonblocking(int fd, int on);
int net_would_block(void);                       // last send/recv failed only because it would block
void net_sleep_ms(int ms);
void net_close_fd(int fd);
