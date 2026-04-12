package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/gen/go/gitchat/v1/gitchatv1connect"
	"github.com/pders01/git-chat/internal/auth"
)

// newTestServer stands up an in-process Connect HTTP server with session
// middleware wired up and returns a ready-to-use client plus a cookie-jar
// HTTP client. Tests use this to exercise the real request path (including
// cookie propagation) without binding a TCP port.
func newTestServer(t *testing.T, svc *auth.Service, sessions *auth.SessionStore) (gitchatv1connect.AuthServiceClient, *http.Client) {
	t.Helper()

	mux := http.NewServeMux()
	path, handler := gitchatv1connect.NewAuthServiceHandler(svc)
	mux.Handle(path, handler)
	wrapped := auth.SessionMiddleware(sessions, mux)

	srv := httptest.NewServer(wrapped)
	t.Cleanup(srv.Close)

	jar := newCookieJar(t)
	httpClient := &http.Client{Jar: jar}

	client := gitchatv1connect.NewAuthServiceClient(httpClient, srv.URL)
	return client, httpClient
}

func TestLocalClaimFlow(t *testing.T) {
	local := auth.NewLocalTokens()
	token, _, err := local.Mint()
	if err != nil {
		t.Fatal(err)
	}
	sessions := auth.NewSessionStore(false)
	svc := &auth.Service{Sessions: sessions, Local: local}

	client, _ := newTestServer(t, svc, sessions)
	ctx := context.Background()

	// Pre-claim Whoami must be empty.
	who, err := client.Whoami(ctx, connect.NewRequest(&gitchatv1.WhoamiRequest{}))
	if err != nil {
		t.Fatalf("whoami pre-claim: %v", err)
	}
	if who.Msg.Principal != "" {
		t.Fatalf("expected empty principal before claim, got %q", who.Msg.Principal)
	}

	// Claim consumes the token and sets the cookie.
	resp, err := client.LocalClaim(ctx, connect.NewRequest(&gitchatv1.LocalClaimRequest{Token: token}))
	if err != nil {
		t.Fatalf("local claim: %v", err)
	}
	if resp.Msg.Principal != "local" {
		t.Fatalf("expected principal=local, got %q", resp.Msg.Principal)
	}

	// Post-claim Whoami sees the cookie via the http.Client's jar.
	who2, err := client.Whoami(ctx, connect.NewRequest(&gitchatv1.WhoamiRequest{}))
	if err != nil {
		t.Fatalf("whoami post-claim: %v", err)
	}
	if who2.Msg.Principal != "local" {
		t.Fatalf("expected principal=local, got %q", who2.Msg.Principal)
	}
	if who2.Msg.Mode != gitchatv1.AuthMode_AUTH_MODE_LOCAL {
		t.Fatalf("expected mode=LOCAL, got %v", who2.Msg.Mode)
	}

	// Second claim with the same token must fail (single-use enforcement).
	_, err = client.LocalClaim(ctx, connect.NewRequest(&gitchatv1.LocalClaimRequest{Token: token}))
	if err == nil {
		t.Fatal("expected second claim to fail")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("expected Unauthenticated, got %v", connect.CodeOf(err))
	}
}

