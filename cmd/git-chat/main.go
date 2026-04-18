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
//	git chat chat "…"     headless one-shot chat, reply on stdout
//	git chat add-key      append SSH pubkey from stdin
//	git chat remove-key   revoke a principal's SSH key
//	git chat list-keys    show registered principals
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
	case "remove-key":
		if err := runRemoveKey(args); err != nil {
			fail(err)
		}
	case "list-keys":
		if err := runListKeys(args); err != nil {
			fail(err)
		}
	case "mcp":
		if err := runMCP(args); err != nil {
			fail(err)
		}
	case "chat":
		if err := runChat(args); err != nil {
			fail(err)
		}
	case "-h", "--help", "help":
		usage()
	case "-v", "--version", "version":
		fmt.Println("git-chat", version)
	default:
		// Not a known subcommand — treat as a path, revspec, or flag-only
		// local invocation (e.g. `git chat --range HEAD~3..HEAD`).
		if strings.HasPrefix(cmd, "-") || looksLikePath(cmd) || looksLikeRevspec(cmd) {
			if err := runLocal(os.Args[1:]); err != nil {
				fail(err)
			}
		} else {
			fmt.Fprint(os.Stderr, renderFatal(fmt.Errorf("unknown subcommand %q", cmd)))
			fmt.Fprintln(os.Stderr)
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

// looksLikeRevspec returns true if s looks like a git revspec (e.g.
// HEAD~3..HEAD, main..feature, v1.0...v2.0). Single refs go through the
// --range flag since they are indistinguishable from unknown subcommands.
func looksLikeRevspec(s string) bool {
	if strings.HasPrefix(s, "-") {
		return false
	}
	return strings.Contains(s, "..")
}

func usage() {
	fmt.Fprint(os.Stderr, renderUsage())
}

func fail(err error) {
	fmt.Fprint(os.Stderr, renderFatal(err))
	os.Exit(1)
}
