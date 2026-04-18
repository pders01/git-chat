package webhook

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
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

func TestSendRetriesOn503ThenSucceeds(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := hits.Add(1)
		if n < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	sender := newUnsafe(srv.URL)
	sender.Send(context.Background(), Event{Type: "card_invalidated", RepoID: "r"})

	// Two retries with baseBackoff=500ms and jitterFactor=0.5 mean max
	// combined backoff is ~1.5s + 1.5s = 3s. 5s timeout leaves headroom.
	deadline := time.Now().Add(5 * time.Second)
	for hits.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if got := hits.Load(); got != 3 {
		t.Fatalf("expected 3 attempts, got %d", got)
	}
}

func TestSendDoesNotRetryOn404(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	sender := newUnsafe(srv.URL)
	sender.Send(context.Background(), Event{Type: "card_invalidated", RepoID: "r"})

	// 4xx (other than 429) is permanent — wait long enough that any
	// misbehaving retry loop would hit again, then confirm it didn't.
	time.Sleep(1500 * time.Millisecond)
	if got := hits.Load(); got != 1 {
		t.Fatalf("expected 1 attempt (no retry on 404), got %d", got)
	}
}

func TestSendRetriesOn429(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := hits.Add(1)
		if n == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	sender := newUnsafe(srv.URL)
	sender.Send(context.Background(), Event{Type: "card_invalidated", RepoID: "r"})

	deadline := time.Now().Add(3 * time.Second)
	for hits.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("expected 2 attempts (initial + retry on 429), got %d", got)
	}
}

func TestSendGivesUpAfterMaxAttempts(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	sender := newUnsafe(srv.URL)
	sender.Send(context.Background(), Event{Type: "card_invalidated", RepoID: "r"})

	// Wait long enough for all retries to complete + a bit of slack.
	deadline := time.Now().Add(5 * time.Second)
	for hits.Load() < int32(maxAttempts) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if got := hits.Load(); got != int32(maxAttempts) {
		t.Fatalf("expected %d attempts, got %d", maxAttempts, got)
	}
	// And make sure it doesn't keep going.
	time.Sleep(200 * time.Millisecond)
	if got := hits.Load(); got != int32(maxAttempts) {
		t.Fatalf("expected to stop at %d attempts, got %d", maxAttempts, got)
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

func TestFormatTextCardCreated(t *testing.T) {
	text := formatText(Event{
		Type:     "card_created",
		RepoID:   "git-chat",
		Question: "How does auth work?",
	})
	if !contains(text, "git-chat") || !contains(text, "auth") {
		t.Fatalf("text missing expected content: %q", text)
	}
	if !contains(text, "New KB card") {
		t.Fatalf("text should say 'New KB card': %q", text)
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
