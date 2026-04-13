package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/mark3labs/mcp-go/server"

	mcptools "github.com/pders01/git-chat/internal/mcp"
	"github.com/pders01/git-chat/internal/repo"
)

func runMCP(args []string) error {
	fs := flag.NewFlagSet("mcp", flag.ExitOnError)
	dbPath := fs.String("db", envOr("GITCHAT_DB", ""), "SQLite state file path")
	_ = fs.Parse(args)

	// Positional arg: repo path. Defaults to cwd.
	repoPath := fs.Arg(0)
	if repoPath == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("resolve cwd: %w", err)
		}
		repoPath = cwd
	}

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelWarn,
	})))

	registry := repo.NewRegistry()
	if _, err := registry.Add(repoPath); err != nil {
		return fmt.Errorf("register repo %q: %w", repoPath, err)
	}

	db, err := openDB(*dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	mcpServer := mcptools.NewServer(mcptools.Config{
		Registry: registry,
		DB:       db,
		Version:  version,
	})

	stdio := server.NewStdioServer(mcpServer)

	// Set up cancellation context for graceful shutdown
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return stdio.Listen(ctx, os.Stdin, os.Stdout)
}
