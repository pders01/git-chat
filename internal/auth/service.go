package auth

import (
	"context"
	"errors"
	"net/http"

	"connectrpc.com/connect"
	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/gen/go/gitchat/v1/gitchatv1connect"
)

// Service bundles the auth dependencies and implements AuthServiceHandler.
// Fields are mode-dependent:
//
//   - Sessions is always present.
//   - Pairings and Signers are set in serve mode only; nil in local mode.
//   - Local is set in local mode only; nil in serve mode.
//
// The implementation checks for nil-ness before dispatching mode-specific
// handlers so calling LocalClaim in serve mode returns a clean error
// instead of panicking.
type Service struct {
	gitchatv1connect.UnimplementedAuthServiceHandler

	Sessions *SessionStore
	Pairings *PairingStore
	Signers  *AllowedSigners
	Local    *LocalTokens
}

var _ gitchatv1connect.AuthServiceHandler = (*Service)(nil)

// ─── StartPairing ───────────────────────────────────────────────────────
func (s *Service) StartPairing(
	_ context.Context,
	_ *connect.Request[gitchatv1.StartPairingRequest],
) (*connect.Response[gitchatv1.StartPairingResponse], error) {
	if s.Pairings == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			errors.New("pairing disabled in local mode"))
	}
	sid, code, expiresAt, err := s.Pairings.Start()
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&gitchatv1.StartPairingResponse{
		Sid:       sid,
		Code:      code,
		ExpiresAt: expiresAt.Unix(),
	}), nil
}

// ─── WatchPairing ───────────────────────────────────────────────────────
func (s *Service) WatchPairing(
	ctx context.Context,
	req *connect.Request[gitchatv1.WatchPairingRequest],
	stream *connect.ServerStream[gitchatv1.WatchPairingResponse],
) error {
	if s.Pairings == nil {
		return connect.NewError(connect.CodeFailedPrecondition,
			errors.New("pairing disabled in local mode"))
	}
	ch, err := s.Pairings.Watch(req.Msg.Sid)
	if err != nil {
		return connect.NewError(connect.CodeNotFound, err)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case ev, ok := <-ch:
		if !ok {
			return nil
		}
		if err := stream.Send(ev); err != nil {
			return err
		}
	}
	return nil
}

// ─── Claim ──────────────────────────────────────────────────────────────
func (s *Service) Claim(
	ctx context.Context,
	req *connect.Request[gitchatv1.ClaimRequest],
) (*connect.Response[gitchatv1.ClaimResponse], error) {
	if s.Pairings == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			errors.New("pairing disabled in local mode"))
	}
	principal, err := s.Pairings.Claim(req.Msg.Sid, req.Msg.ClaimToken)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, err)
	}
	sess, err := s.Sessions.Create(principal, gitchatv1.AuthMode_AUTH_MODE_PAIRED)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	resp := connect.NewResponse(&gitchatv1.ClaimResponse{Principal: principal})
	s.writeSetCookie(resp.Header(), sess)
	_ = ctx
	return resp, nil
}

// ─── LocalClaim ─────────────────────────────────────────────────────────
func (s *Service) LocalClaim(
	_ context.Context,
	req *connect.Request[gitchatv1.LocalClaimRequest],
) (*connect.Response[gitchatv1.LocalClaimResponse], error) {
	if s.Local == nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			errors.New("local claim disabled in serve mode"))
	}
	if err := s.Local.Claim(req.Msg.Token); err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, err)
	}
	sess, err := s.Sessions.Create("local", gitchatv1.AuthMode_AUTH_MODE_LOCAL)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	resp := connect.NewResponse(&gitchatv1.LocalClaimResponse{Principal: "local"})
	s.writeSetCookie(resp.Header(), sess)
	return resp, nil
}

// ─── Whoami ─────────────────────────────────────────────────────────────
func (s *Service) Whoami(
	ctx context.Context,
	_ *connect.Request[gitchatv1.WhoamiRequest],
) (*connect.Response[gitchatv1.WhoamiResponse], error) {
	name, mode, ok := PrincipalFromContext(ctx)
	if !ok {
		return connect.NewResponse(&gitchatv1.WhoamiResponse{}), nil
	}
	return connect.NewResponse(&gitchatv1.WhoamiResponse{
		Principal: name,
		Mode:      mode,
	}), nil
}

// ─── Logout ─────────────────────────────────────────────────────────────
func (s *Service) Logout(
	ctx context.Context,
	_ *connect.Request[gitchatv1.LogoutRequest],
) (*connect.Response[gitchatv1.LogoutResponse], error) {
	// We cannot read the cookie directly here (Connect abstracts the
	// request), but the session middleware has already injected the
	// principal into ctx. A logout without a session is a no-op; a logout
	// with one clears the cookie via the response header.
	_, _, ok := PrincipalFromContext(ctx)
	resp := connect.NewResponse(&gitchatv1.LogoutResponse{})
	if ok {
		s.writeClearCookie(resp.Header())
	}
	return resp, nil
}

// writeSetCookie sets the session cookie on a Connect response header map.
// http.SetCookie normally targets an http.ResponseWriter, but the Header
// map has identical shape so we format the cookie ourselves via
// (*http.Cookie).String().
func (s *Service) writeSetCookie(h http.Header, sess *Session) {
	c := &http.Cookie{
		Name:     CookieName,
		Value:    sess.Token,
		Path:     "/",
		Expires:  sess.ExpiresAt,
		MaxAge:   int(s.Sessions.ttl.Seconds()),
		HttpOnly: true,
		Secure:   s.Sessions.secureCk,
		SameSite: http.SameSiteStrictMode,
	}
	h.Add("Set-Cookie", c.String())
}

func (s *Service) writeClearCookie(h http.Header) {
	c := &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.Sessions.secureCk,
		SameSite: http.SameSiteStrictMode,
	}
	h.Add("Set-Cookie", c.String())
}
