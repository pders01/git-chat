// git-chat is a self-hosted persistent chat against a git repository with
// an auto-curated, git-aware knowledge base. See docs/ARCHITECTURE.md for
// the full design.
//
// Usage:
//
//	git chat              open current directory (or nearest git root)
//	git chat <path>       open a specific repo or directory of repos
//	git chat serve        multi-user, HTTP + SSH pairing
//	git chat local        explicit solo-local mode
//	git chat mcp          MCP server mode (stdio)
//	git chat add-key      append SSH pubkey from stdin
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// version is overridden at build time via -ldflags.
var version = "dev"

func main() {
	// No args → run local mode on current directory.
	if len(os.Args) < 2 {
		if err := runLocal([]string{"."}); err != nil {
			fail(err)
		}
		return
	}

	cmd, args := os.Args[1], os.Args[2:]

	// Explicit subcommands.
	switch cmd {
	case "serve":
		if err := runServe(args); err != nil {
			fail(err)
		}
	case "local":
		if err := runLocal(args); err != nil {
			fail(err)
		}
	case "add-key":
		if err := runAddKey(args); err != nil {
			fail(err)
		}
	case "mcp":
		if err := runMCP(args); err != nil {
			fail(err)
		}
	case "-h", "--help", "help":
		usage()
	case "-v", "--version", "version":
		fmt.Println("git-chat", version)
	default:
		// Not a known subcommand — treat as a path.
		if looksLikePath(cmd) {
			if err := runLocal(os.Args[1:]); err != nil {
				fail(err)
			}
		} else {
			fmt.Fprintf(os.Stderr, "git-chat: unknown subcommand %q\n\n", cmd)
			usage()
			os.Exit(2)
		}
	}
}

// looksLikePath returns true if s looks like a file path rather than a
// subcommand or flag.
func looksLikePath(s string) bool {
	if strings.HasPrefix(s, "-") {
		return false
	}
	if s == "." || s == ".." || strings.Contains(s, string(filepath.Separator)) || strings.HasPrefix(s, "~") {
		return true
	}
	// Check if it exists on disk.
	_, err := os.Stat(s)
	return err == nil
}

func usage() {
	fmt.Fprintln(os.Stderr, `git-chat — chat with a git repo, with a self-curated knowledge base.

usage:
  git chat                      open current repo in browser
  git chat <path>               open a specific repo or directory
  git chat serve [flags]        multi-user self-hosted mode
  git chat local [path] [flags] explicit solo-local mode
  git chat mcp [path]           MCP server mode (stdio)
  git chat add-key <principal>  append SSH pubkey from stdin
  git chat version              print version
  git chat help                 show this help

flags (local/serve):
  --http <addr>           listen address (default: 127.0.0.1:0)
  --llm-backend <name>   openai (default) or anthropic
  --llm-model <name>     model name
  --llm-api-key <key>    API key
  --no-browser            don't auto-open browser

examples:
  cd ~/myproject && git chat                    # chat about current repo
  git chat ~/Projects/myproject                 # specific repo
  git chat serve --repo ~/r1 --repo ~/r2       # multi-repo server`)
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "git-chat: %v\n", err)
	os.Exit(1)
}
