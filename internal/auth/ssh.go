// Package auth owns both the embedded SSH server (pairing side) and the
// HTTP session layer (cookie side). Both live in the same package because
// they share the PairingStore and AllowedSigners references.
//
// In M1 the SSH server verifies public keys against allowed_signers and
// accepts exactly one command: `pair <CODE>`. Anything else (shell,
// PTY, port forwarding, scp, sftp) is refused with a one-line error.
package auth

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/charmbracelet/ssh"
	"github.com/charmbracelet/wish"
	"github.com/charmbracelet/wish/logging"
)

// sshPrincipalKey is the ssh.Context key under which we stash the principal
// resolved from the client's public key during the auth callback.
const sshPrincipalKey = "git-chat.principal"

// SSHConfig bundles the dependencies the SSH server needs. Pairings and
// Signers are required; the caller must have loaded allowed_signers before
// constructing the server so startup fails loudly if the file is missing
// or malformed.
type SSHConfig struct {
	Addr     string
	Signers  *AllowedSigners
	Pairings *PairingStore
}

// NewSSHServer constructs a wish-powered SSH server bound to addr. The host
// key is read from (or created at) ~/.config/git-chat/host_ed25519.
func NewSSHServer(cfg SSHConfig) (*ssh.Server, error) {
	if cfg.Signers == nil || cfg.Pairings == nil {
		return nil, fmt.Errorf("ssh server requires Signers and Pairings (did you mean local mode?)")
	}
	keyPath, err := hostKeyPath()
	if err != nil {
		return nil, fmt.Errorf("resolve host key path: %w", err)
	}

	srv, err := wish.NewServer(
		wish.WithAddress(cfg.Addr),
		wish.WithHostKeyPath(keyPath),
		wish.WithPublicKeyAuth(func(ctx ssh.Context, key ssh.PublicKey) bool {
			principal, ok := cfg.Signers.Lookup(key)
			if !ok {
				return false
			}
			ctx.SetValue(sshPrincipalKey, principal)
			return true
		}),
		wish.WithMiddleware(
			pairExecMiddleware(cfg.Pairings),
			logging.Middleware(),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("build wish server: %w", err)
	}
	return srv, nil
}

// pairExecMiddleware is the only handler installed on the SSH server. It
// inspects the requested command and either completes a pairing or prints
// usage and exits. Shell and PTY requests produce the same usage line.
func pairExecMiddleware(pairings *PairingStore) wish.Middleware {
	return func(next ssh.Handler) ssh.Handler {
		return func(sess ssh.Session) {
			cmd := sess.Command()
			if len(cmd) == 0 {
				_, _ = fmt.Fprintln(sess.Stderr(), "usage: ssh -p 2222 <host> pair <CODE>")
				_ = sess.Exit(2)
				return
			}
			if cmd[0] != "pair" || len(cmd) != 2 {
				_, _ = fmt.Fprintln(sess.Stderr(), "usage: ssh -p 2222 <host> pair <CODE>")
				_ = sess.Exit(2)
				return
			}
			code := cmd[1]
			principal, _ := sess.Context().Value(sshPrincipalKey).(string)
			if principal == "" {
				_, _ = fmt.Fprintln(sess.Stderr(), "auth failed: key not registered in allowed_signers")
				_ = sess.Exit(1)
				return
			}
			if err := pairings.Complete(code, principal); err != nil {
				_, _ = fmt.Fprintf(sess.Stderr(), "pair failed: %v\n", err)
				_ = sess.Exit(1)
				return
			}
			_, _ = fmt.Fprintf(sess, "paired as %s\n", principal)
			_ = sess.Exit(0)
			// Intentionally do not call next(sess) — we want no shell.
		}
	}
}

// AllowedSignersPath returns the conventional location of the allowed_signers
// file. Respects $XDG_CONFIG_HOME, falls back to ~/.config/git-chat/.
// We do NOT use os.UserConfigDir because on macOS it returns
// ~/Library/Application Support/ which is wrong for developer CLIs
// (gh, cargo, nvim, etc. all use ~/.config/<name> on macOS).
func AllowedSignersPath() (string, error) {
	d, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "allowed_signers"), nil
}

func hostKeyPath() (string, error) {
	d, err := configDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(d, 0o700); err != nil {
		return "", err
	}
	return filepath.Join(d, "host_ed25519"), nil
}

// configDir returns ~/.config/git-chat/ (or $XDG_CONFIG_HOME/git-chat/).
// The directory is NOT created by this function; callers that write to it
// must MkdirAll first.
func configDir() (string, error) {
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "git-chat"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "git-chat"), nil
}
