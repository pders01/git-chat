// Package webhook sends async HTTP notifications for system events.
package webhook

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"time"
)

// Event describes something that happened in the system.
type Event struct {
	Type      string `json:"type"`
	RepoID    string `json:"repo_id"`
	CardID    string `json:"card_id,omitempty"`
	Question  string `json:"question,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Path      string `json:"path,omitempty"`
	Timestamp int64  `json:"timestamp"`
	// Text is a Slack/Discord-compatible message summary.
	Text string `json:"text"`
}

// Sender posts events to a webhook URL.
type Sender struct {
	url    string
	client *http.Client
}

// New creates a Sender. Returns nil if url is empty (disabled).
// The URL is validated to prevent SSRF: only http(s) schemes are
// allowed and connections to private/loopback/link-local addresses
// are blocked at dial time.
func New(url string) *Sender {
	if url == "" {
		return nil
	}
	if err := validateWebhookURL(url); err != nil {
		log.Printf("webhook: invalid URL %q: %v (disabled)", url, err)
		return nil
	}
	return &Sender{
		url: url,
		client: &http.Client{
			Timeout:   10 * time.Second,
			Transport: ssrfSafeTransport(),
		},
	}
}

// newUnsafe creates a Sender without SSRF protection. Used only in tests
// where the webhook target is a local httptest server.
func newUnsafe(url string) *Sender {
	return &Sender{
		url:    url,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// Send posts an event asynchronously. Errors are logged, not returned.
func (s *Sender) Send(_ context.Context, ev Event) {
	if ev.Timestamp == 0 {
		ev.Timestamp = time.Now().Unix()
	}
	if ev.Text == "" {
		ev.Text = formatText(ev)
	}
	go func() {
		body, err := json.Marshal(ev)
		if err != nil {
			log.Printf("webhook: marshal error: %v", err)
			return
		}
		resp, err := s.client.Post(s.url, "application/json", bytes.NewReader(body))
		if err != nil {
			log.Printf("webhook: POST error: %v", err)
			return
		}
		resp.Body.Close()
		if resp.StatusCode >= 300 {
			log.Printf("webhook: POST returned %d", resp.StatusCode)
		}
	}()
}

func formatText(ev Event) string {
	switch ev.Type {
	case "card_invalidated":
		return fmt.Sprintf("KB card invalidated in *%s*\n> %s\n> Reason: `%s` %s",
			ev.RepoID, ev.Question, ev.Path, ev.Reason)
	default:
		return fmt.Sprintf("[%s] %s", ev.Type, ev.RepoID)
	}
}

// validateWebhookURL checks that the URL is well-formed and uses an
// allowed scheme.
func validateWebhookURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("unsupported scheme %q (only http/https allowed)", u.Scheme)
	}
	if u.Host == "" {
		return fmt.Errorf("empty host")
	}
	return nil
}

// ssrfSafeTransport returns an http.Transport that blocks connections
// to private, loopback, and link-local addresses. This prevents the
// webhook from being used to probe internal networks.
func ssrfSafeTransport() *http.Transport {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	return &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			for _, ip := range ips {
				if isPrivateIP(ip.IP) {
					return nil, fmt.Errorf("webhook: blocked connection to private address %s", ip.IP)
				}
			}
			// Connect to the first allowed resolved address.
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		},
	}
}

// isPrivateIP returns true for loopback, private (RFC 1918), link-local,
// and cloud metadata addresses.
func isPrivateIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsPrivate() {
		return true
	}
	// AWS/GCP/Azure metadata service.
	if ip.Equal(net.ParseIP("169.254.169.254")) {
		return true
	}
	return false
}
