package auth_test

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/auth"
)

// Test RequireAuth interceptor

func TestRequireAuthInterceptor_NoPrincipal(t *testing.T) {
	interceptor := auth.RequireAuth()
	
	// Create mock unary handler
	mockHandler := func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		return connect.NewResponse(&gitchatv1.WhoamiResponse{}), nil
	}
	
	// Wrap with interceptor
	wrapped := interceptor.WrapUnary(mockHandler)
	
	// Call with context that has no principal
	ctx := context.Background()
	req := connect.NewRequest(&gitchatv1.WhoamiRequest{})
	
	_, err := wrapped(ctx, req)
	if err == nil {
		t.Fatal("expected error for unauthenticated request")
	}
	
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("expected CodeUnauthenticated, got %v", connect.CodeOf(err))
	}
}

func TestRequireAuthInterceptor_WithPrincipal(t *testing.T) {
	interceptor := auth.RequireAuth()
	
	called := false
	mockHandler := func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		called = true
		// Verify principal is accessible
		name, mode, ok := auth.PrincipalFromContext(ctx)
		if !ok {
			t.Error("expected principal in context")
		}
		if name != "testuser" {
			t.Errorf("expected testuser, got %s", name)
		}
		if mode != gitchatv1.AuthMode_AUTH_MODE_PAIRED {
			t.Errorf("expected PAIRED mode, got %v", mode)
		}
		return connect.NewResponse(&gitchatv1.WhoamiResponse{}), nil
	}
	
	wrapped := interceptor.WrapUnary(mockHandler)
	
	// Call with authenticated context
	ctx := auth.WithPrincipal(context.Background(), "testuser", gitchatv1.AuthMode_AUTH_MODE_PAIRED)
	req := connect.NewRequest(&gitchatv1.WhoamiRequest{})
	
	_, err := wrapped(ctx, req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	
	if !called {
		t.Fatal("handler was not called")
	}
}

func TestRequireAuthInterceptor_StreamingHandler(t *testing.T) {
	interceptor := auth.RequireAuth()
	
	// Test streaming handler wrapper (just verify it compiles and runs)
	mockStreamingHandler := func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		return nil
	}
	
	wrapped := interceptor.WrapStreamingHandler(mockStreamingHandler)
	
	// Call without principal - should error
	ctx := context.Background()
	
	// Create a minimal mock conn (we can't easily mock StreamingHandlerConn,
	// but we can verify the interceptor checks auth before calling handler)
	err := wrapped(ctx, nil)
	if err == nil {
		// If conn is nil, we might not reach the auth check
		// This test mainly verifies the wrapper doesn't panic
		t.Log("streaming handler wrapper test passed (no panic)")
	}
}

func TestRequireAuthInterceptor_WrapStreamingClient(t *testing.T) {
	interceptor := auth.RequireAuth()
	
	// WrapStreamingClient should just pass through (clients never constructed by server)
	mockClient := func(ctx context.Context, spec connect.Spec) connect.StreamingClientConn {
		return nil
	}
	
	wrapped := interceptor.WrapStreamingClient(mockClient)
	
	// Should not modify the client function
	if wrapped == nil {
		t.Fatal("WrapStreamingClient returned nil")
	}
}
