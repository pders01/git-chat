package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
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

// repoFlags collects repeated --repo paths.
type repoFlags []string

func (r *repoFlags) String() string     { return fmt.Sprint(*r) }
func (r *repoFlags) Set(v string) error { *r = append(*r, v); return nil }

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	httpAddr := fs.String("http", ":8080", "HTTP listen address")
	sshAddr := fs.String("ssh", ":2222", "SSH listen address")
	llmBackend := fs.String("llm-backend", envOr("LLM_BACKEND", "openai"), "LLM backend: 'openai' or 'anthropic'")
	llmBase := fs.String("llm-base-url", envOr("LLM_BASE_URL", "http://localhost:1234/v1"), "OpenAI-compatible base URL (ignored for anthropic)")
	llmModel := fs.String("llm-model", envOr("LLM_MODEL", ""), "Model name (default per backend)")
	llmKey := fs.String("llm-api-key", envOr("LLM_API_KEY", ""), "API key (required for anthropic)")
	llmTemp := fs.Float64("llm-temperature", envFloat("LLM_TEMPERATURE", 0), "LLM temperature")
	llmMaxTok := fs.Int("llm-max-tokens", envIntFlag("LLM_MAX_TOKENS", 0), "LLM max tokens")
	dbPath := fs.String("db", envOr("GITCHAT_DB", ""), "SQLite state file path (default: ~/.local/state/git-chat/state.db)")
	behindTLS := fs.Bool("behind-tls", false, "set Secure flag on session cookies (enable when behind a TLS reverse proxy)")
	var repos repoFlags
	fs.Var(&repos, "repo", "path to a git repository to serve (repeatable)")
	_ = fs.Parse(args)

	if len(repos) == 0 {
		return errors.New("serve: at least one --repo is required")
	}

	installLogger(os.Stderr, "info")

	signersPath, err := auth.AllowedSignersPath()
	if err != nil {
		return fmt.Errorf("resolve allowed_signers path: %w", err)
	}
	signers, err := auth.LoadAllowedSignersFile(signersPath)
	if err != nil {
		return fmt.Errorf("load allowed_signers: %w", err)
	}
	if signers.Count() == 0 {
		slog.Warn("no principals registered — use `git-chat add-key` first", "path", signersPath)
	}

	registry := repo.NewRegistry()
	for _, p := range repos {
		entry, err := registry.Add(p)
		if err != nil {
			return fmt.Errorf("register repo %q: %w", p, err)
		}
		slog.Info("repo registered", "id", entry.ID, "path", entry.Path, "branch", entry.DefaultBranch)
	}

	db, err := openDB(*dbPath)
	if err != nil {
		return err
	}
	defer db.Close()
	slog.Info("storage opened", "path", db.Path)

	cfg := config.New(db)
	config.RegisterDefaults(cfg)
	if err := cfg.InitEncryption(db.Path); err != nil {
		return fmt.Errorf("init config encryption: %w", err)
	}
	// Wire the config Registry into the repo Registry so Entry methods
	// resolve tunables (diff caps, commit limits, churn windows) live
	// — UI edits take effect on the next request instead of next boot.
	registry.SetConfig(cfg)

	pairings := auth.NewPairingStore()
	sessions := auth.NewSessionStore(*behindTLS)
	sessions.SetConfig(cfg)
	llmAdapter, err := buildLLM(*llmBackend, *llmBase, *llmKey, llmModel)
	if err != nil {
		return err
	}

	authSvc := &auth.Service{
		Sessions: sessions,
		Pairings: pairings,
		Signers:  signers,
	}
	repoSvc := &repo.Service{Registry: registry, Config: cfg, DB: db, Catalog: repo.NewCatalog(db)}
	chatSvc := &chat.Service{
		DB:          db,
		LLM:         llmAdapter,
		Config:      cfg,
		Repos:       registry,
		Model:       *llmModel,
		Temperature: float32(*llmTemp),
		MaxTokens:   *llmMaxTok,
		Webhook:     webhook.New(cfg.Get("GITCHAT_WEBHOOK_URL")),
		Tools:       tools.Default(),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	httpSrv := rpc.NewHTTPServer(rpc.Config{
		Addr:     *httpAddr,
		Version:  version,
		Sessions: sessions,
		AuthSvc:  authSvc,
		RepoSvc:  repoSvc,
		ChatSvc:  chatSvc,
	})
	sshSrv, err := auth.NewSSHServer(auth.SSHConfig{
		Addr:     *sshAddr,
		Signers:  signers,
		Pairings: pairings,
	})
	if err != nil {
		return fmt.Errorf("ssh init: %w", err)
	}

	go func() {
		slog.Info("http listening",
			"addr", *httpAddr, "version", version,
			"principals", signers.Count(),
			"llm_base", *llmBase, "llm_model", *llmModel)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("http failed", "err", err)
		}
	}()

	go func() {
		slog.Info("ssh listening", "addr", *sshAddr)
		if err := sshSrv.ListenAndServe(); err != nil {
			slog.Info("ssh stopped", "err", err)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
	_ = sshSrv.Shutdown(shutdownCtx)
	return nil
}
