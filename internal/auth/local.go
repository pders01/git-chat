package auth

import (
	"errors"
	"sync"
	"time"
)

// LocalTokens holds the one-time claim token minted by `git-chat local` at
// startup. It is nil in serve mode. Exactly one token is active at a time —
// each call to Mint replaces the previous one.
type LocalTokens struct {
	mu        sync.Mutex
	token     string
	expiresAt time.Time
	ttl       time.Duration
}

// NewLocalTokens returns an empty store with 60-second TTL.
func NewLocalTokens() *LocalTokens {
	return &LocalTokens{ttl: 60 * time.Second}
}

// Mint generates a fresh claim token, replaces any existing one, and returns
// the new token plus its absolute expiry.
func (l *LocalTokens) Mint() (string, time.Time, error) {
	tok, err := randomHex(32)
	if err != nil {
		return "", time.Time{}, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.token = tok
	l.expiresAt = time.Now().Add(l.ttl)
	return tok, l.expiresAt, nil
}

// Claim consumes the token if it matches and is not expired.
func (l *LocalTokens) Claim(token string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.token == "" {
		return errors.New("no active local token")
	}
	if time.Now().After(l.expiresAt) {
		l.token = ""
		return errors.New("local token expired")
	}
	if l.token != token {
		return errors.New("invalid local token")
	}
	l.token = ""
	return nil
}