func TestPairingFlow(t *testing.T) {
	pairings := auth.NewPairingStore()
	signers := auth.NewAllowedSigners()
	sessions := auth.NewSessionStore(false)
	svc := &auth.Service{
		Sessions: sessions,
		Pairings: pairings,
		Signers:  signers,
	}

	client, _ := newTestServer(t, svc, sessions)
	ctx := context.Background()

	// Start a pairing session.
	start, err := client.StartPairing(ctx, connect.NewRequest(&gitchatv1.StartPairingRequest{}))
	if err != nil {
		t.Fatalf("start pairing: %v", err)
	}
	sid := start.Msg.Sid
	code := start.Msg.Code
	if sid == "" || code == "" {
		t.Fatalf("empty sid/code: sid=%q code=%q", sid, code)
	}

	// Open the watch stream in a goroutine and capture the first event.
	type result struct {
		resp *gitchatv1.WatchPairingResponse
		err  error
	}
	watchCh := make(chan result, 1)
	watchCtx, cancelWatch := context.WithTimeout(ctx, 3*time.Second)
	defer cancelWatch()
	go func() {
		stream, err := client.WatchPairing(watchCtx, connect.NewRequest(&gitchatv1.WatchPairingRequest{Sid: sid}))
		if err != nil {
			watchCh <- result{nil, err}
			return
		}
		defer stream.Close()
		if !stream.Receive() {
			watchCh <- result{nil, stream.Err()}
			return
		}
		watchCh <- result{stream.Msg(), nil}
	}()

	// Give the watcher time to subscribe, then simulate the ssh pair handler
	// completing the pairing server-side.
	time.Sleep(50 * time.Millisecond)
	if err := pairings.Complete(code, "paul@laptop"); err != nil {
		t.Fatalf("complete: %v", err)
	}

	// Collect the Paired event.
	var paired *gitchatv1.Paired
	select {
	case r := <-watchCh:
		if r.err != nil {
			t.Fatalf("watch: %v", r.err)
		}
		switch k := r.resp.Kind.(type) {
		case *gitchatv1.WatchPairingResponse_Paired:
			paired = k.Paired
		case *gitchatv1.WatchPairingResponse_Expired:
			t.Fatalf("unexpected expired event: %s", k.Expired.Reason)
		default:
			t.Fatalf("unexpected kind: %T", k)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("watch timeout")
	}

	if paired.Principal != "paul@laptop" {
		t.Fatalf("expected principal=paul@laptop, got %q", paired.Principal)
	}
	if paired.ClaimToken == "" {
		t.Fatal("empty claim token")
	}

	// Claim the session using the token the stream delivered.
	claim, err := client.Claim(ctx, connect.NewRequest(&gitchatv1.ClaimRequest{
		Sid:        sid,
		ClaimToken: paired.ClaimToken,
	}))
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if claim.Msg.Principal != "paul@laptop" {
		t.Fatalf("expected principal=paul@laptop, got %q", claim.Msg.Principal)
	}

	// Whoami now sees the paired session via the cookie jar.
	who, err := client.Whoami(ctx, connect.NewRequest(&gitchatv1.WhoamiRequest{}))
	if err != nil {
		t.Fatalf("whoami: %v", err)
	}
	if who.Msg.Principal != "paul@laptop" {
		t.Fatalf("whoami principal: %q", who.Msg.Principal)
	}
	if who.Msg.Mode != gitchatv1.AuthMode_AUTH_MODE_PAIRED {
		t.Fatalf("whoami mode: %v", who.Msg.Mode)
	}

	// A second claim with the same token is rejected (single-use).
	_, err = client.Claim(ctx, connect.NewRequest(&gitchatv1.ClaimRequest{
		Sid:        sid,
		ClaimToken: paired.ClaimToken,
	}))
	if err == nil {
		t.Fatal("expected second claim to fail")
	}
}

func TestLocalClaimFailsInServeMode(t *testing.T) {
	sessions := auth.NewSessionStore(false)
	svc := &auth.Service{
		Sessions: sessions,
		Pairings: auth.NewPairingStore(),
		Signers:  auth.NewAllowedSigners(),
		// Local intentionally nil — serve-mode shape.
	}
	client, _ := newTestServer(t, svc, sessions)

	_, err := client.LocalClaim(context.Background(), connect.NewRequest(&gitchatv1.LocalClaimRequest{Token: "anything"}))
	if err == nil {
		t.Fatal("expected error in serve mode")
	}
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", connect.CodeOf(err))
	}
}

func TestStartPairingFailsInLocalMode(t *testing.T) {
	sessions := auth.NewSessionStore(false)
	svc := &auth.Service{
		Sessions: sessions,
		Local:    auth.NewLocalTokens(),
		// Pairings intentionally nil — local-mode shape.
	}
	client, _ := newTestServer(t, svc, sessions)

	_, err := client.StartPairing(context.Background(), connect.NewRequest(&gitchatv1.StartPairingRequest{}))
	if err == nil {
		t.Fatal("expected error in local mode")
	}
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", connect.CodeOf(err))
	}
}
