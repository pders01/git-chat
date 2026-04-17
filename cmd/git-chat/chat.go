package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/auth"
	"github.com/pders01/git-chat/internal/chat"
	"github.com/pders01/git-chat/internal/chat/tools"
	"github.com/pders01/git-chat/internal/config"
	"github.com/pders01/git-chat/internal/repo"
	"github.com/pders01/git-chat/internal/webhook"
)

// runChat is a headless one-shot chat invocation: "git-chat chat [flags]
// MESSAGE…" opens a session against the current repo, streams the
// assistant reply to stdout, and exits. Meant for development
// iteration — skips the HTTP/UI layer entirely and calls the service
// in-process via StreamMessage.
//
//	git-chat chat "what does the log tab do?"
//	git-chat chat --repo ../koha --session 9f3a… "and the 3-pane diff?"
//	GITCHAT_CLI_VERBOSE=1 git-chat chat "…"     # show chunk kinds
func runChat(args []string) error {
	fs := flag.NewFlagSet("chat", flag.ExitOnError)
	repoPath := fs.String("repo", ".", "path to the git repository")
	sessionID := fs.String("session", "", "existing session id (omit to start a new session)")
	llmBackend := fs.String("llm-backend", envOr("LLM_BACKEND", "openai"), "LLM backend: 'openai' or 'anthropic'")
	llmBase := fs.String("llm-base-url", envOr("LLM_BASE_URL", "http://localhost:1234/v1"), "OpenAI-compatible base URL")
	llmModel := fs.String("llm-model", envOr("LLM_MODEL", ""), "model name (backend default if empty)")
	llmKey := fs.String("llm-api-key", envOr("LLM_API_KEY", ""), "API key (required for anthropic)")
	llmTemp := fs.Float64("llm-temperature", envFloat("LLM_TEMPERATURE", 0), "temperature")
	llmMaxTok := fs.Int("llm-max-tokens", envIntFlag("LLM_MAX_TOKENS", 0), "max response tokens (0 = provider default)")
	dbPath := fs.String("db", envOr("GITCHAT_DB", ""), "SQLite state path")
	enableTools := fs.Bool("tools", envOr("GITCHAT_TOOLS", "") != "", "enable agentic tool use (read_file, list_tree, search_paths, get_diff)")
	_ = fs.Parse(args)

	message := strings.TrimSpace(strings.Join(fs.Args(), " "))
	if message == "" {
		return errors.New("usage: git-chat chat [flags] \"message\"")
	}

	// Logging to stderr so the assistant reply on stdout stays clean
	// and pipe-friendly. "warn" keeps startup quiet; set
	// GITCHAT_CLI_LOG=debug for the agentic-loop traces.
	installLogger(os.Stderr, envOr("GITCHAT_CLI_LOG", "warn"))

	registry := repo.NewRegistry()
	entry, err := registry.Add(*repoPath)
	if err != nil {
		return fmt.Errorf("register repo %q: %w", *repoPath, err)
	}

	db, err := openDB(*dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	cfg := config.New(db)
	config.RegisterDefaults(cfg)

	llmAdapter, err := buildLLM(*llmBackend, *llmBase, *llmKey, llmModel)
	if err != nil {
		return err
	}

	svc := &chat.Service{
		DB:                db,
		LLM:               llmAdapter,
		Repos:             registry,
		Model:             *llmModel,
		Temperature:       float32(*llmTemp),
		MaxTokens:         *llmMaxTok,
		Webhook:           webhook.New(cfg.Get("GITCHAT_WEBHOOK_URL")),
		DisableSmartTitle: true, // no sidebar to display a title in
	}
	if *enableTools {
		svc.Tools = tools.Default()
	}

	// StreamMessage reads the principal from context; synthesize a
	// stable "cli" principal so sessions created here don't clash with
	// web-UI sessions (which use a different principal).
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx = auth.WithPrincipal(ctx, "cli", gitchatv1.AuthMode_AUTH_MODE_LOCAL)

	verbose := os.Getenv("GITCHAT_CLI_VERBOSE") != ""
	var doneErr string

	onChunk := func(c *gitchatv1.MessageChunk) error {
		switch k := c.Kind.(type) {
		case *gitchatv1.MessageChunk_Started:
			// Surface the new session id to stderr whenever we created
			// one so the next invocation can resume via --session
			// without needing verbose mode.
			if k.Started.SessionId != "" {
				fmt.Fprintf(os.Stderr, "session: %s\n", k.Started.SessionId)
			}
			if verbose {
				fmt.Fprintf(os.Stderr, "[started user_msg=%s]\n", k.Started.UserMessageId)
			}
			for _, w := range k.Started.Warnings {
				fmt.Fprintf(os.Stderr, "⚠ %s\n", w)
			}
		case *gitchatv1.MessageChunk_Token:
			fmt.Print(k.Token)
		case *gitchatv1.MessageChunk_Thinking:
			if verbose {
				fmt.Fprint(os.Stderr, dimText(k.Thinking))
			}
		case *gitchatv1.MessageChunk_ToolCall:
			fmt.Fprintf(os.Stderr, "\n→ %s(%s)\n", k.ToolCall.Name, truncForCLI(k.ToolCall.ArgsJson, 120))
		case *gitchatv1.MessageChunk_ToolResult:
			tag := "✓"
			if k.ToolResult.IsError {
				tag = "✗"
			}
			fmt.Fprintf(os.Stderr, "  %s %s\n", tag, truncForCLI(k.ToolResult.Content, 200))
		case *gitchatv1.MessageChunk_CardHit:
			fmt.Print(k.CardHit.AnswerMd)
			if verbose {
				fmt.Fprintf(os.Stderr, "\n[kb hit card=%s model=%s hits=%d]\n",
					k.CardHit.CardId, k.CardHit.Model, k.CardHit.HitCount)
			}
		case *gitchatv1.MessageChunk_Done:
			fmt.Println()
			doneErr = k.Done.Error
			if verbose {
				fmt.Fprintf(os.Stderr, "[done session=%s in=%d out=%d model=%s]\n",
					k.Done.SessionId, k.Done.TokenCountIn, k.Done.TokenCountOut, k.Done.Model)
			}
		}
		return nil
	}

	req := &gitchatv1.SendMessageRequest{
		SessionId: *sessionID,
		RepoId:    entry.ID,
		Text:      message,
	}
	if err := svc.StreamMessage(ctx, req, onChunk); err != nil {
		return fmt.Errorf("stream: %w", err)
	}
	if doneErr != "" {
		return fmt.Errorf("llm: %s", doneErr)
	}
	return nil
}

// truncForCLI collapses whitespace and caps the string at n runes so
// a verbose tool payload doesn't swamp the terminal. Newlines become
// spaces so tool output stays on a single line.
func truncForCLI(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// dimText wraps text in ANSI dim so reasoning traces read as
// secondary output alongside the final answer on stdout.
func dimText(s string) string {
	return "\x1b[2m" + s + "\x1b[0m"
}

