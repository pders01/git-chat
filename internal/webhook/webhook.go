// Package webhook sends async HTTP notifications for system events.
package webhook

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand/v2"
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

// Retry policy. Values chosen to cover typical Slack/Discord restore
// times (seconds) without hammering the endpoint when it's actually down
// for longer. With maxAttempts=3 and baseBackoff=500ms, the worst-case
// wall time is ~3 * request timeout + 1.5s of backoff.
const (
	maxAttempts  = 3
	baseBackoff  = 500 * time.Millisecond
	maxBackoff   = 5 * time.Second
	jitterFactor = 0.5 // ±50% of the computed delay
)

// Send posts an event asynchronously. Errors are logged, not returned.
// Retries on transient failures (network errors, 5xx, 429) with
// exponential backoff; 4xx responses are treated as permanent (the
// payload is malformed and the endpoint won't accept it).
func (s *Sender) Send(ctx context.Context, ev Event) {
	if ev.Timestamp == 0 {
		ev.Timestamp = time.Now().Unix()
	}
	if ev.Text == "" {
		ev.Text = formatText(ev)
	}
	body, err := json.Marshal(ev)
	if err != nil {
		log.Printf("webhook: marshal error: %v", err)
		return
	}
	go s.deliver(ctx, body)
}

// deliver runs the retry loop for a single serialized event.
func (s *Sender) deliver(ctx context.Context, body []byte) {
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if attempt > 1 {
			delay := backoffDuration(attempt - 1)
			select {
			case <-ctx.Done():
				log.Printf("webhook: canceled before attempt %d: %v", attempt, ctx.Err())
				return
			case <-time.After(delay):
			}
		}
		retryable, err := s.postOnce(ctx, body)
		if err == nil {
			return
		}
		lastErr = err
		if !retryable {
			log.Printf("webhook: permanent failure on attempt %d: %v", attempt, err)
			return
		}
	}
	log.Printf("webhook: giving up after %d attempts: %v", maxAttempts, lastErr)
}

// postOnce performs a single POST. Returns (retryable, err).
func (s *Sender) postOnce(ctx context.Context, body []byte) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return true, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
		return true, fmt.Errorf("status %d", resp.StatusCode)
	}
	if resp.StatusCode >= 300 {
		return false, fmt.Errorf("status %d", resp.StatusCode)
	}
	return false, nil
}

// backoffDuration returns the wait time before the Nth retry (1-indexed:
// attempt=1 → first retry). Exponential base with ±jitterFactor jitter,
// clamped to maxBackoff.
func backoffDuration(attempt int) time.Duration {
	base := min(baseBackoff<<(attempt-1), maxBackoff)
	jitter := 1.0 + (rand.Float64()*2-1)*jitterFactor
	return time.Duration(float64(base) * jitter)
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
		DisableKeepAlives: true, // prevent keepalive reuse bypassing per-dial SSRF check
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
