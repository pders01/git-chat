package auth

import (
	"context"
	"net/http"
	"os"
	"sync"
	"time"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/config"
)

// CookieName is the session cookie name. HttpOnly + SameSite=Strict.
const CookieName = "git-chat.sid"

// defaultSessionTTL is the compile-time fallback for GITCHAT_SESSION_TTL.
// Used when no Config Registry is attached (tests) or the key is unset
// and env is empty. UI edits to the key land via SetConfig → per-use
// resolution in ttlDur.
const defaultSessionTTL = 7 * 24 * time.Hour

// Session is the in-memory record of an authenticated browser.
type Session struct {
	Token     string // raw token value (also the cookie value)
	Principal string
	Mode      gitchatv1.AuthMode
	CreatedAt time.Time
	ExpiresAt time.Time
}

// SessionStore is a process-local session cache. Sessions are lost on
// restart; sessions are intentionally ephemeral.
//
// TTL resolves live via Config when set (DB override → env → default),
// so a UI change to GITCHAT_SESSION_TTL affects sessions created or
// rotated after the change — existing sessions keep their ExpiresAt
// from creation time, which is the intended semantic.
type SessionStore struct {
	mu       sync.RWMutex
	byToken  map[string]*Session
	cfg      *config.Registry // optional; nil falls back to env + default
	secureCk bool             // set Secure flag on cookies (true only behind TLS)
}

// NewSessionStore returns an empty store. secure controls the Secure cookie
// flag — leave false for plain HTTP (local mode, loopback self-hosted).
func NewSessionStore(secure bool) *SessionStore {
	return &SessionStore{
		byToken:  make(map[string]*Session),
		secureCk: secure,
	}
}

// SetConfig attaches a config Registry so TTL resolution honours DB
// overrides. Call once at startup before serving requests.
func (s *SessionStore) SetConfig(cfg *config.Registry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cfg = cfg
}

// ttlDur resolves the current session TTL. Values ≤ 0 are rejected so
// a UI typo of "0" can't mint immediately-expired sessions.
func (s *SessionStore) ttlDur() time.Duration {
	s.mu.RLock()
	cfg := s.cfg
	s.mu.RUnlock()
	if cfg != nil {
		if d := cfg.GetDurCtx(context.Background(), "GITCHAT_SESSION_TTL", defaultSessionTTL); d > 0 {
			return d
		}
		return defaultSessionTTL
	}
	if v := os.Getenv("GITCHAT_SESSION_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return defaultSessionTTL
}

// Create mints a new session and returns it. Caller is responsible for
// setting the cookie on the HTTP response via SetCookie.
func (s *SessionStore) Create(principal string, mode gitchatv1.AuthMode) (*Session, error) {
	tok, err := randomHex(32)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	ttl := s.ttlDur()
	sess := &Session{
		Token:     tok,
		Principal: principal,
		Mode:      mode,
		CreatedAt: now,
		ExpiresAt: now.Add(ttl),
	}
	s.mu.Lock()
	s.byToken[tok] = sess
	s.mu.Unlock()
	return sess, nil
}

// Get returns the session for a token if it exists and has not expired.
// Expired sessions are swept lazily on lookup.
func (s *SessionStore) Get(token string) *Session {
	s.mu.RLock()
	sess, ok := s.byToken[token]
	s.mu.RUnlock()
	if !ok {
		return nil
	}
	if time.Now().After(sess.ExpiresAt) {
		s.mu.Lock()
		delete(s.byToken, token)
		s.mu.Unlock()
		return nil
	}
	return sess
}

// ShouldRotate returns true if the session should be rotated (after 50% of TTL).
// Rotation prevents long-lived sessions from being compromised.
func (s *SessionStore) ShouldRotate(sess *Session) bool {
	elapsed := time.Since(sess.CreatedAt)
	return elapsed > s.ttlDur()/2
}

// Rotate creates a new session with the same principal/mode, deletes the old one.
// Returns the new session. Caller must set the new cookie.
func (s *SessionStore) Rotate(oldToken string, sess *Session) (*Session, error) {
	newSess, err := s.Create(sess.Principal, sess.Mode)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	delete(s.byToken, oldToken)
	s.mu.Unlock()
	return newSess, nil
}

// Delete invalidates a session (used by Logout).
func (s *SessionStore) Delete(token string) {
	s.mu.Lock()
	delete(s.byToken, token)
	s.mu.Unlock()
}

// SetCookie writes the session cookie to w.
func (s *SessionStore) SetCookie(w http.ResponseWriter, sess *Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    sess.Token,
		Path:     "/",
		Expires:  sess.ExpiresAt,
		MaxAge:   int(s.ttlDur().Seconds()),
		HttpOnly: true,
		Secure:   s.secureCk,
		SameSite: http.SameSiteStrictMode,
	})
}

// ClearCookie writes an expired cookie (used by Logout).
func (s *SessionStore) ClearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.secureCk,
		SameSite: http.SameSiteStrictMode,
	})
}

// TTL returns the session time-to-live duration.
func (s *SessionStore) TTL() time.Duration {
	return s.ttlDur()
}
