// git-chat is a self-hosted persistent chat against a git repository with
// an auto-curated, git-aware knowledge base. See docs/ARCHITECTURE.md for
// the full design.
//
// Subcommands:
//
//	git-chat serve               multi-user, HTTP + SSH pairing
//	git-chat local [repo-path]   solo, loopback-only, one-time claim URL
//	git-chat add-key <principal> append stdin pubkey to allowed_signers
package main

import (
	"fmt"
	"os"
)

// version is overridden at build time via -ldflags.
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
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
	default:
		fmt.Fprintf(os.Stderr, "git-chat: unknown subcommand %q\n\n", cmd)
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `git-chat — chat with a git repo, with a self-curated knowledge base.

usage:
  git-chat serve [--http :8080] [--ssh :2222]
      multi-user self-hosted. SSH pairing flow for login.

  git-chat local [repo-path] [--http 127.0.0.1:0]
      solo-local. Binds loopback only, prints a one-time claim URL.

  git-chat add-key <principal>
      append an ssh pubkey from stdin to ~/.config/git-chat/allowed_signers
      example: git-chat add-key paul@laptop < ~/.ssh/id_ed25519.pub

  git-chat mcp [repo-path]
      MCP server mode (stdio). Exposes tools: search_knowledge, get_file,
      get_diff, list_commits, search_files.`)
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "git-chat: %v\n", err)
	os.Exit(1)
}
