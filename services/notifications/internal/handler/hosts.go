package handler

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// EnvInsecureWebhookHosts names hosts (comma-separated, e.g.
// "localhost,127.0.0.1") that local end-to-end tests may deliver to. For
// these hosts only, Slack and Discord webhook URLs skip their provider
// pattern, http:// is accepted, and the private-address guard is skipped.
// Unset (the default) in every deployed environment.
const EnvInsecureWebhookHosts = "NOTIFY_ALLOW_INSECURE_WEBHOOK_HOSTS"

// HostAllowlist is the parsed NOTIFY_ALLOW_INSECURE_WEBHOOK_HOSTS.
type HostAllowlist map[string]struct{}

// LoadInsecureHosts reads NOTIFY_ALLOW_INSECURE_WEBHOOK_HOSTS.
func LoadInsecureHosts() HostAllowlist { return ParseHostAllowlist(os.Getenv(EnvInsecureWebhookHosts)) }

// ParseHostAllowlist parses a comma-separated host list.
func ParseHostAllowlist(s string) HostAllowlist {
	out := HostAllowlist{}
	for _, h := range strings.Split(s, ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			out[h] = struct{}{}
		}
	}
	return out
}

// AllowsHost reports whether host (no port) is allowlisted.
func (a HostAllowlist) AllowsHost(host string) bool {
	if len(a) == 0 {
		return false
	}
	_, ok := a[strings.ToLower(strings.Trim(host, "[]"))]
	return ok
}

// AllowsURL reports whether raw is an http(s) URL on an allowlisted host.
func (a HostAllowlist) AllowsURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	return a.AllowsHost(u.Hostname())
}

// errBlockedAddress is returned when a user-supplied URL resolves to a
// private, loopback or otherwise non-public address.
var errBlockedAddress = errors.New("destination address is not public")

// newUserURLClient returns an HTTP client for user-supplied URLs: it refuses
// to connect to non-public addresses (unless the host is allowlisted), does
// not follow redirects, ignores proxy environment variables, and times out.
func newUserURLClient(allow HostAllowlist, timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			if allow.AllowsHost(host) {
				return dialer.DialContext(ctx, network, addr)
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			if len(ips) == 0 {
				return nil, fmt.Errorf("no addresses for %s", host)
			}
			for _, ip := range ips {
				if !isPublicIP(ip.IP) {
					return nil, fmt.Errorf("%w: %s resolves to %s", errBlockedAddress, host, ip.IP)
				}
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		},
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: timeout,
		MaxIdleConns:          50,
		IdleConnTimeout:       60 * time.Second,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

func isPublicIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() || ip.IsMulticast() {
		return false
	}
	if ip4 := ip.To4(); ip4 != nil && (ip4[0] == 0 || cgnat.Contains(ip4)) {
		return false
	}
	return true
}
