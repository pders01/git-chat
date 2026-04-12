// Package webhook sends async HTTP notifications for system events.
package webhook

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
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
func New(url string) *Sender {
	if url == "" {
		return nil
	}
	return &Sender{
		url: url,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
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
