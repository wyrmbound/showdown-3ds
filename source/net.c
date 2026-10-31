#include "net.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#define CLOSESOCK closesocket
#define WOULDBLOCK() (WSAGetLastError() == WSAEWOULDBLOCK)
#define sleep_ms(ms) Sleep(ms)
#else
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#define CLOSESOCK close
#define WOULDBLOCK() (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINPROGRESS)
#ifdef __3DS__
#include <3ds.h>
#define sleep_ms(ms) svcSleepThread((s64)(ms) * 1000000)
#else
#define sleep_ms(ms) usleep((ms) * 1000)
#endif
#endif

#define MAX_FRAME (8 * 1024 * 1024)
#define HTTP_TIMEOUT_S 10

int net_init(void) {
#ifdef _WIN32
	WSADATA wsa;
	return WSAStartup(MAKEWORD(2, 2), &wsa);
#else
	return 0;
#endif
}

int net_set_nonblocking(int fd, int on) {
#ifdef _WIN32
	u_long v = on;
	return ioctlsocket(fd, FIONBIO, &v);
#else
	int fl = fcntl(fd, F_GETFL, 0);
	return fcntl(fd, F_SETFL, on ? (fl | O_NONBLOCK) : (fl & ~O_NONBLOCK));
#endif
}

// getaddrinfo rather than gethostbyname: the sprite thread and the main thread both resolve names.
int net_tcp_connect(const char *host, int port) {
	struct addrinfo hints = {0}, *res = NULL;
	hints.ai_family = AF_INET;
	hints.ai_socktype = SOCK_STREAM;
	char portstr[8];
	snprintf(portstr, sizeof portstr, "%d", port);
	if (getaddrinfo(host, portstr, &hints, &res) != 0 || !res) return -1;
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd >= 0 && connect(fd, res->ai_addr, res->ai_addrlen) < 0) {
		CLOSESOCK(fd);
		fd = -1;
	}
	freeaddrinfo(res);
	return fd;
}

static int send_all(int fd, const void *buf, size_t len) {
	const char *p = buf;
	while (len) {
		int n = send(fd, p, len, 0);
		if (n < 0) {
			if (!WOULDBLOCK()) return -1;
			sleep_ms(5);
			continue;
		}
		p += n;
		len -= n;
	}
	return 0;
}

static int grow(uint8_t **buf, size_t *cap, size_t need) {
	if (need <= *cap) return 0;
	size_t n = *cap ? *cap : 4096;
	while (n < need) n *= 2;
	uint8_t *p = realloc(*buf, n);
	if (!p) return -1;
	*buf = p;
	*cap = n;
	return 0;
}

