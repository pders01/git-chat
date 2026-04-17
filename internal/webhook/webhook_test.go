package webhook

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestNewReturnsNilWhenEmpty(t *testing.T) {
	s := New("")
	if s != nil {
		t.Fatal("expected nil sender for empty URL")
	}
}

func TestNewReturnsSender(t *testing.T) {
	s := New("https://hooks.example.com/abc")
	if s == nil {
		t.Fatal("expected non-nil sender")
	}
	if s.url != "https://hooks.example.com/abc" {
		t.Fatalf("url = %q", s.url)
	}
}

func TestSendDeliversPayload(t *testing.T) {
	var mu sync.Mutex
	var received Event

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("expected application/json, got %s", r.Header.Get("Content-Type"))
		}
		mu.Lock()
		defer mu.Unlock()
		json.NewDecoder(r.Body).Decode(&received)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	sender := newUnsafe(srv.URL)
	sender.Send(context.Background(), Event{
		Type:     "card_invalidated",
		RepoID:   "git-chat",
		CardID:   "c1",
		Question: "How does auth work?",
		Reason:   "blob changed",
		Path:     "internal/auth/ssh.go",
	})

	// Wait for async goroutine.
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if received.Type != "card_invalidated" {
		t.Fatalf("type = %q, want card_invalidated", received.Type)
	}
	if received.RepoID != "git-chat" {
		t.Fatalf("repo_id = %q", received.RepoID)
	}
	if received.Timestamp == 0 {
		t.Fatal("timestamp should be auto-set")
	}
	if received.Text == "" {
		t.Fatal("text should be auto-formatted")
	}
}

func TestSendCustomText(t *testing.T) {
	var mu sync.Mutex
	var received Event

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		json.NewDecoder(r.Body).Decode(&received)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	sender := newUnsafe(srv.URL)
	sender.Send(context.Background(), Event{
		Type:   "custom",
		RepoID: "r",
		Text:   "custom message",
	})

	time.Sleep(200 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if received.Text != "custom message" {
		t.Fatalf("text = %q, want 'custom message'", received.Text)
	}
}

func TestFormatTextCardInvalidated(t *testing.T) {
	text := formatText(Event{
		Type:     "card_invalidated",
		RepoID:   "git-chat",
		Question: "How does auth work?",
		Path:     "internal/auth/ssh.go",
		Reason:   "blob changed",
	})
	if text == "" {
		t.Fatal("expected non-empty text")
	}
	if !contains(text, "git-chat") || !contains(text, "auth") {
		t.Fatalf("text missing expected content: %q", text)
	}
}

func TestFormatTextDefault(t *testing.T) {
	text := formatText(Event{Type: "unknown", RepoID: "r"})
	if text != "[unknown] r" {
		t.Fatalf("text = %q, want '[unknown] r'", text)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsImpl(s, sub))
}

func containsImpl(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
