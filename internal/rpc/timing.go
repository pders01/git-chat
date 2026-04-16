package rpc

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"connectrpc.com/connect"
)

// TimingInterceptor logs the wall-clock duration of each Connect RPC at
// INFO level. The log line is a single slog record with method + ms, so
// grepping the server stderr gives a quick feel for which handler is slow
// before reaching for pprof.
func TimingInterceptor() connect.Interceptor {
	return timingInterceptor{}
}

type timingInterceptor struct{}

func (timingInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		start := time.Now()
		resp, err := next(ctx, req)
		logRPC(req.Spec().Procedure, time.Since(start), err)
		return resp, err
	}
}

func (timingInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (timingInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		start := time.Now()
		err := next(ctx, conn)
		logRPC(conn.Spec().Procedure, time.Since(start), err)
		return err
	}
}

// logRPC emits a single structured log entry for a finished RPC.
// Procedure is trimmed from `/gitchat.v1.RepoService/ListBranches` to
// `RepoService.ListBranches` for readability.
func logRPC(procedure string, dur time.Duration, err error) {
	name := procedure
	if i := strings.LastIndex(name, "/"); i >= 0 && i < len(name)-1 {
		name = name[i+1:]
	}
	if i := strings.LastIndex(procedure, "."); i >= 0 {
		if j := strings.Index(procedure[i+1:], "/"); j > 0 {
			name = procedure[i+1:i+1+j] + "." + name
		}
	}
	lvl := slog.LevelInfo
	if err != nil {
		lvl = slog.LevelWarn
	}
	slog.Log(context.Background(), lvl, "rpc",
		"method", name,
		"ms", dur.Milliseconds(),
		"err", errString(err))
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
