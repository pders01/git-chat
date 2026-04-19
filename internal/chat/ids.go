package chat

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
)

// newID returns a 16-byte random hex string. Used for session and message
// IDs. Collision probability is irrelevant at the scales we care about.
//
// crypto/rand.Read failing would mean the kernel CSPRNG is unavailable —
// essentially impossible on a healthy Linux/macOS host. If it does fail,
// we log loudly and fall back to the zero ID; callers will see collisions
// rather than silent correctness issues. Callers that care about
// colliding IDs (e.g. session lookups) should rehash on conflict.
func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		slog.Error("crypto/rand unavailable — id generation degraded", "err", err)
	}
	return hex.EncodeToString(b)
}
