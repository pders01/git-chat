package auth

import (
	"context"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

type ctxKey int

const (
	principalKey ctxKey = iota
	sessionTokenKey
)

type principalInfo struct {
	name string
	mode gitchatv1.AuthMode
}

// WithPrincipal returns a context carrying the given principal and auth mode.
// Used by the session middleware after a successful cookie lookup.
func WithPrincipal(ctx context.Context, name string, mode gitchatv1.AuthMode) context.Context {
	return context.WithValue(ctx, principalKey, principalInfo{name: name, mode: mode})
}

// PrincipalFromContext returns the principal name, auth mode, and whether a
// principal was present. Callers that require authentication should treat
// the !ok case as unauthenticated.
func PrincipalFromContext(ctx context.Context) (name string, mode gitchatv1.AuthMode, ok bool) {
	info, present := ctx.Value(principalKey).(principalInfo)
	if !present {
		return "", gitchatv1.AuthMode_AUTH_MODE_UNSPECIFIED, false
	}
	return info.name, info.mode, true
}

// withSessionToken stores the raw session token in the context so Logout
// can invalidate the server-side session (not just clear the cookie).
func withSessionToken(ctx context.Context, token string) context.Context {
	return context.WithValue(ctx, sessionTokenKey, token)
}

// SessionTokenFromContext returns the raw session token, if present.
func SessionTokenFromContext(ctx context.Context) (string, bool) {
	tok, ok := ctx.Value(sessionTokenKey).(string)
	return tok, ok
}
