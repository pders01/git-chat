package repo

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// guardDialControl rejects connections to address ranges that have no
// legitimate use as an LLM endpoint and would let a local-principal
// caller exfiltrate sensitive data via the discovery probe. The
// notable target here is the cloud metadata service at
// 169.254.169.254, which sits in the IPv4 link-local range.
//
// We deliberately allow loopback (users commonly run Ollama/LM Studio
// on 127.0.0.1) and RFC-1918 private ranges (LAN-hosted servers).
// Callers that want to go further can layer additional checks.
func guardDialControl(network, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("parse dial address: %w", err)
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("dial target %q is not an IP after resolution", host)
	}
	switch {
	case ip.IsUnspecified():
		return fmt.Errorf("refusing to dial unspecified address %s", ip)
	case ip.IsLinkLocalUnicast(), ip.IsLinkLocalMulticast():
		return fmt.Errorf("refusing to dial link-local address %s (blocks cloud instance metadata)", ip)
	case ip.IsMulticast():
		return fmt.Errorf("refusing to dial multicast address %s", ip)
	}
	return nil
}

// guardedClient returns an http.Client whose transport refuses to
// connect to link-local, unspecified, and multicast targets. The
// guard runs after DNS resolution, so it catches attempts to reach
// blocked ranges via a hostname that resolves to them.
func guardedClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
		Control:   guardDialControl,
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext:           dialer.DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          10,
			IdleConnTimeout:       30 * time.Second,
			TLSHandshakeTimeout:   5 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
	}
}

// knownLocalPorts maps localhost ports to likely tool names.
var knownLocalPorts = []struct {
	Port int
	Name string
}{
	{1234, "LM Studio"},
	{11434, "Ollama"},
	{8080, "Local Server"},
	{5000, "Local Server"},
	{3000, "Local Server"},
}

// openAIModelsResponse is the subset of the OpenAI /v1/models response
// we need for discovery.
type openAIModelsResponse struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

// DiscoverModels queries a base URL's /models endpoint to list available
// models. Supports OpenAI-compatible APIs (including Fireworks, Groq,
// OpenRouter, etc.). The API key is sent as a Bearer token.
func DiscoverModels(ctx context.Context, baseURL, apiKey string) ([]string, error) {
	if baseURL == "" {
		return nil, fmt.Errorf("base URL is required")
	}

	client := guardedClient(10 * time.Second)

	// Normalize: strip trailing slash, ensure /models path.
	modelsURL := strings.TrimRight(baseURL, "/") + "/models"

	req, err := http.NewRequestWithContext(ctx, "GET", modelsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connect failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("authentication failed (HTTP %d) — check your API key", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected HTTP %d from %s", resp.StatusCode, modelsURL)
	}

	var models openAIModelsResponse
	if err := json.NewDecoder(resp.Body).Decode(&models); err != nil {
		return nil, fmt.Errorf("parse models response: %w", err)
	}

	var ids []string
	for _, m := range models.Data {
		if m.ID != "" {
			ids = append(ids, m.ID)
		}
	}
	sort.Strings(ids)
	return ids, nil
}

// DiscoverLocal probes known localhost ports for OpenAI-compatible
// endpoints and returns any that respond with a valid /v1/models list.
// Called on-demand (user clicks "detect local"), not automatically.
func DiscoverLocal(ctx context.Context) []*gitchatv1.LocalEndpoint {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	client := &http.Client{Timeout: 800 * time.Millisecond}

	var mu sync.Mutex
	var results []*gitchatv1.LocalEndpoint
	var wg sync.WaitGroup

	for _, probe := range knownLocalPorts {
		wg.Add(1)
		go func(port int, name string) {
			defer wg.Done()

			baseURL := fmt.Sprintf("http://localhost:%d/v1", port)
			modelsURL := baseURL + "/models"

			req, err := http.NewRequestWithContext(ctx, "GET", modelsURL, nil)
			if err != nil {
				return
			}
			resp, err := client.Do(req)
			if err != nil {
				return
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusOK {
				return
			}

			var models openAIModelsResponse
			if err := json.NewDecoder(resp.Body).Decode(&models); err != nil {
				return
			}

			var modelIDs []string
			for _, m := range models.Data {
				if m.ID != "" {
					modelIDs = append(modelIDs, m.ID)
				}
			}

			mu.Lock()
			results = append(results, &gitchatv1.LocalEndpoint{
				Url:    baseURL,
				Name:   name,
				Models: modelIDs,
			})
			mu.Unlock()
		}(probe.Port, probe.Name)
	}

	wg.Wait()
	return results
}