static void b64(const uint8_t *in, size_t n, char *out) {
	static const char t[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	size_t o = 0;
	for (size_t i = 0; i < n; i += 3) {
		uint32_t v = in[i] << 16 | (i + 1 < n ? in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
		out[o++] = t[v >> 18 & 63];
		out[o++] = t[v >> 12 & 63];
		out[o++] = i + 1 < n ? t[v >> 6 & 63] : '=';
		out[o++] = i + 2 < n ? t[v & 63] : '=';
	}
	out[o] = 0;
}

int ws_connect(ws_t *ws, const char *host, int port, const char *path, const char **err) {
	memset(ws, 0, sizeof *ws);
	ws->fd = net_tcp_connect(host, port);
	if (ws->fd < 0) {
		*err = "Could not reach the server";
		return -1;
	}
	uint8_t nonce[16];
	srand((unsigned)time(NULL));
	for (int i = 0; i < 16; i++) nonce[i] = rand();
	char key[32], req[512];
	b64(nonce, 16, key);
	int n = snprintf(req, sizeof req,
		"GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
		"Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", path, host, port, key);
	if (send_all(ws->fd, req, n) < 0) {
		*err = "Connection lost during handshake";
		goto fail;
	}
	// Read the response headers; anything after them is the first frame data.
	for (;;) {
		if (grow(&ws->rx, &ws->rxcap, ws->rxlen + 1025)) goto oom;
		int r = recv(ws->fd, (char *)ws->rx + ws->rxlen, 1024, 0);
		if (r <= 0) {
			*err = "Connection lost during handshake";
			goto fail;
		}
		ws->rxlen += r;
		ws->rx[ws->rxlen] = 0;
		char *end = strstr((char *)ws->rx, "\r\n\r\n");
		if (!end) {
			if (ws->rxlen > 16384) break;
			continue;
		}
		// shortcut: Sec-WebSocket-Accept isn't verified; fine for a game client on plain TCP.
		if (strncmp((char *)ws->rx, "HTTP/1.1 101", 12) != 0) break;
		size_t used = end + 4 - (char *)ws->rx;
		memmove(ws->rx, ws->rx + used, ws->rxlen - used);
		ws->rxlen -= used;
		net_set_nonblocking(ws->fd, 1);
		return 0;
	}
	*err = "The server refused the connection";
	goto fail;
oom:
	*err = "Out of memory";
fail:
	ws_close(ws);
	return -1;
}

static int send_frame(ws_t *ws, int opcode, const void *data, size_t len) {
	uint8_t hdr[14];
	size_t h = 0;
	hdr[h++] = 0x80 | opcode;
	if (len < 126) {
		hdr[h++] = 0x80 | len;
	} else if (len < 65536) {
		hdr[h++] = 0x80 | 126;
		hdr[h++] = len >> 8;
		hdr[h++] = len;
	} else {
		hdr[h++] = 0x80 | 127;
		for (int i = 7; i >= 0; i--) hdr[h++] = i < 4 ? (uint8_t)(len >> (i * 8)) : 0;
	}
	uint8_t mask[4];
	for (int i = 0; i < 4; i++) mask[i] = hdr[h++] = rand();
	uint8_t *buf = malloc(h + len);
	if (!buf) return -1;
	memcpy(buf, hdr, h);
	for (size_t i = 0; i < len; i++) buf[h + i] = ((const uint8_t *)data)[i] ^ mask[i & 3];
	int r = send_all(ws->fd, buf, h + len);
	free(buf);
	return r;
}

int ws_send(ws_t *ws, const char *text, size_t len) {
	if (ws->fd < 0) return -1;
	return send_frame(ws, 1, text, len);
}

int ws_poll(ws_t *ws, ws_msg_fn fn, void *user) {
	if (ws->fd < 0) return -1;
	for (;;) {
		if (grow(&ws->rx, &ws->rxcap, ws->rxlen + 8192)) goto closed;
		int r = recv(ws->fd, (char *)ws->rx + ws->rxlen, 8192, 0);
		if (r == 0) goto closed;
		if (r < 0) {
			if (WOULDBLOCK()) break;
			goto closed;
		}
		ws->rxlen += r;
	}
	// Parse every complete frame in the buffer.
	size_t pos = 0;
	while (ws->rxlen - pos >= 2) {
		uint8_t *f = ws->rx + pos;
		int fin = f[0] & 0x80, op = f[0] & 0x0f, masked = f[1] & 0x80;
		uint64_t len = f[1] & 0x7f;
		size_t h = 2;
		if (len == 126) {
			if (ws->rxlen - pos < 4) break;
			len = f[2] << 8 | f[3];
			h = 4;
		} else if (len == 127) {
			if (ws->rxlen - pos < 10) break;
			len = 0;
			for (int i = 2; i < 10; i++) len = len << 8 | f[i];
			h = 10;
		}
		if (len > MAX_FRAME) goto closed;
		if (masked) h += 4;
		if (ws->rxlen - pos < h + len) break;
		uint8_t *payload = f + h;
		if (masked)
			for (uint64_t i = 0; i < len; i++) payload[i] ^= f[h - 4 + (i & 3)];
		if (op == 8) goto closed;
		if (op == 9) {
			send_frame(ws, 10, payload, len);
		} else if (op == 0 || op == 1 || op == 2) {
			if (op != 0) ws->msglen = 0;
			if (grow(&ws->msg, &ws->msgcap, ws->msglen + len + 1)) goto closed;
			memcpy(ws->msg + ws->msglen, payload, len);
			ws->msglen += len;
			if (fin) {
				ws->msg[ws->msglen] = 0;
				fn((const char *)ws->msg, ws->msglen, user);
				ws->msglen = 0;
				if (ws->fd < 0) return -1; // the callback closed the socket
			}
		}
		pos += h + len;
	}
	memmove(ws->rx, ws->rx + pos, ws->rxlen - pos);
	ws->rxlen -= pos;
	return 0;
closed:
	ws_close(ws);
	return -1;
}

void ws_close(ws_t *ws) {
	if (ws->fd >= 0) CLOSESOCK(ws->fd);
	ws->fd = -1;
	free(ws->rx);
	free(ws->msg);
	ws->rx = ws->msg = NULL;
	ws->rxlen = ws->rxcap = ws->msglen = ws->msgcap = 0;
}

int http_get(const char *url, int *status, char **body, size_t *len) {
	*status = 0;
	*body = NULL;
	*len = 0;
	if (strncmp(url, "http://", 7) != 0) return -1;
	char host[128];
	const char *h = url + 7, *slash = strchr(h, '/');
	if (!slash) slash = h + strlen(h);
	size_t hl = slash - h;
	if (hl >= sizeof host) return -1;
	memcpy(host, h, hl);
	host[hl] = 0;
	int port = 80;
	char *colon = strchr(host, ':');
	if (colon) {
		*colon = 0;
		port = atoi(colon + 1);
	}
	int fd = net_tcp_connect(host, port);
	if (fd < 0) return -1;
	// HTTP/1.0 so the reply is never chunked and ends when the server closes. The socket is
	// non-blocking with short sleeps: on the 3DS all socket calls share one system session, so a
	// blocking recv here (sprite thread) would stall the websocket on the main thread.
	net_set_nonblocking(fd, 1);
	size_t reqcap = strlen(url) + 256;
	char *req = malloc(reqcap);
	if (!req) {
		CLOSESOCK(fd);
		return -1;
	}
	int n = snprintf(req, reqcap, "GET %s HTTP/1.0\r\nHost: %s\r\nUser-Agent: showdown-3ds\r\n\r\n", *slash ? slash : "/", host);
	int r = send_all(fd, req, n);
	free(req);
	if (r < 0) {
		CLOSESOCK(fd);
		return -1;
	}
	uint8_t *buf = NULL;
	size_t cap = 0, got = 0;
	time_t deadline = time(NULL) + HTTP_TIMEOUT_S;
	bool done = false;
	while (!done) {
		if (grow(&buf, &cap, got + 4097) || time(NULL) > deadline) break;
		int k = recv(fd, (char *)buf + got, 4096, 0);
		if (k > 0) got += k;
		else if (k < 0 && WOULDBLOCK()) sleep_ms(10);
		else done = true; // closed (complete reply) or error
	}
	CLOSESOCK(fd);
	if (!done) {
		free(buf);
		return -1;
	}
	buf[got] = 0;
	char *end = strstr((char *)buf, "\r\n\r\n");
	if (!end || sscanf((char *)buf, "HTTP/%*s %d", status) != 1) {
		free(buf);
		return -1;
	}
	size_t off = end + 4 - (char *)buf;
	memmove(buf, buf + off, got - off + 1);
	*body = (char *)buf;
	*len = got - off;
	return 0;
}

int net_would_block(void) { return WOULDBLOCK(); }
void net_sleep_ms(int ms) { sleep_ms(ms); }
void net_close_fd(int fd) { CLOSESOCK(fd); }
