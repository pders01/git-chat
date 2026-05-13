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
	// extMode flips cookie attributes for VS Code / Open VSX webview
	// hosting. The SPA runs inside an iframe whose top-level document
	// is vscode-webview:// or vscode-file://, which Chromium treats as
	// cross-site to http://localhost — SameSite=Strict (or Lax) blocks
	// the session cookie on every fetch from the iframe. ext-mode
	// switches to SameSite=None + Secure + Partitioned, the modern
	// "third-party-but-trusted" recipe. Loopback gets the Secure
	// exception on http://localhost in Chromium so no TLS is needed.
	extMode bool
	// TTL cache — the Config Registry resolves SESSION_TTL via a DB
	// round-trip with a 5s timeout; ttlDur is called on every session
	// op (Create/Get/Rotate/ShouldRotate/TTL/SetCookie) so without a
	// cache, steady-state auth traffic hammers the DB for a value that
	// changes on the order of days. The cache refreshes in the
	// background every ttlCacheRefresh seconds; UI edits to the TTL
	// take effect within that window.
	ttlCached   time.Duration
	ttlCachedAt time.Time
	ttlMu       sync.Mutex
}

const ttlCacheRefresh = 30 * time.Second

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

// SetExtMode enables ext-mode cookie attributes (SameSite=None +
// Secure + Partitioned). MUST only be called when the HTTP server is
// loopback-bound — without that guarantee, SameSite=None makes the
// cookie eligible for cross-site requests and defeats CSRF protection.
//
// The only legitimate caller is `git-chat local --ext-mode`, which
// runs validateLoopback before reaching this code path. Adding new
// callers means re-establishing the loopback invariant first; the
// store cannot verify the bind itself.
//
// Partitioned is the cross-context safety net: it scopes the cookie
// to the (origin, top-level-site) tuple so an attacker page that
// iframes our loopback origin cannot read the session a legitimate
// webview host already established.
func (s *SessionStore) SetExtMode(enabled bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.extMode = enabled
}

// ttlDur resolves the current session TTL. Values ≤ 0 are rejected so
// a UI typo of "0" can't mint immediately-expired sessions. Cached
// for ttlCacheRefresh to avoid hammering the config DB on every auth
// op; a UI change takes effect within the refresh window.
func (s *SessionStore) ttlDur() time.Duration {
	s.ttlMu.Lock()
	if s.ttlCached > 0 && time.Since(s.ttlCachedAt) < ttlCacheRefresh {
		d := s.ttlCached
		s.ttlMu.Unlock()
		return d
	}
	s.ttlMu.Unlock()

	d := s.resolveTTL()
	s.ttlMu.Lock()
	s.ttlCached = d
	s.ttlCachedAt = time.Now()
	s.ttlMu.Unlock()
	return d
}

func (s *SessionStore) resolveTTL() time.Duration {
	s.mu.RLock()
	cfg := s.cfg
	s.mu.RUnlock()
	if cfg != nil {
		// Registry enforces an internal 5s DB timeout on the lookup.
		// Using Background() here is deliberate: ttlDur is called from
		// non-request paths (cookie setup, TTL() accessor) that don't
		// have a natural request ctx, and short-circuiting via cache
		// above means this DB read happens at most once per 30s.
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

// CookieAttrs returns the shared cookie attributes for session cookies
// (Secure, SameSite, Partitioned). Centralised so SetCookie,
// ClearCookie, and the Connect handler's manual cookie writers stay in
// sync. ext-mode flips SameSite=Strict → None + Secure + Partitioned so
// the cookie survives the cross-site iframe context inside a VS Code
// webview host.
func (s *SessionStore) CookieAttrs() (secure bool, sameSite http.SameSite, partitioned bool) {
	if s.extMode {
		return true, http.SameSiteNoneMode, true
	}
	return s.secureCk, http.SameSiteStrictMode, false
}

// SetCookie writes the session cookie to w.
func (s *SessionStore) SetCookie(w http.ResponseWriter, sess *Session) {
	secure, sameSite, partitioned := s.CookieAttrs()
	http.SetCookie(w, &http.Cookie{
		Name:        CookieName,
		Value:       sess.Token,
		Path:        "/",
		Expires:     sess.ExpiresAt,
		MaxAge:      int(s.ttlDur().Seconds()),
		HttpOnly:    true,
		Secure:      secure,
		SameSite:    sameSite,
		Partitioned: partitioned,
	})
}

// ClearCookie writes an expired cookie (used by Logout).
func (s *SessionStore) ClearCookie(w http.ResponseWriter) {
	secure, sameSite, partitioned := s.CookieAttrs()
	http.SetCookie(w, &http.Cookie{
		Name:        CookieName,
		Value:       "",
		Path:        "/",
		MaxAge:      -1,
		HttpOnly:    true,
		Secure:      secure,
		SameSite:    sameSite,
		Partitioned: partitioned,
	})
}

// TTL returns the session time-to-live duration.
func (s *SessionStore) TTL() time.Duration {
	return s.ttlDur()
}
