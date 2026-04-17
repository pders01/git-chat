// Package tools owns the read-only tool catalog that the chat service
// exposes to the LLM for agentic multi-turn reasoning. Every tool is
// scoped to a single repo.Entry, takes structured JSON arguments, and
// returns a text result with hard per-tool output caps so a runaway
// model cannot blow the prompt budget.
//
// Tools live here (not in internal/chat) so the catalog is easy to
// test in isolation and so the LLM-adapter glue in internal/chat can
// import it without pulling in the whole service graph.
package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/repo"
)

// ErrUnknownTool is returned when the model emits a tool_use for a
// name that is not in the registry. The service surfaces this as a
// tool_result with isError=true so the model can recover rather than
// hanging the stream.
var ErrUnknownTool = errors.New("tools: unknown tool")

// Spec describes one tool for the LLM: its name, a short description,
// and the JSON Schema for its arguments. The schema is a free-form
// json.RawMessage so adapters can hand it straight to the provider
// (Anthropic and OpenAI both want draft-07-ish schemas verbatim).
type Spec struct {
	Name        string
	Description string
	InputSchema json.RawMessage
}

// Handler executes a single tool invocation and returns the text
// result the model will see. Handlers must respect the output cap
// documented on their Spec so no single call dominates the prompt.
type Handler func(ctx context.Context, entry *repo.Entry, args json.RawMessage) (string, error)

// Registry pairs Specs with Handlers. All tools in the registry are
// exposed to the LLM on every SendMessage call; visibility is not
// request-scoped in v1.
type Registry struct {
	specs    []Spec
	handlers map[string]Handler
}

// Default returns the production registry: read_file, list_tree,
// search_paths, get_diff. Callers should not mutate the returned
// registry — it is safe to share across goroutines.
func Default() *Registry {
	r := &Registry{handlers: map[string]Handler{}}
	r.Register(readFileSpec, handleReadFile)
	r.Register(listTreeSpec, handleListTree)
	r.Register(searchPathsSpec, handleSearchPaths)
	r.Register(getDiffSpec, handleGetDiff)
	return r
}

// Register adds a new tool to the registry. Duplicate names overwrite
// silently; callers are expected to wire registration once at
// construction time.
func (r *Registry) Register(s Spec, h Handler) {
	r.specs = append(r.specs, s)
	r.handlers[s.Name] = h
}

// Specs returns the list of declared tool specs in registration order.
func (r *Registry) Specs() []Spec {
	return r.specs
}

// Execute dispatches a tool call. On an unknown name it returns
// ErrUnknownTool; handler errors flow through unchanged so callers can
// distinguish "tool failed" from "tool does not exist".
func (r *Registry) Execute(ctx context.Context, entry *repo.Entry, name string, args json.RawMessage) (string, error) {
	h, ok := r.handlers[name]
	if !ok {
		return "", fmt.Errorf("%w: %s", ErrUnknownTool, name)
	}
	return h(ctx, entry, args)
}

// ── Caps ────────────────────────────────────────────────────────────
// Per-tool caps on bytes / entries / matches. Tuned conservatively —
// the model can always call a tool again with a narrower scope if it
// needs more. Better to force several pinpoint calls than to hand
// back a megabyte of context that drowns out subsequent reasoning.
const (
	readFileMaxBytes   = 64 * 1024
	listTreeMaxEntries = 200
	searchPathsMaxHits = 50
	getDiffMaxBytes    = 32 * 1024
)

// ── read_file ───────────────────────────────────────────────────────

var readFileSpec = Spec{
	Name: "read_file",
	Description: "Return the contents of a file in the repository at " +
		"a given ref. Binary files return a placeholder. Results are " +
		"capped at 64KB — ask for a specific subpath or call again " +
		"for more.",
	InputSchema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"path": {"type": "string", "description": "Repository-relative file path, e.g. internal/auth/service.go"},
			"ref":  {"type": "string", "description": "Optional git ref (branch, tag, SHA). Defaults to HEAD."}
		},
		"required": ["path"]
	}`),
}

type readFileArgs struct {
	Path string `json:"path"`
	Ref  string `json:"ref"`
}

func handleReadFile(_ context.Context, entry *repo.Entry, raw json.RawMessage) (string, error) {
	var args readFileArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", fmt.Errorf("read_file: %w", err)
	}
	if args.Path == "" {
		return "", errors.New("read_file: path is required")
	}
	resp, err := entry.GetFile(args.Ref, args.Path, readFileMaxBytes)
	if err != nil {
		return "", err
	}
	if resp.IsBinary {
		return fmt.Sprintf("(binary file %q, %d bytes, blob %s)",
			args.Path, resp.Size, resp.BlobSha), nil
	}
	body := string(resp.Content)
	if resp.Truncated {
		body += fmt.Sprintf("\n… (truncated, full file is %d bytes)", resp.Size)
	}
	return body, nil
}

// ── list_tree ───────────────────────────────────────────────────────

var listTreeSpec = Spec{
	Name: "list_tree",
	Description: "List the direct children of a directory in the " +
		"repository. Pass an empty path for the repo root.",
	InputSchema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"path": {"type": "string", "description": "Repository-relative directory path. Empty = repo root."},
			"ref":  {"type": "string", "description": "Optional git ref. Defaults to HEAD."}
		}
	}`),
}

