package auth

import "net/http"

// SessionMiddleware reads the session cookie and, if valid, injects the
// principal + auth mode into the request context. Missing or invalid cookies
// pass through unchanged — downstream handlers decide whether auth is
// required.
func SessionMiddleware(sessions *SessionStore, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(CookieName)
		if err == nil && cookie.Value != "" {
			if sess := sessions.Get(cookie.Value); sess != nil {
				r = r.WithContext(WithPrincipal(r.Context(), sess.Principal, sess.Mode))
			}
		}
		next.ServeHTTP(w, r)
	})
}
