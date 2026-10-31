#include "tls.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <winsock2.h>
#else
#include <sys/socket.h>
#endif
#include <strings.h>

#include "mbedtls/ctr_drbg.h"
#include "mbedtls/entropy.h"
#include "mbedtls/error.h"
#include "mbedtls/net_sockets.h" // error codes only
#include "mbedtls/ssl.h"
#include "mbedtls/platform_time.h"
#include "mbedtls/x509_crt.h"
#include "psa/crypto.h"

#include "net.h"

#ifdef __3DS__
#include <3ds.h>
#endif

#define TIMEOUT_S 20

static char ca_file[256];
static int ready = 0; // 0 = not tried, 1 = ok, -1 = failed
static mbedtls_entropy_context entropy;
static mbedtls_ctr_drbg_context drbg;
static mbedtls_x509_crt ca;

void tls_set_ca_file(const char *path) { snprintf(ca_file, sizeof ca_file, "%s", path); }

#ifdef __3DS__
mbedtls_ms_time_t mbedtls_ms_time(void) { return (mbedtls_ms_time_t)osGetTime(); }

// Mbed TLS's hardware entropy hook (MBEDTLS_ENTROPY_HARDWARE_ALT): the console's SSL service has a
// hardware-backed random generator. sslcInit runs in setup() before anything asks for entropy.
int mbedtls_hardware_poll(void *data, unsigned char *out, size_t len, size_t *olen) {
	*olen = 0;
	if (R_FAILED(sslcGenerateRandomData(out, len))) return MBEDTLS_ERR_ENTROPY_SOURCE_FAILED;
	*olen = len;
	return 0;
}
#endif

static char *read_file(const char *path, size_t *len) {
	FILE *f = fopen(path, "rb");
	if (!f) return NULL;
	size_t n = 0, cap = 256 * 1024;
	char *buf = malloc(cap + 1);
	while (buf) {
		n += fread(buf + n, 1, cap - n, f);
		if (n < cap) break;
		char *p = realloc(buf, cap * 2 + 1);
		if (!p) free(buf);
		buf = p;
		cap *= 2;
	}
	fclose(f);
	if (buf) buf[n] = 0;
	*len = n;
	return buf;
}

// One-time setup: random generator and the root CA bundle (slow-ish on an Old 3DS, so lazily).
static int setup(const char **err) {
	static const char *setup_err = "";
	if (ready) {
		*err = setup_err; // the first failure's reason, not a generic one
		return ready > 0 ? 0 : -1;
	}
	ready = -1;
#ifdef __3DS__
	// First: everything below draws entropy from it (mbedtls_hardware_poll).
	if (R_FAILED(sslcInit(0))) {
		*err = setup_err = "Couldn't start the console's SSL service";
		return -1;
	}
#endif
	if (psa_crypto_init() != PSA_SUCCESS) {
		*err = setup_err = "Crypto init failed (no random numbers)";
		return -1;
	}
	mbedtls_entropy_init(&entropy);
	mbedtls_ctr_drbg_init(&drbg);
	if (mbedtls_ctr_drbg_seed(&drbg, mbedtls_entropy_func, &entropy, (const unsigned char *)"showdown-3ds", 12)) {
		*err = setup_err = "No random numbers for TLS";
		return -1;
	}
	size_t len;
	char *pem = read_file(ca_file, &len);
	mbedtls_x509_crt_init(&ca);
	// x509_crt_parse wants the PEM's terminating NUL counted in the length.
	int r = pem ? mbedtls_x509_crt_parse(&ca, (const unsigned char *)pem, len + 1) : -1;
	free(pem);
	if (r < 0 || !ca.raw.len) {
		*err = setup_err = "Couldn't load the root certificates";
		return -1;
	}
	ready = 1;
	return 0;
}

typedef struct {
	int fd;
	time_t deadline;
} conn_t;

static int bio_send(void *ctx, const unsigned char *buf, size_t len) {
	conn_t *c = ctx;
	int n = send(c->fd, (const char *)buf, len, 0);
	if (n >= 0) return n;
	return net_would_block() ? MBEDTLS_ERR_SSL_WANT_WRITE : MBEDTLS_ERR_NET_SEND_FAILED;
}

static int bio_recv(void *ctx, unsigned char *buf, size_t len) {
	conn_t *c = ctx;
	int n = recv(c->fd, (char *)buf, len, 0);
	if (n >= 0) return n; // 0 = the server closed the connection
	return net_would_block() ? MBEDTLS_ERR_SSL_WANT_READ : MBEDTLS_ERR_NET_RECV_FAILED;
}

// Runs an mbedtls step that may report WANT_READ/WANT_WRITE until it completes or times out.
#define RETRY(c, call, r) \
	while (((r) = (call)) == MBEDTLS_ERR_SSL_WANT_READ || (r) == MBEDTLS_ERR_SSL_WANT_WRITE) { \
		if (time(NULL) > (c).deadline) { (r) = MBEDTLS_ERR_SSL_TIMEOUT; break; } \
		net_sleep_ms(10); \
	}

// Copies every "Set-Cookie: name=value; attrs" header's name=value into out ("a=1; b=2").
static void collect_cookies(const char *headers, char *out, size_t size) {
	out[0] = 0;
	for (const char *p = headers; (p = strstr(p, "\n")); ) {
		p++;
		if (strncasecmp(p, "set-cookie:", 11)) continue;
		p += 11;
		while (*p == ' ') p++;
		size_t n = strcspn(p, ";\r\n");
		size_t used = strlen(out);
		if (used + n + 3 < size) snprintf(out + used, size - used, "%s%.*s", used ? "; " : "", (int)n, p);
	}
}

