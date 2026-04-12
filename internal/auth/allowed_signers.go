package auth

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/charmbracelet/ssh"
	gossh "golang.org/x/crypto/ssh"
)

// AllowedSigners is the in-memory representation of ~/.config/git-chat/allowed_signers.
//
// File format is a subset of OpenSSH AllowedSigners(5): one entry per line,
// of the form
//
//	<principal> <key-type> <base64-key> [comment]
//
// Blank lines and lines beginning with '#' are ignored. Multi-principal
// entries are not supported in M1; each principal gets its own line.
type AllowedSigners struct {
	mu sync.RWMutex
	// byKey maps the marshalled public-key bytes to the principal id.
	// Marshalled bytes are the wire-format SSH pubkey, which uniquely
	// identifies a key regardless of algorithm.
	byKey map[string]string
}

// NewAllowedSigners returns an empty, ready-to-use store.
func NewAllowedSigners() *AllowedSigners {
	return &AllowedSigners{byKey: make(map[string]string)}
}

// LoadAllowedSignersFile opens path and parses its contents. A missing file
// is treated as an empty allow list — the caller decides whether that's an
// error (it is for `serve`, it's fine for `local` which doesn't consult it).
func LoadAllowedSignersFile(path string) (*AllowedSigners, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return NewAllowedSigners(), nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return ParseAllowedSigners(f)
}

// ParseAllowedSigners reads entries from r.
func ParseAllowedSigners(r io.Reader) (*AllowedSigners, error) {
	s := NewAllowedSigners()
	scanner := bufio.NewScanner(r)
	for lineNum := 1; scanner.Scan(); lineNum++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			return nil, fmt.Errorf("allowed_signers line %d: expected <principal> <type> <key>", lineNum)
		}
		principal := fields[0]
		keyLine := strings.Join(fields[1:], " ")
		pk, _, _, _, err := gossh.ParseAuthorizedKey([]byte(keyLine))
		if err != nil {
			return nil, fmt.Errorf("allowed_signers line %d: %w", lineNum, err)
		}
		s.byKey[string(pk.Marshal())] = principal
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return s, nil
}

// Lookup returns the principal associated with key, if any.
func (s *AllowedSigners) Lookup(key ssh.PublicKey) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.byKey[string(key.Marshal())]
	return p, ok
}

// Count returns the number of registered principals.
func (s *AllowedSigners) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.byKey)
}

// Append writes a new entry to the end of path. The line is formatted
// identically to what ParseAllowedSigners expects, so a subsequent reload
// will pick it up unchanged.
func AppendAllowedSignersFile(path, principal string, pubkey ssh.PublicKey) error {
	if err := os.MkdirAll(parentDir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	authorized := gossh.MarshalAuthorizedKey(pubkey)
	// MarshalAuthorizedKey returns "<type> <base64>\n" without a comment.
	line := fmt.Sprintf("%s %s", principal, strings.TrimSpace(string(authorized)))
	_, err = fmt.Fprintln(f, line)
	return err
}

func parentDir(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' {
			return path[:i]
		}
	}
	return "."
}
