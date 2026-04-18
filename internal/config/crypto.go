package config

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// encPrefix is prepended to encrypted values in the database so we can
// distinguish them from plaintext values written before encryption was
// enabled (or by older versions).
const encPrefix = "enc:"

// keyFileName is stored alongside the SQLite database.
const keyFileName = "secret.key"

// loadOrCreateKey reads the 32-byte AES key from disk, creating it on
// first use. The key file lives next to the SQLite database (same
// directory as state.db), so backup/restore of the state directory
// preserves the ability to decrypt.
func loadOrCreateKey(dbPath string) ([]byte, error) {
	dir := filepath.Dir(dbPath)
	keyPath := filepath.Join(dir, keyFileName)

	data, err := os.ReadFile(keyPath)
	if err == nil && len(data) == 32 {
		return data, nil
	}

	// Generate a new key.
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, fmt.Errorf("generate encryption key: %w", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create key directory: %w", err)
	}
	if err := os.WriteFile(keyPath, key, 0o600); err != nil {
		return nil, fmt.Errorf("write encryption key: %w", err)
	}
	return key, nil
}

// encrypt returns an "enc:"-prefixed base64 string containing the
// AES-256-GCM ciphertext with a random nonce prepended.
func encrypt(key []byte, plaintext string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return encPrefix + base64.StdEncoding.EncodeToString(ciphertext), nil
}

// decrypt reverses encrypt. Returns an error if the ciphertext is
// malformed or the key is wrong.
func decrypt(key []byte, encoded string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", fmt.Errorf("base64 decode: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonceSize := gcm.NonceSize()
	if len(raw) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}
	plaintext, err := gcm.Open(nil, raw[:nonceSize], raw[nonceSize:], nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}
	return string(plaintext), nil
}

// isEncrypted reports whether a stored value was encrypted.
func isEncrypted(v string) bool {
	return len(v) > len(encPrefix) && v[:len(encPrefix)] == encPrefix
}

// maskSecret returns a masked representation of a secret value for
// display. Returns a fixed placeholder to avoid leaking any part of
// the secret to non-local principals via the GetConfig API.
func maskSecret(v string) string {
	if v == "" {
		return ""
	}
	return "••••••••"
}
