// Package rpc owns the HTTP server: Connect RPC handlers plus the embedded
// Lit SPA served from the static FS.
package rpc

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"time"

	"connectrpc.com/connect"

	"github.com/pders01/git-chat/gen/go/gitchat/v1/gitchatv1connect"
	"github.com/pders01/git-chat/internal/assets"
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
		connect.WithInterceptors(auth.RequireAuth()),
	)
	mux.Handle(repoPath, repoHandler)

	chatPath, chatHandler := gitchatv1connect.NewChatServiceHandler(
		cfg.ChatSvc,
		connect.WithInterceptors(auth.RequireAuth()),
	)
	mux.Handle(chatPath, chatHandler)

	// Static SPA (everything else).
	sub, err := fs.Sub(assets.DistFS, "dist")
	if err != nil {
		panic("assets: dist subtree missing: " + err.Error())
	}
	mux.Handle("/", http.FileServer(http.FS(sub)))

	// Session middleware wraps the entire mux so both the API and the
	// static handler see the principal in context (useful when
	// static routes need auth-aware behavior).
	handler := auth.SessionMiddleware(cfg.Sessions, mux)

	// Security headers: CSP + basic hardening.
	secured := securityHeaders(handler)

	return &http.Server{
		Addr:              cfg.Addr,
		Handler:           secured,
		ReadHeaderTimeout: 5 * time.Second,
	}
}

// securityHeaders adds Content-Security-Policy and other baseline
// headers. The CSP allows inline styles (Shiki uses them for theming)
// but blocks everything else that's not same-origin.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data:; connect-src 'self'; font-src 'self'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}
