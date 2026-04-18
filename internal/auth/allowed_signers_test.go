package auth_test

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/pders01/git-chat/internal/auth"
)

// Test allowed_signers file operations

func TestParseAllowedSignersValid(t *testing.T) {
	// Use a known-valid ed25519 key format (64 chars base64)
	// ed25519 public keys are 32 bytes = 44 base64 chars when encoded
	input := `paul@laptop ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDIhz2GK/XCUj4i6Q5yQJNL1MXMY0RxzPV2QrBqfHr1C test comment
alice@desktop ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDIhz2GK/XCUj4i6Q5yQJNL1MXMY0RxzPV2QrBqfHr1D
`

	signers, err := auth.ParseAllowedSigners(strings.NewReader(input))
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}

	if count := signers.Count(); count != 2 {
		t.Fatalf("expected 2 signers, got %d", count)
	}
}

func TestParseAllowedSignersInvalid(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"too few fields", "paul@laptop ssh-ed25519"},
		{"invalid key type", "paul@laptop invalid-type AAAABase64"},
		{"malformed base64", "paul@laptop ssh-ed25519 not@@@valid!!!base64"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := auth.ParseAllowedSigners(strings.NewReader(tt.input))
			if err == nil {
				t.Fatal("expected parse error, got nil")
			}
		})
	}
}

func TestLoadAllowedSignersFileMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nonexistent")

	signers, err := auth.LoadAllowedSignersFile(path)
	if err != nil {
		t.Fatalf("unexpected error for missing file: %v", err)
	}
	if signers.Count() != 0 {
		t.Fatal("expected empty signers for missing file")
	}
}

func TestLoadAllowedSignersFileExists(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "allowed_signers")

	content := `paul@laptop ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDIhz2GK/XCUj4i6Q5yQJNL1MXMY0RxzPV2QrBqfHr1C
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	signers, err := auth.LoadAllowedSignersFile(path)
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if signers.Count() != 1 {
		t.Fatalf("expected 1 signer, got %d", signers.Count())
	}
}

func TestAllowedSignersConcurrentAccess(t *testing.T) {
	signers := auth.NewAllowedSigners()

	// Parse some initial data
	input := `user1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDIhz2GK/XCUj4i6Q5yQJNL1MXMY0RxzPV2QrBqfHr1C
user2 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDIhz2GK/XCUj4i6Q5yQJNL1MXMY0RxzPV2QrBqfHr1D
user3 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDIhz2GK/XCUj4i6Q5yQJNL1MXMY0RxzPV2QrBqfHr1E
`
	signers, _ = auth.ParseAllowedSigners(strings.NewReader(input))

	// Concurrent lookups
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = signers.Count()
		}()
	}
	wg.Wait()

	// Verify we didn't race (this is a best-effort check)
	t.Log("concurrent access completed without panic")
}

func TestParseAllowedSignersEmpty(t *testing.T) {
	signers, err := auth.ParseAllowedSigners(strings.NewReader(""))
	if err != nil {
		t.Fatal(err)
	}
	if signers.Count() != 0 {
		t.Fatal("expected empty signers")
	}
}

func TestParseAllowedSignersCommentsAndBlanks(t *testing.T) {
	input := `# Comment line

paul@laptop ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDIhz2GK/XCUj4i6Q5yQJNL1MXMY0RxzPV2QrBqfHr1C

# Another comment
`

	signers, err := auth.ParseAllowedSigners(strings.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	if count := signers.Count(); count != 1 {
		t.Fatalf("expected 1 signer, got %d", count)
	}
}

func TestRemoveAllowedSignersByPrincipal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "allowed_signers")

	content := `# comment line
paul@laptop ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDIhz2GK/XCUj4i6Q5yQJNL1MXMY0RxzPV2QrBqfHr1C
alice@desktop ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDIhz2GK/XCUj4i6Q5yQJNL1MXMY0RxzPV2QrBqfHr1D

`
	os.WriteFile(path, []byte(content), 0o600)

	// Remove paul — should leave alice + comment.
	n, err := auth.RemoveAllowedSignersByPrincipal(path, "paul@laptop")
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 removed, got %d", n)
	}

	// Verify file contents.
	data, _ := os.ReadFile(path)
	remaining := string(data)
	if strings.Contains(remaining, "paul@laptop") {
		t.Fatal("paul@laptop should have been removed")
	}
	if !strings.Contains(remaining, "alice@desktop") {
		t.Fatal("alice@desktop should still be present")
	}
	if !strings.Contains(remaining, "# comment") {
		t.Fatal("comment line should be preserved")
	}

	// Removing a non-existent principal should error.
	_, err = auth.RemoveAllowedSignersByPrincipal(path, "nobody@nowhere")
	if err == nil {
		t.Fatal("expected error for unknown principal")
	}
}
