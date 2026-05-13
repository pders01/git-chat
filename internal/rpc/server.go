// Package rpc owns the HTTP server: Connect RPC handlers plus the embedded
// Lit SPA served from the static FS.
package rpc

import (
	"encoding/json"
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
	// ExtMode relaxes security headers so the SPA can be hosted inside a
	// VS Code (or Open VSX-derived editor) webview iframe. Drops
	// X-Frame-Options and adds frame-ancestors to CSP. Only set this when
	// the server binds to loopback under an extension host's control.
	ExtMode bool
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

	// Static SPA (everything else). DistFS picks dist/ when populated,
	// stub/ on fresh clones before `make all`.
	mux.Handle("/", http.FileServer(http.FS(assets.DistFS())))

	// Session middleware wraps the entire mux so both the API and the
	// static handler see the principal in context (useful when
	// static routes need auth-aware behavior).
	handler := auth.SessionMiddleware(cfg.Sessions, mux)

	// Security headers: CSP + basic hardening.
	secured := securityHeaders(handler, cfg.ExtMode)

	return &http.Server{
		Addr:              cfg.Addr,
		Handler:           secured,
		ReadHeaderTimeout: 5 * time.Second,
	}
}

// securityHeaders adds Content-Security-Policy and other baseline
// headers. The CSP allows inline styles (Shiki uses them for theming)
// but blocks everything else that's not same-origin.
//
// extMode swaps X-Frame-Options: DENY for a frame-ancestors directive
// that permits VS Code / Open VSX-derived webview origins. The Go
// server still binds loopback-only — this just unblocks the iframe.
func securityHeaders(next http.Handler, extMode bool) http.Handler {
	const baseCSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data:; connect-src 'self'; font-src 'self'"
	// vscode-webview://*: stable VS Code webview origin.
	// https://*.vscode-cdn.net: cursor / windsurf / forks that proxy
	//   webview content through cdn-style hosts.
	// http://127.0.0.1:* + http://localhost:*: extension dev workflows
	//   where the webview is loaded from a local dev server.
	const extCSP = baseCSP + "; frame-ancestors 'self' vscode-webview://* https://*.vscode-cdn.net http://127.0.0.1:* http://localhost:*"
	csp := baseCSP
	if extMode {
		csp = extCSP
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", csp)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if !extMode {
			w.Header().Set("X-Frame-Options", "DENY")
		}
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}
