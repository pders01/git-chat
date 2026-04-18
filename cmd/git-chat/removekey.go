package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/pders01/git-chat/internal/auth"
)

func runRemoveKey(args []string) error {
	if len(args) < 1 {
		return errors.New("usage: git-chat remove-key <principal>")
	}
	principal := args[0]

	path, err := auth.AllowedSignersPath()
	if err != nil {
		return fmt.Errorf("resolve allowed_signers path: %w", err)
	}
	n, err := auth.RemoveAllowedSignersByPrincipal(path, principal)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "%s %s (%d key(s) removed from %s)\n",
		styleBrand.Render("removed"),
		styleHeading.Render(principal),
		n,
		styleURL.Render(path))
	return nil
}
