package main

import (
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/pders01/git-chat/internal/auth"
	gossh "golang.org/x/crypto/ssh"
)

func runAddKey(args []string) error {
	if len(args) < 1 {
		return errors.New("usage: git-chat add-key <principal> < pubkey")
	}
	principal := args[0]

	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return fmt.Errorf("read stdin: %w", err)
	}
	pk, _, _, _, err := gossh.ParseAuthorizedKey(raw)
	if err != nil {
		return fmt.Errorf("parse pubkey from stdin: %w", err)
	}

	path, err := auth.AllowedSignersPath()
	if err != nil {
		return fmt.Errorf("resolve allowed_signers path: %w", err)
	}
	if err := auth.AppendAllowedSignersFile(path, principal, pk); err != nil {
		return fmt.Errorf("append: %w", err)
	}
	fmt.Fprintf(os.Stderr, "added %s → %s\n", principal, path)
	return nil
}
