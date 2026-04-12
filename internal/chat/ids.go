package chat

import (
	"crypto/rand"
	"encoding/hex"
)

// newID returns a 16-byte random hex string. Used for session and message
// IDs. Collision probability is irrelevant at the scales we care about.
func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