type listTreeArgs struct {
	Path string `json:"path"`
	Ref  string `json:"ref"`
}

func handleListTree(_ context.Context, entry *repo.Entry, raw json.RawMessage) (string, error) {
	var args listTreeArgs
	if raw != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return "", fmt.Errorf("list_tree: %w", err)
		}
	}
	entries, _, err := entry.ListTree(args.Ref, args.Path)
	if err != nil {
		return "", err
	}
	if len(entries) == 0 {
		return fmt.Sprintf("(empty directory %q)", args.Path), nil
	}
	truncated := false
	if len(entries) > listTreeMaxEntries {
		entries = entries[:listTreeMaxEntries]
		truncated = true
	}
	var sb strings.Builder
	for _, e := range entries {
		suffix := ""
		if e.Type == gitchatv1.EntryType_ENTRY_TYPE_DIR {
			suffix = "/"
		}
		sb.WriteString(e.Name)
		sb.WriteString(suffix)
		sb.WriteString("\n")
	}
	if truncated {
		fmt.Fprintf(&sb, "… (showing first %d entries)\n", listTreeMaxEntries)
	}
	return sb.String(), nil
}

// ── search_paths ────────────────────────────────────────────────────

var searchPathsSpec = Spec{
	Name: "search_paths",
	Description: "Find file paths in the repository whose name or " +
		"path contains the query substring (case-insensitive). " +
		"Returns up to 50 matches — refine the query for more precision.",
	InputSchema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"query": {"type": "string", "description": "Substring to match, case-insensitive."}
		},
		"required": ["query"]
	}`),
}

type searchPathsArgs struct {
	Query string `json:"query"`
}

func handleSearchPaths(_ context.Context, entry *repo.Entry, raw json.RawMessage) (string, error) {
	var args searchPathsArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", fmt.Errorf("search_paths: %w", err)
	}
	if args.Query == "" {
		return "", errors.New("search_paths: query is required")
	}
	paths, err := entry.AllFilePaths()
	if err != nil {
		return "", err
	}
	q := strings.ToLower(args.Query)
	matches := make([]string, 0, 64)
	for _, p := range paths {
		if strings.Contains(strings.ToLower(p), q) {
			matches = append(matches, p)
			if len(matches) >= searchPathsMaxHits+1 {
				break
			}
		}
	}
	if len(matches) == 0 {
		return fmt.Sprintf("(no files matching %q)", args.Query), nil
	}
	truncated := false
	if len(matches) > searchPathsMaxHits {
		matches = matches[:searchPathsMaxHits]
		truncated = true
	}
	sort.Strings(matches)
	var sb strings.Builder
	for _, m := range matches {
		sb.WriteString(m)
		sb.WriteString("\n")
	}
	if truncated {
		fmt.Fprintf(&sb, "… (showing first %d matches — narrow the query)\n", searchPathsMaxHits)
	}
	return sb.String(), nil
}

// ── get_diff ────────────────────────────────────────────────────────

var getDiffSpec = Spec{
	Name: "get_diff",
	Description: "Return a unified diff between two refs. Omit `from` " +
		"to diff against the parent of `to`; omit `to` for HEAD. Pass " +
		"`path` to scope to a single file or directory prefix. Result " +
		"is capped at 32KB.",
	InputSchema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"from": {"type": "string", "description": "Base ref. Default: parent of to."},
			"to":   {"type": "string", "description": "Target ref. Default: HEAD."},
			"path": {"type": "string", "description": "Optional file or directory to scope the diff to."}
		}
	}`),
}

type getDiffArgs struct {
	From string `json:"from"`
	To   string `json:"to"`
	Path string `json:"path"`
}

func handleGetDiff(ctx context.Context, entry *repo.Entry, raw json.RawMessage) (string, error) {
	var args getDiffArgs
	if raw != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return "", fmt.Errorf("get_diff: %w", err)
		}
	}
	diff, _, _, empty, _, err := entry.GetDiff(ctx, args.From, args.To, args.Path, false)
	if err != nil {
		return "", err
	}
	if empty {
		return fmt.Sprintf("(no changes between %q and %q at %q)",
			firstNonEmpty(args.From, "parent"), firstNonEmpty(args.To, "HEAD"),
			firstNonEmpty(args.Path, "whole repo")), nil
	}
	if len(diff) > getDiffMaxBytes {
		return diff[:getDiffMaxBytes] + "\n… (diff truncated — narrow by path or range)", nil
	}
	return diff, nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
