package main

import (
	"fmt"
	"os"
	"sort"

	"github.com/pders01/git-chat/internal/auth"
)

func runListKeys(_ []string) error {
	path, err := auth.AllowedSignersPath()
	if err != nil {
		return fmt.Errorf("resolve allowed_signers path: %w", err)
	}
	signers, err := auth.LoadAllowedSignersFile(path)
	if err != nil {
		return fmt.Errorf("load allowed_signers: %w", err)
	}
	entries := signers.List()
	if len(entries) == 0 {
		fmt.Fprintf(os.Stderr, "no keys registered (%s)\n", path)
		return nil
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Principal < entries[j].Principal
	})
	for _, e := range entries {
		fmt.Fprintf(os.Stdout, "%s %s %s\n",
			styleHeading.Render(e.Principal),
			styleDim.Render(e.KeyType),
			styleDim.Render(e.Fingerprint))
	}
	return nil
}
