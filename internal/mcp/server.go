// Package mcp exposes git-chat's repository + knowledge-card primitives
// as MCP tools, so Claude Code, Cursor, or any MCP client can query
// the repo-grounded knowledge base programmatically.
//
// Tools:
//   - search_knowledge: FTS5 search over cached KB cards
//   - get_file: retrieve file content at any ref
//   - get_diff: unified diff between two refs
//   - list_commits: recent commit log
//   - search_files: grep file names in the repo tree
//   - search_code: regex search via ripgrep
//   - outline: symbol extraction via ctags
//   - list_tree: directory listing at any ref
//   - list_branches: local branches with commit info
//   - get_blame: per-line blame annotation
package mcp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/repo"
	"github.com/pders01/git-chat/internal/storage"
)

// Config holds dependencies for the MCP server.
type Config struct {
	Registry *repo.Registry
	DB       *storage.DB
	Version  string
}

// NewServer creates an MCP server with all git-chat tools registered.
func NewServer(cfg Config) *server.MCPServer {
	s := server.NewMCPServer("git-chat", cfg.Version)

	// Default to first repo if only one registered.
	getRepo := func(id string) *repo.Entry {
		if id != "" {
			return cfg.Registry.Get(id)
		}
		list := cfg.Registry.List()
		if len(list) > 0 {
			return list[0]
		}
		return nil
	}

	// ── search_knowledge ──────────────────────────────────────
	s.AddTool(
		mcp.Tool{
			Name:        "search_knowledge",
			Description: "Search the knowledge base for cached answers. Returns the best-matching card if one exists, or empty if no match. Cards are git-aware — stale answers are excluded.",
			InputSchema: mcp.ToolInputSchema{
				Type: "object",
				Properties: map[string]any{
					"query":   map[string]any{"type": "string", "description": "The question to search for"},
					"repo_id": map[string]any{"type": "string", "description": "Repository ID (optional, defaults to first repo)"},
				},
				Required: []string{"query"},
			},
		},
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			query, _ := req.GetArguments()["query"].(string)
			repoID, _ := req.GetArguments()["repo_id"].(string)
			if query == "" {
				return mcp.NewToolResultError("query is required"), nil
			}
			r := getRepo(repoID)
			if r == nil {
				return mcp.NewToolResultError("repo not found"), nil
			}
			normalized := storage.NormalizeQuestion(query)
			card, err := cfg.DB.FindValidCard(ctx, r.ID, normalized)
			if err != nil {
				return mcp.NewToolResultText("No matching knowledge card found."), nil
			}
			return mcp.NewToolResultText(fmt.Sprintf(
				"**Knowledge Card** (hit #%d, model: %s, commit: %s)\n\n%s",
				card.HitCount+1, card.Model, repo.ShortSHA(card.CreatedCommit), card.AnswerMD,
			)), nil
		},
	)

	// ── get_file ──────────────────────────────────────────────
	s.AddTool(
		mcp.Tool{
			Name:        "get_file",
			Description: "Get the contents of a file from the repository. Supports reading at any ref (branch, tag, SHA). Defaults to HEAD.",
			InputSchema: mcp.ToolInputSchema{
				Type: "object",
				Properties: map[string]any{
					"path":    map[string]any{"type": "string", "description": "File path relative to repo root"},
					"ref":     map[string]any{"type": "string", "description": "Git ref (branch, tag, SHA). Empty = HEAD."},
					"repo_id": map[string]any{"type": "string", "description": "Repository ID (optional)"},
				},
				Required: []string{"path"},
			},
		},
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			path, _ := req.GetArguments()["path"].(string)
			ref, _ := req.GetArguments()["ref"].(string)
			repoID, _ := req.GetArguments()["repo_id"].(string)
			r := getRepo(repoID)
			if r == nil {
				return mcp.NewToolResultError("repo not found"), nil
			}
			resp, err := r.GetFile(ref, path, 64*1024)
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("file not found: %s", path)), nil
			}
			if resp.IsBinary {
				return mcp.NewToolResultText(fmt.Sprintf("Binary file: %s (%d bytes)", path, resp.Size)), nil
			}
			trunc := ""
			if resp.Truncated {
				trunc = "\n\n…[truncated]"
			}
			return mcp.NewToolResultText(string(resp.Content) + trunc), nil
		},
	)

	// ── get_diff ──────────────────────────────────────────────
	s.AddTool(
		mcp.Tool{
			Name:        "get_diff",
			Description: "Get a unified diff for a file or entire commit. Empty from_ref defaults to parent of to_ref. Empty path returns whole-commit diff.",
			InputSchema: mcp.ToolInputSchema{
				Type: "object",
				Properties: map[string]any{
					"from_ref": map[string]any{"type": "string", "description": "Start ref (branch/SHA, empty = parent of to_ref)"},
					"to_ref":   map[string]any{"type": "string", "description": "End ref (empty = HEAD)"},
					"path":     map[string]any{"type": "string", "description": "File path (empty = whole commit)"},
					"repo_id":  map[string]any{"type": "string", "description": "Repository ID (optional)"},
				},
			},
		},
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			fromRef, _ := req.GetArguments()["from_ref"].(string)
			toRef, _ := req.GetArguments()["to_ref"].(string)
			path, _ := req.GetArguments()["path"].(string)
			repoID, _ := req.GetArguments()["repo_id"].(string)
			r := getRepo(repoID)
			if r == nil {
				return mcp.NewToolResultError("repo not found"), nil
			}
			diff, _, _, empty, _, err := r.GetDiff(ctx, fromRef, toRef, path, "", false, false, false)
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("diff error: %v", err)), nil
			}
			if empty {
				return mcp.NewToolResultText("No changes."), nil
			}
			return mcp.NewToolResultText(diff), nil
		},
	)

	// ── list_commits ──────────────────────────────────────────
	s.AddTool(
		mcp.Tool{
			Name:        "list_commits",
			Description: "List recent commits. Returns SHA, message, author, and diff stats.",
			InputSchema: mcp.ToolInputSchema{
				Type: "object",
				Properties: map[string]any{
					"limit":   map[string]any{"type": "number", "description": "Max commits to return (default 10)"},
					"repo_id": map[string]any{"type": "string", "description": "Repository ID (optional)"},
				},
			},
		},
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			limit := 10
			if l, ok := req.GetArguments()["limit"].(float64); ok && l > 0 {
				limit = int(l)
			}
			repoID, _ := req.GetArguments()["repo_id"].(string)
			r := getRepo(repoID)
			if r == nil {
				return mcp.NewToolResultError("repo not found"), nil
			}
			commits, _, err := r.ListCommits(ctx, "", limit, 0, "")
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("error: %v", err)), nil
			}
			var sb strings.Builder
			for _, c := range commits {
				fmt.Fprintf(&sb, "%s %s (%s) +%d -%d\n",
					c.ShortSha, c.Message, c.AuthorName, c.Additions, c.Deletions)
			}
			return mcp.NewToolResultText(sb.String()), nil
		},
	)

	// ── search_files ──────────────────────────────────────────
	s.AddTool(
		mcp.Tool{
			Name:        "search_files",
			Description: "Search for files in the repository by path pattern. Returns matching file paths.",
			InputSchema: mcp.ToolInputSchema{
				Type: "object",
				Properties: map[string]any{
					"pattern": map[string]any{"type": "string", "description": "Substring to match against file paths (case-insensitive)"},
					"repo_id": map[string]any{"type": "string", "description": "Repository ID (optional)"},
				},
				Required: []string{"pattern"},
			},
		},
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			pattern, _ := req.GetArguments()["pattern"].(string)
			repoID, _ := req.GetArguments()["repo_id"].(string)
			if pattern == "" {
				return mcp.NewToolResultError("pattern is required"), nil
			}
			r := getRepo(repoID)
			if r == nil {
				return mcp.NewToolResultError("repo not found"), nil
			}
			paths, err := r.AllFilePaths()
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("error: %v", err)), nil
			}
			lower := strings.ToLower(pattern)
			var matches []string
			for _, p := range paths {
				if strings.Contains(strings.ToLower(p), lower) {
					matches = append(matches, p)
				}
			}
			if len(matches) == 0 {
				return mcp.NewToolResultText("No files matching pattern."), nil
			}
			if len(matches) > 50 {
				matches = matches[:50]
			}
			return mcp.NewToolResultText(strings.Join(matches, "\n")), nil
		},
	)

	// ── search_code ──────────────────────────────────────────
	s.AddTool(
		mcp.Tool{
			Name:        "search_code",
			Description: "Search file contents using ripgrep (PCRE2 regex). Returns matching lines as path:line:text.",
			InputSchema: mcp.ToolInputSchema{
				Type: "object",
				Properties: map[string]any{
					"query":          map[string]any{"type": "string", "description": "PCRE2 regex pattern (or literal if literal=true)"},
					"path":           map[string]any{"type": "string", "description": "Directory to scope search (optional)"},
					"glob":           map[string]any{"type": "string", "description": "Glob filter, e.g. '**/*.go' (optional)"},
					"literal":        map[string]any{"type": "boolean", "description": "Treat query as literal string (default false)"},
					"case_sensitive": map[string]any{"type": "boolean", "description": "Case-sensitive match (default false, smart-case)"},
					"repo_id":        map[string]any{"type": "string", "description": "Repository ID (optional)"},
				},
				Required: []string{"query"},
			},
		},
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			query, _ := req.GetArguments()["query"].(string)
			path, _ := req.GetArguments()["path"].(string)
			glob, _ := req.GetArguments()["glob"].(string)
			literal, _ := req.GetArguments()["literal"].(bool)
			caseSensitive, _ := req.GetArguments()["case_sensitive"].(bool)
			repoID, _ := req.GetArguments()["repo_id"].(string)
			if query == "" {
				return mcp.NewToolResultError("query is required"), nil
			}
			r := getRepo(repoID)
			if r == nil {
				return mcp.NewToolResultError("repo not found"), nil
			}
			if _, err := exec.LookPath("rg"); err != nil {
				return mcp.NewToolResultError("ripgrep (rg) not installed"), nil
			}
			cli := []string{
				"--no-heading", "--line-number", "--color=never",
				"--max-columns=240", "--max-count=80", "--pcre2",
			}
			if literal {
				cli = append(cli, "--fixed-strings")
			}
			if caseSensitive {
				cli = append(cli, "--case-sensitive")
			} else {
				cli = append(cli, "--smart-case")
			}
			if glob != "" {
				cli = append(cli, "--glob", glob)
			}
			cli = append(cli, "--", query)
			scope := "."
			if path != "" {
				clean := filepath.Clean(path)
				if filepath.IsAbs(clean) || strings.HasPrefix(clean, "..") {
					return mcp.NewToolResultError("path must be relative to repo root"), nil
				}
				scope = clean
			}
			cli = append(cli, scope)
			cmd := exec.CommandContext(ctx, "rg", cli...)
			cmd.Dir = r.Path
			var stdout, stderr bytes.Buffer
			cmd.Stdout = &stdout
			cmd.Stderr = &stderr
			err := cmd.Run()
			if err != nil {
				// rg exits 1 when no matches, 2+ on real errors.
				var exitErr *exec.ExitError
				if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
					return mcp.NewToolResultText(fmt.Sprintf("(no matches for %q)", query)), nil
				}
				if stdout.Len() == 0 {
					return mcp.NewToolResultError(fmt.Sprintf("rg failed: %s", strings.TrimSpace(stderr.String()))), nil
				}
			}
			out := stdout.String()
			if len(out) > 32*1024 {
				out = out[:32*1024] + "\n…(truncated)"
			}
			return mcp.NewToolResultText(out), nil
		},
	)

	// ── outline ──────────────────────────────────────────────
	s.AddTool(
		mcp.Tool{
			Name:        "outline",
			Description: "Extract code symbols (functions, types, classes) from a file or directory using ctags. Returns line, kind, and name for each symbol.",
			InputSchema: mcp.ToolInputSchema{
				Type: "object",
				Properties: map[string]any{
					"path":    map[string]any{"type": "string", "description": "File or directory path relative to repo root"},
					"repo_id": map[string]any{"type": "string", "description": "Repository ID (optional)"},
				},
				Required: []string{"path"},
			},
		},
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			path, _ := req.GetArguments()["path"].(string)
			repoID, _ := req.GetArguments()["repo_id"].(string)
			if path == "" {
				return mcp.NewToolResultError("path is required"), nil
			}
			clean := filepath.Clean(path)
			if filepath.IsAbs(clean) || strings.HasPrefix(clean, "..") {
				return mcp.NewToolResultError("path must be relative to repo root"), nil
			}
			r := getRepo(repoID)
			if r == nil {
				return mcp.NewToolResultError("repo not found"), nil
			}
			if _, err := exec.LookPath("ctags"); err != nil {
				return mcp.NewToolResultError("ctags not installed (install universal-ctags)"), nil
			}
			cmd := exec.CommandContext(ctx, "ctags",
				"--output-format=json", "--fields=+nKs", "--extras=", "--sort=no",
				"-R", "--languages=Go,TypeScript,JavaScript,Python,Rust,C,C++,Java,Ruby",
				"-f", "-", clean,
			)
			cmd.Dir = r.Path
			var stdout, stderr bytes.Buffer
			cmd.Stdout = &stdout
			cmd.Stderr = &stderr
			if err := cmd.Run(); err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("ctags failed: %s", strings.TrimSpace(stderr.String()))), nil
			}
			out := stdout.String()
			if len(out) > 32*1024 {
				out = out[:32*1024] + "\n…(truncated)"
			}
			return mcp.NewToolResultText(out), nil
		},
	)

	// ── list_tree ────────────────────────────────────────────
	s.AddTool(
		mcp.Tool{
			Name:        "list_tree",
			Description: "List files and directories at a path in the repository. Supports reading at any ref.",
			InputSchema: mcp.ToolInputSchema{
				Type: "object",
				Properties: map[string]any{
					"path":    map[string]any{"type": "string", "description": "Directory path (empty = repo root)"},
					"ref":     map[string]any{"type": "string", "description": "Git ref (branch, tag, SHA). Empty = HEAD."},
					"repo_id": map[string]any{"type": "string", "description": "Repository ID (optional)"},
				},
			},
		},
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			path, _ := req.GetArguments()["path"].(string)
			ref, _ := req.GetArguments()["ref"].(string)
			repoID, _ := req.GetArguments()["repo_id"].(string)
			r := getRepo(repoID)
			if r == nil {
				return mcp.NewToolResultError("repo not found"), nil
			}
			entries, _, err := r.ListTree(ref, path)
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("list_tree: %v", err)), nil
			}
			if len(entries) == 0 {
				return mcp.NewToolResultText(fmt.Sprintf("(empty directory %q)", path)), nil
			}
			var sb strings.Builder
			for i, e := range entries {
				if i >= 200 {
					sb.WriteString("…(truncated)\n")
					break
				}
				suffix := ""
				if e.Type == gitchatv1.EntryType_ENTRY_TYPE_DIR {
					suffix = "/"
				}
				sb.WriteString(e.Name)
				sb.WriteString(suffix)
				sb.WriteString("\n")
			}
			return mcp.NewToolResultText(sb.String()), nil
		},
	)

	// ── list_branches ────────────────────────────────────────
	s.AddTool(
		mcp.Tool{
			Name:        "list_branches",
			Description: "List local branches sorted by most recent commit.",
			InputSchema: mcp.ToolInputSchema{
				Type: "object",
				Properties: map[string]any{
					"repo_id": map[string]any{"type": "string", "description": "Repository ID (optional)"},
				},
			},
		},
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			repoID, _ := req.GetArguments()["repo_id"].(string)
			r := getRepo(repoID)
			if r == nil {
				return mcp.NewToolResultError("repo not found"), nil
			}
			branches, err := r.ListBranches(ctx)
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("error: %v", err)), nil
			}
			var sb strings.Builder
			for _, b := range branches {
				fmt.Fprintf(&sb, "%s %s %s\n", b.Name, repo.ShortSHA(b.Commit), b.Subject)
			}
			return mcp.NewToolResultText(sb.String()), nil
		},
	)

	// ── get_blame ────────────────────────────────────────────
	s.AddTool(
		mcp.Tool{
			Name:        "get_blame",
			Description: "Get per-line blame annotation for a file. Shows author, date, and commit SHA for each line.",
			InputSchema: mcp.ToolInputSchema{
				Type: "object",
				Properties: map[string]any{
					"path":    map[string]any{"type": "string", "description": "File path relative to repo root"},
					"ref":     map[string]any{"type": "string", "description": "Git ref (branch, tag, SHA). Empty = HEAD."},
					"repo_id": map[string]any{"type": "string", "description": "Repository ID (optional)"},
				},
				Required: []string{"path"},
			},
		},
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			path, _ := req.GetArguments()["path"].(string)
			ref, _ := req.GetArguments()["ref"].(string)
			repoID, _ := req.GetArguments()["repo_id"].(string)
			r := getRepo(repoID)
			if r == nil {
				return mcp.NewToolResultError("repo not found"), nil
			}
			lines, err := r.GetBlame(ctx, ref, path)
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("blame error: %v", err)), nil
			}
			var sb strings.Builder
			for i, l := range lines {
				fmt.Fprintf(&sb, "%s %-16s %4d: %s\n",
					repo.ShortSHA(l.CommitSha), l.AuthorName, i+1, l.Text)
			}
			out := sb.String()
			if len(out) > 64*1024 {
				out = out[:64*1024] + "\n…(truncated)"
			}
			return mcp.NewToolResultText(out), nil
		},
	)

	return s
}

