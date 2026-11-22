package r2

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// Signature returns hex(HMAC-SHA256(secret, key + "\n" + exp)), where exp is
// unix seconds in base 10. This is exactly what the object-store Worker
// (packages/cloudflare/src/shared/signing.ts) verifies; a shared test vector
// in both test suites pins the two together.
func Signature(secret, key string, exp int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(key + "\n" + strconv.FormatInt(exp, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}

// Sign builds a read URL for key on the object-store Worker at baseURL,
// valid until exp:
//
//	{baseURL}/objects/{key}?exp={unix}&sig={hex}
//
// baseURL is the Worker origin (R2_WORKER_URL); trailing slashes are ignored.
// exp is truncated to whole seconds. Sign does not validate key; the Worker
// rejects a malformed one with 400.
func Sign(baseURL, secret, key string, exp time.Time) string {
	unix := exp.Unix()
	return strings.TrimRight(baseURL, "/") + "/objects/" + key +
		"?exp=" + strconv.FormatInt(unix, 10) + "&sig=" + Signature(secret, key, unix)
}

// signedURL is the shared SignedURL implementation for both Store types.
func signedURL(baseURL, secret, key string, ttl time.Duration) (string, error) {
	if baseURL == "" || secret == "" {
		return "", ErrSigningNotConfigured
	}
	if err := validateKey(key); err != nil {
		return "", err
	}
	if ttl <= 0 {
		ttl = time.Second
	}
	// exp = now + ceil(ttl), in whole seconds, like signObjectUrlFor in TS.
	secs := int64((ttl + time.Second - 1) / time.Second)
	return Sign(baseURL, secret, key, time.Unix(time.Now().Unix()+secs, 0)), nil
}
