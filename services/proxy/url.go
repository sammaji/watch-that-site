package main

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

var blockedNets = []*net.IPNet{
	parseCIDR("127.0.0.0/8"),    // IPv4 loopback
	parseCIDR("10.0.0.0/8"),     // RFC1918
	parseCIDR("172.16.0.0/12"),  // RFC1918
	parseCIDR("192.168.0.0/16"), // RFC1918
	parseCIDR("169.254.0.0/16"), // Link-local
	parseCIDR("::1/128"),        // IPv6 loopback
	parseCIDR("fe80::/10"),      // IPv6 link-local
	parseCIDR("fc00::/7"),       // IPv6 unique local addr
}

const (
	apiProxyPrefix = "/api/v1/proxy"
)

// parseCIDR converts a trusted CIDR literal into an IP network used by the SSRF guard.
func parseCIDR(s string) *net.IPNet {
	_, n, _ := net.ParseCIDR(s)
	return n
}

// isBlockedIP performs a DNS lookup on the provided host and checks if any
// resulting IP addresses fall within the restricted ranges defined in blockedNets.
func isBlockedIP(host string) (bool, error) {
	ips, err := net.LookupIP(host)
	if err != nil {
		return false, err
	}
	for _, ip := range ips {
		for _, block := range blockedNets {
			if block.Contains(ip) {
				return true, nil
			}
		}
	}
	return false, nil
}

// buildTargetURL constructs a URL from the provided components and performs
// security validation. It ensures the scheme is web-safe and that the host
// does not resolve to restricted private or loopback IP addresses.
func buildTargetURL(scheme, host, path, query string) (*url.URL, error) {
	if scheme != "http" && scheme != "https" {
		return nil, errors.New("scheme must be http or https")
	}
	if path == "" {
		path = "/"
	}
	u := &url.URL{
		Scheme:   scheme,
		Host:     host,
		Path:     path,
		RawQuery: query,
	}
	if !allowPrivateTargets() {
		blocked, err := isBlockedIP(u.Hostname())
		if err != nil {
			return nil, fmt.Errorf("failed to resolve host: %w", err)
		}
		if blocked {
			return nil, errors.New("target resolves to a restricted network address")
		}
	}
	return u, nil
}

// allowPrivateTargets reports whether local/private targets are enabled for development.
func allowPrivateTargets() bool {
	return os.Getenv("ALLOW_PRIVATE_TARGETS") == "true"
}

// recordRequested reports whether the request opted into a recording session via
// ?record=true. The query is forwarded to the origin unchanged.
func recordRequested(query string) bool {
	values, err := url.ParseQuery(query)
	if err != nil {
		return false
	}
	record, _ := strconv.ParseBool(values.Get("record"))
	return record
}

// getProxyPath returns the browser-facing proxy path for the provided target URL.
// eg, https://example.com/foo/bar?baz=qux becomes /api/v1/proxy/https/example.com/foo/bar?baz=qux
func getProxyPath(target *url.URL) string {
	p := target.Path
	if p == "/" {
		p = ""
	} else if p != "" && p[0] != '/' {
		p = "/" + p
	}
	s := fmt.Sprintf("%s/%s/%s%s", apiProxyPrefix, target.Scheme, target.Host, p)
	if target.RawQuery != "" {
		s += "?" + target.RawQuery
	}
	return s
}

// getAbsURL resolves a document URL attribute against the target page while ignoring non-network schemes.
func getAbsURL(value string, base *url.URL) (*url.URL, bool) {
	v := strings.TrimSpace(value)
	if v == "" || strings.HasPrefix(v, "#") {
		return nil, false
	}
	u, err := url.Parse(v)
	if err != nil {
		return nil, false
	}
	switch u.Scheme {
	case "data", "blob", "javascript", "mailto", "tel":
		return nil, false
	}
	if u.IsAbs() {
		return u, true
	}
	if base != nil {
		return base.ResolveReference(u), true
	}
	return nil, false
}

// rewriteProxyAttr converts an attribute URL into the equivalent proxied URL when it should be fetched through us.
func rewriteProxyAttr(value string, base *url.URL) (string, bool) {
	if abs, ok := getAbsURL(value, base); ok {
		return getProxyPath(abs), true
	}
	return "", false
}
