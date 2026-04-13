package auth

import (
	"net/http"
	"os"
	"sync"
	"time"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// CookieName is the session cookie name. HttpOnly + SameSite=Strict.
const CookieName = "git-chat.sid"

// SessionTTL is how long a session cookie remains valid. Rotated on each
// login (Claim / LocalClaim / pubkey re-pair).
// Override via GITCHAT_SESSION_TTL (duration string, e.g. "336h").
var SessionTTL = envDurAuth("GITCHAT_SESSION_TTL", 7*24*time.Hour)

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
type SessionStore struct {
	mu       sync.RWMutex
	byToken  map[string]*Session
	ttl      time.Duration
	secureCk bool // set Secure flag on cookies (true only behind TLS)
}

// NewSessionStore returns an empty store. secure controls the Secure cookie
// flag — leave false for plain HTTP (local mode, loopback self-hosted).
func NewSessionStore(secure bool) *SessionStore {
	return &SessionStore{
		byToken:  make(map[string]*Session),
		ttl:      SessionTTL,
		secureCk: secure,
	}
}

// Create mints a new session and returns it. Caller is responsible for
// setting the cookie on the HTTP response via SetCookie.
func (s *SessionStore) Create(principal string, mode gitchatv1.AuthMode) (*Session, error) {
	tok, err := randomHex(32)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	sess := &Session{
		Token:     tok,
		Principal: principal,
		Mode:      mode,
		CreatedAt: now,
		ExpiresAt: now.Add(s.ttl),
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
	return elapsed > s.ttl/2
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
		MaxAge:   int(s.ttl.Seconds()),
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

// envDurAuth reads an env var as a time.Duration string, returning def
// if unset or invalid.
func envDurAuth(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return def
}

// TTL returns the session time-to-live duration.
func (s *SessionStore) TTL() time.Duration {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ttl
}
