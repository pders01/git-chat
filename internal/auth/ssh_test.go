package auth_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	gossh "golang.org/x/crypto/ssh"

	"github.com/pders01/git-chat/internal/auth"
)

// testSSHEnv sets up a temporary config dir, generates a test key pair,
// writes an allowed_signers file, and returns the SSH server address +
// a client config that authenticates with the test key.
type testSSHEnv struct {
	Addr       string
	ClientConf *gossh.ClientConfig
	Pairings   *auth.PairingStore
	cleanup    func()
}

func newTestSSHEnv(t *testing.T) *testSSHEnv {
	t.Helper()

	// Temporary config dir for host key + allowed_signers.
	tmpDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmpDir)

	// Generate a test ed25519 key pair.
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	sshPub, err := gossh.NewPublicKey(pub)
	if err != nil {
		t.Fatalf("public key: %v", err)
	}

	// Write allowed_signers file.
	gcDir := filepath.Join(tmpDir, "git-chat")
	if err := os.MkdirAll(gcDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	authorizedKey := strings.TrimSpace(string(gossh.MarshalAuthorizedKey(sshPub)))
	signerLine := fmt.Sprintf("test@laptop %s\n", authorizedKey)
	sigPath := filepath.Join(gcDir, "allowed_signers")
	if err := os.WriteFile(sigPath, []byte(signerLine), 0o600); err != nil {
		t.Fatalf("write allowed_signers: %v", err)
	}

	signers, err := auth.LoadAllowedSignersFile(sigPath)
	if err != nil {
		t.Fatalf("load signers: %v", err)
	}

	pairings := auth.NewPairingStore()

	// Pick a random port.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	ln.Close() // wish will re-bind

	srv, err := auth.NewSSHServer(auth.SSHConfig{
		Addr:     addr,
		Signers:  signers,
		Pairings: pairings,
	})
	if err != nil {
		t.Fatalf("new ssh server: %v", err)
	}

	go func() { _ = srv.ListenAndServe() }()

	// Wait for server to be ready.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err == nil {
			conn.Close()
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	clientConf := &gossh.ClientConfig{
		User:            "git",
		Auth:            []gossh.AuthMethod{gossh.PublicKeys(signer)},
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         2 * time.Second,
	}

	return &testSSHEnv{
		Addr:       addr,
		ClientConf: clientConf,
		Pairings:   pairings,
		cleanup:    func() { srv.Close() },
	}
}

func (e *testSSHEnv) Close() {
	e.cleanup()
}

// runSSHCommand connects to the test SSH server and runs a command,
// returning stdout, stderr, and the exit status.
func runSSHCommand(t *testing.T, env *testSSHEnv, command string) (stdout, stderr string, exitCode int) {
	t.Helper()
	client, err := gossh.Dial("tcp", env.Addr, env.ClientConf)
	if err != nil {
		t.Fatalf("ssh dial: %v", err)
	}
	defer client.Close()

	sess, err := client.NewSession()
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	defer sess.Close()

	var stdoutBuf, stderrBuf strings.Builder
	sess.Stdout = &stdoutBuf
	sess.Stderr = &stderrBuf

	err = sess.Run(command)
	exitCode = 0
	if err != nil {
		if exitErr, ok := err.(*gossh.ExitError); ok {
			exitCode = exitErr.ExitStatus()
		} else {
			t.Fatalf("ssh run: %v", err)
		}
	}
	return stdoutBuf.String(), stderrBuf.String(), exitCode
}

// ── Constructor tests ────────────────────────────────────────────

func TestNewSSHServerRequiresSignersAndPairings(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	_, err := auth.NewSSHServer(auth.SSHConfig{
		Addr:     "127.0.0.1:0",
		Signers:  nil,
		Pairings: auth.NewPairingStore(),
	})
	if err == nil {
		t.Fatal("expected error for nil Signers")
	}

	signers, _ := auth.ParseAllowedSigners(strings.NewReader(""))
	_, err = auth.NewSSHServer(auth.SSHConfig{
		Addr:     "127.0.0.1:0",
		Signers:  signers,
		Pairings: nil,
	})
	if err == nil {
		t.Fatal("expected error for nil Pairings")
	}
}

// ── Middleware tests (via real SSH connections) ───────────────────

func TestSSHNoCommandShowsUsage(t *testing.T) {
	env := newTestSSHEnv(t)
	defer env.Close()

	// Connect and request a shell (no command).
	client, err := gossh.Dial("tcp", env.Addr, env.ClientConf)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	sess, err := client.NewSession()
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	defer sess.Close()

	var stderrBuf strings.Builder
	sess.Stderr = &stderrBuf

	// Start shell (no exec) — should be rejected.
	err = sess.Shell()
	if err != nil {
		// Some SSH servers reject Shell() at the protocol level.
		// Either way, the session should not succeed.
		return
	}
	_ = sess.Wait()

	if !strings.Contains(stderrBuf.String(), "usage") {
		t.Errorf("expected usage message on stderr, got: %q", stderrBuf.String())
	}
}

