package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/pders01/git-chat/internal/auth"
	"github.com/pders01/git-chat/internal/chat"
	"github.com/pders01/git-chat/internal/config"
	"github.com/pders01/git-chat/internal/repo"
	"github.com/pders01/git-chat/internal/rpc"
	"github.com/pders01/git-chat/internal/webhook"
)

func runLocal(args []string) error {
	fs := flag.NewFlagSet("local", flag.ExitOnError)
	httpAddr := fs.String("http", "127.0.0.1:0", "HTTP listen address (loopback only)")
	noBrowser := fs.Bool("no-browser", false, "do not attempt to open the claim URL in a browser")
	// --open-host overrides the host:port portion of the printed Open URL
	// and the auto-open target. Use case: `make dev` binds the Go server
	// to :8080 but wants the user to actually open the Vite dev server on
	// :5173 (which proxies API calls back to :8080). The token and path
	// stay identical — only the origin is swapped.
	openHost := fs.String("open-host", "", "override host:port in printed Open URL (useful with dev proxies)")
	llmBackend := fs.String("llm-backend", envOr("LLM_BACKEND", "openai"), "LLM backend: 'openai' (default, any OpenAI-compatible) or 'anthropic'")
	llmBase := fs.String("llm-base-url", envOr("LLM_BASE_URL", "http://localhost:1234/v1"), "OpenAI-compatible chat/completions base URL (ignored for anthropic)")
	llmModel := fs.String("llm-model", envOr("LLM_MODEL", ""), "Model name (default: gemma-4-e4b-it for openai, claude-sonnet-4-6 for anthropic)")
	llmKey := fs.String("llm-api-key", envOr("LLM_API_KEY", ""), "API key (required for anthropic, optional for local openai runners)")
	llmTemp := fs.Float64("llm-temperature", envFloat("LLM_TEMPERATURE", 0), "LLM temperature (0 = deterministic)")
	llmMaxTok := fs.Int("llm-max-tokens", envIntFlag("LLM_MAX_TOKENS", 0), "LLM max tokens per response (0 = provider default)")
	dbPath := fs.String("db", envOr("GITCHAT_DB", ""), "SQLite state file path (default: ~/.local/state/git-chat/state.db)")
	noScan := fs.Bool("no-scan", false, "do not scan directory for multiple repos (treat as single repo)")
	maxRepos := fs.Int("max-repos", 0, "maximum repos to load from directory scan (0 = unlimited)")
	var repos repoFlags
	fs.Var(&repos, "repo", "explicit repo path (repeatable); if set, positional path is ignored")
	_ = fs.Parse(args)

	// Validate flags
	if *maxRepos < 0 {
		return errors.New("--max-repos cannot be negative")
	}

	if err := validateLoopback(*httpAddr); err != nil {
		return err
	}

	// Positional arg: path to repo or directory to scan. Defaults to cwd.
	repoPath := fs.Arg(0)
	if repoPath == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("resolve cwd: %w", err)
		}
		repoPath = cwd
	}

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	registry := repo.NewRegistry()

	// Handle explicit --repo flags (takes precedence over positional arg)
	if len(repos) > 0 {
		for _, p := range repos {
			entry, err := registry.Add(p)
			if err != nil {
				return fmt.Errorf("register repo %q: %w", p, err)
			}
			slog.Info("repo registered", "id", entry.ID, "path", entry.Path, "branch", entry.DefaultBranch)
		}
	} else {
		// Positional arg: path to repo or directory to scan
		// (repoPath was already resolved above from fs.Arg(0) or cwd)
		// Try as single repo first
		entry, err := registry.Add(repoPath)
		if err != nil {
			// Not a valid git repo - try scanning if not disabled
			if *noScan {
				return fmt.Errorf("%q is not a valid git repo (--no-scan prevents directory scanning)", repoPath)
			}

			result, scanErr := registry.ScanDirectory(repoPath, *maxRepos)
			if scanErr != nil {
				return fmt.Errorf("%q is not a valid git repo and cannot be scanned: %w", repoPath, scanErr)
			}
			if len(result.Added) == 0 {
				return fmt.Errorf("%q contains no git repositories (scanned %d subdirectories)", repoPath, len(result.Skipped)+len(result.Errors))
			}

			for _, e := range result.Added {
				slog.Info("repo registered (scanned)", "id", e.ID, "path", e.Path, "branch", e.DefaultBranch)
			}
			for _, skipped := range result.Skipped {
				slog.Warn("repo skipped (duplicate id)", "path", skipped)
			}
			for _, err := range result.Errors {
				slog.Warn("repo error during scan", "err", err)
			}
			slog.Info("directory scan complete", "path", repoPath, "registered", len(result.Added), "skipped", len(result.Skipped))
		} else {
			slog.Info("repo registered", "id", entry.ID, "path", entry.Path, "branch", entry.DefaultBranch)
		}
	}

	if registry.Count() == 0 {
		return errors.New("no repositories registered")
	}

	db, err := openDB(*dbPath)
	if err != nil {
		return err
	}
	defer db.Close()
	slog.Info("storage opened", "path", db.Path)

	cfg := config.New(db)
	config.RegisterDefaults(cfg)

	sessions := auth.NewSessionStore(false)
	localTok := auth.NewLocalTokens()
	token, _, err := localTok.Mint()
	if err != nil {
		return fmt.Errorf("mint local token: %w", err)
	}
	llmAdapter, err := buildLLM(*llmBackend, *llmBase, *llmKey, llmModel)
	if err != nil {
		return err
	}

	authSvc := &auth.Service{
		Sessions: sessions,
		Local:    localTok,
	}
	repoSvc := &repo.Service{Registry: registry, Config: cfg}
	chatSvc := &chat.Service{
		DB:          db,
		LLM:         llmAdapter,
		Repos:       registry,
		Model:       *llmModel,
		Temperature: float32(*llmTemp),
		MaxTokens:   *llmMaxTok,
		Webhook:     webhook.New(cfg.Get("GITCHAT_WEBHOOK_URL")),
	}

	// Listen on the requested loopback address first so we know the bound
	// port before we print the URL (:0 means "pick a free port").
	ln, err := net.Listen("tcp", *httpAddr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", *httpAddr, err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	url := fmt.Sprintf("http://127.0.0.1:%d/?t=%s", addr.Port, token)
	// openURL is what we print and auto-open — either the bind URL, or
	// a dev-proxy origin if --open-host is set.
	openURL := url
	if *openHost != "" {
		openURL = fmt.Sprintf("http://%s/?t=%s", *openHost, token)
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

	go func() {
		slog.Info("http listening",
			"addr", addr.String(), "mode", "local", "version", version,
			"llm_base", *llmBase, "llm_model", *llmModel)
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "  Open: "+openURL)
		fmt.Fprintln(os.Stderr)
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("http failed", "err", err)
		}
	}()

	if !*noBrowser {
		if err := openBrowser(openURL); err != nil {
			slog.Debug("auto-open failed", "err", err)
		}
	}

	<-ctx.Done()
	slog.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
	return nil
}

// validateLoopback refuses to bind to anything other than 127.0.0.1/::1.
// This is the hard guarantee of local mode: if the user wanted to expose
// git-chat on a network interface they should use `serve` instead.
func validateLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid --http address: %w", err)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		return fmt.Errorf("local mode refuses to bind to %q — use 127.0.0.1 or ::1, or run `git-chat serve`", addr)
	}
	if host == "localhost" {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("unparseable host %q in --http", host)
	}
	if !ip.IsLoopback() {
		return fmt.Errorf("local mode refuses non-loopback host %q — run `git-chat serve` for network exposure", host)
	}
	return nil
}

// openBrowser launches the user's default browser pointing at url. Best
// effort — failure is non-fatal; the user can click the link printed to
// stderr instead.
func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		if _, err := exec.LookPath("xdg-open"); err != nil {
			return err
		}
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}