int https_request(const char *url, const char *body, const char *cookie, int *status,
	char **resp, size_t *len, char *set_cookie, size_t set_cookie_size, const char **err) {
	*status = 0;
	*resp = NULL;
	*len = 0;
	if (set_cookie_size) set_cookie[0] = 0;
	if (strncmp(url, "https://", 8) != 0) {
		*err = "Not an https:// URL";
		return -1;
	}
	if (setup(err) < 0) return -1;
	char host[128];
	const char *h = url + 8, *slash = strchr(h, '/');
	if (!slash) slash = h + strlen(h);
	if ((size_t)(slash - h) >= sizeof host) {
		*err = "Bad URL";
		return -1;
	}
	memcpy(host, h, slash - h);
	host[slash - h] = 0;

	conn_t c = {net_tcp_connect(host, 443), time(NULL) + TIMEOUT_S};
	if (c.fd < 0) {
		*err = "Could not reach the login server";
		return -1;
	}
	// Non-blocking: on the 3DS every socket call goes through one system session, so a blocking
	// call here would also stall the websocket and the sprite downloads.
	net_set_nonblocking(c.fd, 1);

	mbedtls_ssl_config conf;
	mbedtls_ssl_context ssl;
	mbedtls_ssl_config_init(&conf);
	mbedtls_ssl_init(&ssl);
	char *req = NULL;
	unsigned char *buf = NULL;
	int ret = -1, r;
	*err = "Secure connection failed";
	if (mbedtls_ssl_config_defaults(&conf, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT))
		goto done;
	mbedtls_ssl_conf_authmode(&conf, MBEDTLS_SSL_VERIFY_REQUIRED);
	mbedtls_ssl_conf_ca_chain(&conf, &ca, NULL);
	mbedtls_ssl_conf_rng(&conf, mbedtls_ctr_drbg_random, &drbg);
	if (mbedtls_ssl_setup(&ssl, &conf) || mbedtls_ssl_set_hostname(&ssl, host)) goto done;
	mbedtls_ssl_set_bio(&ssl, &c, bio_send, bio_recv, NULL);

	RETRY(c, mbedtls_ssl_handshake(&ssl), r);
	if (r) {
		char msg[96];
		mbedtls_strerror(r, msg, sizeof msg);
		fprintf(stderr, "TLS handshake with %s failed: -0x%04x %s\n", host, -r, msg);
		*err = r == MBEDTLS_ERR_X509_CERT_VERIFY_FAILED ? "The login server's certificate didn't check out" : "Secure connection failed";
		goto done;
	}

	size_t blen = body ? strlen(body) : 0, reqcap = strlen(url) + blen + (cookie ? strlen(cookie) : 0) + 512;
	req = malloc(reqcap);
	if (!req) goto done;
	int n = snprintf(req, reqcap,
		"%s %s HTTP/1.0\r\nHost: %s\r\nUser-Agent: showdown-3ds\r\n%s%s%s%s",
		body ? "POST" : "GET", *slash ? slash : "/", host,
		cookie && *cookie ? "Cookie: " : "", cookie && *cookie ? cookie : "", cookie && *cookie ? "\r\n" : "",
		body ? "Content-Type: application/x-www-form-urlencoded\r\n" : "");
	if (body) n += snprintf(req + n, reqcap - n, "Content-Length: %u\r\n\r\n%s", (unsigned)blen, body);
	else n += snprintf(req + n, reqcap - n, "\r\n");
	for (int sent = 0; sent < n; sent += r) {
		RETRY(c, mbedtls_ssl_write(&ssl, (const unsigned char *)req + sent, n - sent), r);
		if (r <= 0) goto done;
	}
	memset(req, 0, n); // the request may hold a password

	size_t cap = 16 * 1024, got = 0;
	buf = malloc(cap + 1);
	for (;;) {
		if (!buf) goto done;
		if (got == cap) {
			unsigned char *p = cap < 4 * 1024 * 1024 ? realloc(buf, cap * 2 + 1) : NULL;
			if (!p) goto done;
			buf = p;
			cap *= 2;
		}
		RETRY(c, mbedtls_ssl_read(&ssl, buf + got, cap - got), r);
		if (r > 0) got += r;
		else if (r == 0 || r == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY || r == MBEDTLS_ERR_SSL_CONN_EOF) break;
		else if (r == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) continue; // TLS 1.3 housekeeping
		else goto done;
	}
	buf[got] = 0;
	char *end = strstr((char *)buf, "\r\n\r\n");
	if (!end || sscanf((char *)buf, "HTTP/%*s %d", status) != 1) {
		*err = "Bad reply from the login server";
		goto done;
	}
	*end = 0;
	if (set_cookie_size) collect_cookies((char *)buf, set_cookie, set_cookie_size);
	size_t off = end + 4 - (char *)buf;
	memmove(buf, buf + off, got - off + 1);
	*resp = (char *)buf;
	*len = got - off;
	buf = NULL;
	ret = 0;
done:
	mbedtls_ssl_close_notify(&ssl);
	mbedtls_ssl_free(&ssl);
	mbedtls_ssl_config_free(&conf);
	free(req);
	free(buf);
	net_close_fd(c.fd);
	return ret;
}
