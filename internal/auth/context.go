package auth

import (
	"context"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

type ctxKey int

const principalKey ctxKey = iota

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
