package auth

import (
	"context"
	"errors"

	"connectrpc.com/connect"
)

// RequireAuth is a Connect interceptor that rejects any request whose
// context has no principal. The session HTTP middleware (see middleware.go)
// populates the principal from the cookie before the Connect handler runs,
// so this interceptor just inspects the context.
//
// Apply to every service except AuthService itself — AuthService RPCs need
// to be callable before the browser has a session (StartPairing, LocalClaim,
// Whoami, etc.).
func RequireAuth() connect.Interceptor {
	return requireAuthInterceptor{}
}

type requireAuthInterceptor struct{}

func (requireAuthInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		if _, _, ok := PrincipalFromContext(ctx); !ok {
			return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
		}
		return next(ctx, req)
	}
}

func (requireAuthInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	// Streaming clients are never constructed by the server in our setup.
	return next
}

func (requireAuthInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		if _, _, ok := PrincipalFromContext(ctx); !ok {
			return connect.NewError(connect.CodeUnauthenticated, errors.New("authentication required"))
		}
		return next(ctx, conn)
	}
}
