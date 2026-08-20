package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	_ "net/http/pprof"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/pders01/git-chat/internal/auth"
	"github.com/pders01/git-chat/internal/chat"
	"github.com/pders01/git-chat/internal/chat/tools"
	"github.com/pders01/git-chat/internal/config"
	"github.com/pders01/git-chat/internal/repo"
	"github.com/pders01/git-chat/internal/rpc"
	"github.com/pders01/git-chat/internal/webhook"
)

// runLocal starts the headless Connect API on a loopback address. It prints a
// one-shot local claim token for API clients but never opens a browser.
func runLocal(args []string) error {
	fs := flag.NewFlagSet("local", flag.ExitOnError)
	httpAddr := fs.String("http", "127.0.0.1:0", "HTTP listen address (loopback only)")
	llmBackend := fs.String("llm-backend", envOr("LLM_BACKEND", "openai"), "LLM backend: openai or anthropic")
	llmBase := fs.String("llm-base-url", envOr("LLM_BASE_URL", "http://localhost:1234/v1"), "OpenAI-compatible base URL")
	llmModel := fs.String("llm-model", envOr("LLM_MODEL", ""), "model name")
	llmKey := fs.String("llm-api-key", envOr("LLM_API_KEY", ""), "API key")
	llmTemp := fs.Float64("llm-temperature", envFloat("LLM_TEMPERATURE", 0), "LLM temperature")
	llmMaxTok := fs.Int("llm-max-tokens", envIntFlag("LLM_MAX_TOKENS", 0), "LLM max tokens")
	dbPath := fs.String("db", envOr("GITCHAT_DB", ""), "SQLite state file path")
	noScan := fs.Bool("no-scan", false, "treat the path as one repository")
	maxRepos := fs.Int("max-repos", 0, "maximum repositories loaded from a directory scan")
	pprofAddr := fs.String("pprof", "", "optional loopback pprof address")
	var repos repoFlags
	fs.Var(&repos, "repo", "explicit repository path (repeatable)")
	_ = fs.Parse(args)

	if *maxRepos < 0 {
		return errors.New("--max-repos cannot be negative")
	}
	if err := validateLoopback(*httpAddr); err != nil {
		return err
	}

	repoPath := fs.Arg(0)
	if repoPath == "" {
		var err error
		repoPath, err = os.Getwd()
		if err != nil {
			return fmt.Errorf("resolve cwd: %w", err)
		}
	}

	installLogger(os.Stderr, "info")
	registry := repo.NewRegistry()
	if len(repos) > 0 {
		for _, path := range repos {
			if _, err := registry.Add(path); err != nil {
				return fmt.Errorf("register repo %q: %w", path, err)
			}
		}
	} else if _, err := registry.Add(repoPath); err != nil {
		if *noScan {
			return fmt.Errorf("%q is not a valid git repository", repoPath)
		}
		result, scanErr := registry.ScanDirectory(repoPath, *maxRepos)
		if scanErr != nil {
			return fmt.Errorf("scan %q: %w", repoPath, scanErr)
		}
		if len(result.Added) == 0 {
			return fmt.Errorf("%q contains no git repositories", repoPath)
		}
	}

	db, err := openDB(*dbPath)
	if err != nil {
		return err
	}
	defer db.Close()
	cfg := config.New(db)
	config.RegisterDefaults(cfg)
	if err := cfg.InitEncryption(db.Path); err != nil {
		return fmt.Errorf("init config encryption: %w", err)
	}
	registry.SetConfig(cfg)

	sessions := auth.NewSessionStore(false)
	sessions.SetConfig(cfg)
	localTokens := auth.NewLocalTokens()
	token, _, err := localTokens.Mint()
	if err != nil {
		return fmt.Errorf("mint local token: %w", err)
	}
	llmAdapter, err := buildLLM(*llmBackend, *llmBase, *llmKey, llmModel)
	if err != nil {
		return err
	}

	authSvc := &auth.Service{Sessions: sessions, Local: localTokens}
	repoSvc := &repo.Service{Registry: registry, Config: cfg, DB: db, Catalog: repo.NewCatalog(db)}
	chatSvc := &chat.Service{
		DB: db, LLM: llmAdapter, Config: cfg, Repos: registry, Model: *llmModel,
		Temperature: float32(*llmTemp), MaxTokens: *llmMaxTok,
		Webhook: webhook.New(cfg.Get("GITCHAT_WEBHOOK_URL")), Tools: tools.Default(),
	}

	listener, err := net.Listen("tcp", *httpAddr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", *httpAddr, err)
	}
	address := listener.Addr().(*net.TCPAddr)
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", address.Port)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *pprofAddr != "" {
		if err := validateLoopback(*pprofAddr); err != nil {
			return fmt.Errorf("--pprof: %w", err)
		}
		profileServer := &http.Server{Addr: *pprofAddr, Handler: http.DefaultServeMux, ReadHeaderTimeout: 5 * time.Second}
		go func() {
			if err := profileServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				slog.Warn("pprof stopped", "err", err)
			}
		}()
		defer profileServer.Shutdown(context.Background())
	}

	httpServer := rpc.NewHTTPServer(rpc.Config{
		Addr: *httpAddr, Version: version, Sessions: sessions,
		AuthSvc: authSvc, RepoSvc: repoSvc, ChatSvc: chatSvc,
	})
	go func() {
		fmt.Fprintf(os.Stdout, "GITCHAT_READY url=%s token=%s\n", baseURL, token)
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("http failed", "err", err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdownCtx)
}

func validateLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid --http address: %w", err)
	}
	if host == "localhost" {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("local mode refuses non-loopback host %q", host)
	}
	return nil
}
