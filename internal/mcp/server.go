// Package mcp exposes git-chat's repository + knowledge-card primitives
// as MCP tools, so Claude Code, Cursor, or any MCP client can query
// the repo-grounded knowledge base programmatically.
//
// Tools:
//   - search_knowledge: FTS5 search over cached KB cards
//   - get_file: retrieve file content at HEAD
//   - get_diff: unified diff between two refs
//   - list_commits: recent commit log
//   - search_files: grep file names in the repo tree
package mcp

import (
	"context"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

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
				card.HitCount+1, card.Model, shortSHA(card.CreatedCommit), card.AnswerMD,
			)), nil
		},
	)

	// ── get_file ──────────────────────────────────────────────
	s.AddTool(
		mcp.Tool{
			Name:        "get_file",
			Description: "Get the contents of a file from the repository at HEAD.",
			InputSchema: mcp.ToolInputSchema{
				Type: "object",
				Properties: map[string]any{
					"path":    map[string]any{"type": "string", "description": "File path relative to repo root"},
					"repo_id": map[string]any{"type": "string", "description": "Repository ID (optional)"},
				},
				Required: []string{"path"},
			},
		},
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			path, _ := req.GetArguments()["path"].(string)
			repoID, _ := req.GetArguments()["repo_id"].(string)
			r := getRepo(repoID)
			if r == nil {
				return mcp.NewToolResultError("repo not found"), nil
			}
			resp, err := r.GetFile("", path, 32*1024)
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("file not found: %s", path)), nil
			}
			if resp.IsBinary {
				return mcp.NewToolResultText(fmt.Sprintf("Binary file: %s (%d bytes)", path, resp.Size)), nil
			}
			return mcp.NewToolResultText(string(resp.Content)), nil
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
			diff, _, _, empty, _, err := r.GetDiff(fromRef, toRef, path, false)
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

	return s
}

func shortSHA(s string) string { return repo.ShortSHA(s) }
