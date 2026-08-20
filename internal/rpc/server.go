// Package rpc owns the headless Connect RPC HTTP server.
package rpc

import (
	"encoding/json"
	"net/http"
	"time"

	"connectrpc.com/connect"

	"github.com/pders01/git-chat/gen/go/gitchat/v1/gitchatv1connect"
	"github.com/pders01/git-chat/internal/auth"
	"github.com/pders01/git-chat/internal/chat"
	"github.com/pders01/git-chat/internal/repo"
)

// Config holds the dependencies required to construct an HTTP server.
// All *Svc fields are required; the shape is identical in serve and local
// modes, with differing internals.
type Config struct {
	Addr     string
	Version  string
	Sessions *auth.SessionStore
	AuthSvc  *auth.Service
	RepoSvc  *repo.Service
	ChatSvc  *chat.Service
}

// NewHTTPServer returns a configured *http.Server ready for ListenAndServe.
// startedAt is captured at construction so uptime is measured from server
// init, not from the first request.
func NewHTTPServer(cfg Config) *http.Server {
	startedAt := time.Now()

	mux := http.NewServeMux()

	// Health endpoint (unauthenticated).
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":         "ok",
			"version":        cfg.Version,
			"uptime_seconds": int64(time.Since(startedAt).Seconds()),
		})
	})

	// AuthService Connect handler. Mounted at its generated path
	// (/gitchat.v1.AuthService/...). The session middleware wrapping the
	// whole mux injects the principal into ctx before the handler runs,
	// which is how Whoami and Logout see who they're talking to.
	// AuthService endpoints must be callable before a session exists, so
	// no RequireAuth interceptor here.
	authPath, authHandler := gitchatv1connect.NewAuthServiceHandler(cfg.AuthSvc)
	mux.Handle(authPath, authHandler)

	// RepoService and ChatService both require authentication: the
	// RequireAuth interceptor returns CodeUnauthenticated before any
	// handler runs if there's no principal in context.
	repoPath, repoHandler := gitchatv1connect.NewRepoServiceHandler(
		cfg.RepoSvc,
		connect.WithInterceptors(auth.RequireAuth(), TimingInterceptor()),
	)
	mux.Handle(repoPath, repoHandler)

	chatPath, chatHandler := gitchatv1connect.NewChatServiceHandler(
		cfg.ChatSvc,
		connect.WithInterceptors(auth.RequireAuth(), TimingInterceptor()),
	)
	mux.Handle(chatPath, chatHandler)

	mux.HandleFunc("GET /", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name":   "git-chat",
			"mode":   "headless",
			"health": "/api/health",
		})
	})

	// Session middleware wraps the API mux and injects authenticated principals.
	handler := auth.SessionMiddleware(cfg.Sessions, mux)

	// Security headers: CSP + basic hardening.
	secured := securityHeaders(handler)

	return &http.Server{
		Addr:              cfg.Addr,
		Handler:           secured,
		ReadHeaderTimeout: 5 * time.Second,
	}
}

// securityHeaders prevents API responses from being embedded or MIME-sniffed.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
