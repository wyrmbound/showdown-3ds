// HTTPS requests (Mbed TLS), used for Showdown's password login. The server certificate is
// always checked against the bundled Mozilla root CAs and the host name.
#pragma once
#include <stddef.h>

// Path of the PEM root CA bundle; set once before the first request.
void tls_set_ca_file(const char *path);
// Blocking request to an https:// URL. body may be NULL (then GET), cookie may be NULL.
// On success *resp is malloc'd (NUL-terminated) and set_cookie holds the response's
// Set-Cookie name=value pairs ("a=1; b=2"). Returns 0, or -1 with *err set.
int https_request(const char *url, const char *body, const char *cookie, int *status,
	char **resp, size_t *len, char *set_cookie, size_t set_cookie_size, const char **err);
