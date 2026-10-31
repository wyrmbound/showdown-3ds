// Mbed TLS settings on top of its defaults (MBEDTLS_USER_CONFIG_FILE). The app only needs a
// TLS client over its own sockets, with certificates parsed from memory.
#undef MBEDTLS_NET_C               // we bring our own sockets (net.c)
#undef MBEDTLS_TIMING_C
#undef MBEDTLS_FS_IO               // the CA bundle is read by our own code
#undef MBEDTLS_PSA_ITS_FILE_C      // no persistent keys
#undef MBEDTLS_PSA_CRYPTO_STORAGE_C
#ifdef __3DS__
// No OS random source on the console. HARDWARE_ALT (mbedtls_hardware_poll in tls.c, backed by the
// console's SSL service) feeds every entropy pool, including the one psa_crypto_init seeds itself
// from; without it psa_crypto_init fails with PSA_ERROR_INSUFFICIENT_ENTROPY.
#define MBEDTLS_NO_PLATFORM_ENTROPY
#define MBEDTLS_ENTROPY_HARDWARE_ALT
#define MBEDTLS_PLATFORM_MS_TIME_ALT // tls.c provides mbedtls_ms_time from the console clock
#endif
