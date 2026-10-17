package rpc

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pders01/git-chat/internal/auth"
	"github.com/pders01/git-chat/internal/chat"
	"github.com/pders01/git-chat/internal/repo"
)

func TestHeadlessHTTPRouting(t *testing.T) {
	// Construct the actual top-level mux without listeners, a DB, a model, or auth claims.
	// A method-specific catch-all "GET /" panics here against all-method Connect prefixes.
	sessions := auth.NewSessionStore(false)
	server := NewHTTPServer(Config{
		Version:  "routing-fixture",
		Sessions: sessions,
		AuthSvc:  &auth.Service{Sessions: sessions},
		RepoSvc:  &repo.Service{Registry: repo.NewRegistry()},
		ChatSvc:  &chat.Service{},
	})
	for _, tc := range []struct {
		name, method, path string
		status             int
	}{
		{"root metadata", "GET", "/", http.StatusOK},
		{"health", "GET", "/api/health", http.StatusOK},
		{"unknown path is not root metadata", "GET", "/not-a-route", http.StatusNotFound},
		{"root is not a POST endpoint", "POST", "/", http.StatusMethodNotAllowed},
		{"auth prefix remains reachable", "POST", "/gitchat.v1.AuthService/Whoami", http.StatusOK},
		{"repository authentication unchanged", "POST", "/gitchat.v1.RepoService/ListRepos", http.StatusUnauthorized},
		{"chat authentication unchanged", "POST", "/gitchat.v1.ChatService/ListSessions", http.StatusUnauthorized},
		{"unknown Connect method is not root metadata", "POST", "/gitchat.v1.AuthService/NoSuchMethod", http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}"))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Connect-Protocol-Version", "1")
			response := httptest.NewRecorder()
			server.Handler.ServeHTTP(response, request)
			if response.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", response.Code, tc.status, response.Body.String())
			}
			if response.Header().Get("Content-Security-Policy") != "default-src 'none'; frame-ancestors 'none'" ||
				response.Header().Get("X-Content-Type-Options") != "nosniff" ||
				response.Header().Get("X-Frame-Options") != "DENY" ||
				response.Header().Get("Referrer-Policy") != "no-referrer" {
				t.Fatal("headless security headers changed")
			}
			if tc.path == "/" && tc.method == "GET" {
				var value map[string]any
				if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
					t.Fatal(err)
				}
				if value["name"] != "git-chat" || value["mode"] != "headless" || value["health"] != "/api/health" {
					t.Fatalf("unexpected root metadata: %v", value)
				}
			}
		})
	}
}