func TestSSHWrongCommandShowsUsage(t *testing.T) {
	env := newTestSSHEnv(t)
	defer env.Close()

	_, stderr, exitCode := runSSHCommand(t, env, "ls -la")
	if exitCode != 2 {
		t.Errorf("expected exit 2, got %d", exitCode)
	}
	if !strings.Contains(stderr, "usage") {
		t.Errorf("expected usage on stderr, got: %q", stderr)
	}
}

func TestSSHPairWrongArgCount(t *testing.T) {
	env := newTestSSHEnv(t)
	defer env.Close()

	_, stderr, exitCode := runSSHCommand(t, env, "pair")
	if exitCode != 2 {
		t.Errorf("expected exit 2, got %d", exitCode)
	}
	if !strings.Contains(stderr, "usage") {
		t.Errorf("expected usage on stderr, got: %q", stderr)
	}
}

func TestSSHPairTooManyArgs(t *testing.T) {
	env := newTestSSHEnv(t)
	defer env.Close()

	_, stderr, exitCode := runSSHCommand(t, env, "pair CODE1 CODE2")
	if exitCode != 2 {
		t.Errorf("expected exit 2, got %d", exitCode)
	}
	if !strings.Contains(stderr, "usage") {
		t.Errorf("expected usage on stderr, got: %q", stderr)
	}
}

func TestSSHPairInvalidCode(t *testing.T) {
	env := newTestSSHEnv(t)
	defer env.Close()

	_, stderr, exitCode := runSSHCommand(t, env, "pair BOGUS-0000")
	if exitCode != 1 {
		t.Errorf("expected exit 1, got %d", exitCode)
	}
	if !strings.Contains(stderr, "pair failed") {
		t.Errorf("expected pair-failed message, got: %q", stderr)
	}
}

func TestSSHPairSuccess(t *testing.T) {
	env := newTestSSHEnv(t)
	defer env.Close()

	// Start a pairing flow to get a valid code.
	_, code, _, err := env.Pairings.Start()
	if err != nil {
		t.Fatalf("begin pairing: %v", err)
	}

	stdout, _, exitCode := runSSHCommand(t, env, fmt.Sprintf("pair %s", code))
	if exitCode != 0 {
		t.Errorf("expected exit 0, got %d", exitCode)
	}
	if !strings.Contains(stdout, "paired as test@laptop") {
		t.Errorf("expected success message, got: %q", stdout)
	}
}

func TestSSHPairCodeCannotBeReused(t *testing.T) {
	env := newTestSSHEnv(t)
	defer env.Close()

	_, code, _, err := env.Pairings.Start()
	if err != nil {
		t.Fatalf("begin pairing: %v", err)
	}

	// First use should succeed.
	_, _, exitCode := runSSHCommand(t, env, fmt.Sprintf("pair %s", code))
	if exitCode != 0 {
		t.Fatalf("first pair should succeed, got exit %d", exitCode)
	}

	// Second use should fail — codes are single-use.
	_, stderr, exitCode := runSSHCommand(t, env, fmt.Sprintf("pair %s", code))
	if exitCode != 1 {
		t.Errorf("expected exit 1 on reuse, got %d", exitCode)
	}
	if !strings.Contains(stderr, "pair failed") {
		t.Errorf("expected pair-failed on reuse, got: %q", stderr)
	}
}

// ── configDir tests ──────────────────────────────────────────────

func TestConfigDirRespectsXDG(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmp)

	path, err := auth.AllowedSignersPath()
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	expected := filepath.Join(tmp, "git-chat", "allowed_signers")
	if path != expected {
		t.Errorf("path = %q, want %q", path, expected)
	}
}

func TestConfigDirFallsBackToHome(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "")

	path, err := auth.AllowedSignersPath()
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	home, _ := os.UserHomeDir()
	expected := filepath.Join(home, ".config", "git-chat", "allowed_signers")
	if path != expected {
		t.Errorf("path = %q, want %q", path, expected)
	}
}

// ── Unauthorized key test ────────────────────────────────────────

func TestSSHUnknownKeyRejected(t *testing.T) {
	env := newTestSSHEnv(t)
	defer env.Close()

	// Generate a different key not in allowed_signers.
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := gossh.NewSignerFromKey(priv)

	badConf := &gossh.ClientConfig{
		User:            "git",
		Auth:            []gossh.AuthMethod{gossh.PublicKeys(signer)},
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         2 * time.Second,
	}

	_, err := gossh.Dial("tcp", env.Addr, badConf)
	if err == nil {
		t.Fatal("expected connection to be rejected for unknown key")
	}
}
