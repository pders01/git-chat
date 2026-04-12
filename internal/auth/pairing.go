package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// PairingStore holds the in-memory state of all active pairing sessions.
//
// Lifecycle of a single pairing:
//
//	Start() → {sid, code}
//	browser opens WatchPairing(sid) → receives channel
//	user runs `ssh pair <code>` → ssh middleware calls Complete(code, principal)
//	channel emits Paired{claim_token, principal} and closes
//	browser calls Claim(sid, claim_token) → consumed, session cookie issued
//
// Pairings that are not completed within pairingTTL emit Expired on the
// channel and are deleted. Pairings that are completed but not claimed
// within claimTTL are also deleted (defensive; normally the browser claims
// within milliseconds of the event).
type PairingStore struct {
	mu     sync.Mutex
	bySid  map[string]*pairing
	byCode map[string]*pairing

	pairingTTL time.Duration
	claimTTL   time.Duration
}

type pairing struct {
	sid        string
	code       string
	createdAt  time.Time
	expiresAt  time.Time
	result     chan *gitchatv1.WatchPairingResponse // buffered(1)
	closed     bool
	claimToken string // populated on Complete, consumed on Claim
	principal  string
}

// NewPairingStore returns a store with 60s pairing TTL and 30s claim TTL.
func NewPairingStore() *PairingStore {
	return &PairingStore{
		bySid:      make(map[string]*pairing),
		byCode:     make(map[string]*pairing),
		pairingTTL: 60 * time.Second,
		claimTTL:   30 * time.Second,
	}
}

var pairingWords = []string{
	"WOLF", "OTTER", "HAWK", "LYNX", "BISON", "RAVEN", "MOTH", "BEAR",
	"STAG", "SEAL", "VOLE", "KITE", "CRAB", "ORCA", "NEWT", "SWAN",
}

// Start creates a new pairing and schedules its TTL expiry. The caller
// displays the returned code and subscribes to the sid via Watch.
func (p *PairingStore) Start() (sid, code string, expiresAt time.Time, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	sid, err = randomHex(16)
	if err != nil {
		return "", "", time.Time{}, err
	}
	// Code: WORD-NNNN where NNNN avoids collisions with existing active codes.
	for attempts := 0; attempts < 100; attempts++ {
		w := pairingWords[randIndex(len(pairingWords))]
		n := randIndex(10000)
		candidate := fmt.Sprintf("%s-%04d", w, n)
		if _, exists := p.byCode[candidate]; !exists {
			code = candidate
			break
		}
	}
	if code == "" {
		return "", "", time.Time{}, errors.New("failed to generate unique code after 100 attempts")
	}

	now := time.Now()
	pr := &pairing{
		sid:       sid,
		code:      code,
		createdAt: now,
		expiresAt: now.Add(p.pairingTTL),
		result:    make(chan *gitchatv1.WatchPairingResponse, 1),
	}
	p.bySid[sid] = pr
	p.byCode[code] = pr

	time.AfterFunc(p.pairingTTL, func() {
		p.expire(sid, "ttl")
	})

	return sid, code, pr.expiresAt, nil
}

// Watch returns the result channel for sid. The channel emits exactly one
// message (Paired or Expired) then closes.
func (p *PairingStore) Watch(sid string) (<-chan *gitchatv1.WatchPairingResponse, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pr, ok := p.bySid[sid]
	if !ok {
		return nil, errors.New("pairing not found")
	}
	return pr.result, nil
}

// Complete resolves a pairing code to its sid, mints a claim token, and
// emits the Paired event on the watch channel. Called by the ssh pair exec
// handler after the client's pubkey has been resolved to a principal.
func (p *PairingStore) Complete(code, principal string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	pr, ok := p.byCode[code]
	if !ok {
		return errors.New("unknown or expired code")
	}
	if pr.closed {
		return errors.New("pairing already completed")
	}
	tok, err := randomHex(24)
	if err != nil {
		return err
	}
	pr.claimToken = tok
	pr.principal = principal
	pr.closed = true

	pr.result <- &gitchatv1.WatchPairingResponse{
		Kind: &gitchatv1.WatchPairingResponse_Paired{
			Paired: &gitchatv1.Paired{
				ClaimToken: tok,
				Principal:  principal,
			},
		},
	}
	close(pr.result)

	// Schedule claim-window expiry as a safety net.
	sid := pr.sid
	time.AfterFunc(p.claimTTL, func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		if cur, ok := p.bySid[sid]; ok && cur == pr {
			delete(p.bySid, sid)
			delete(p.byCode, pr.code)
		}
	})
	return nil
}

// Claim validates a claim token and consumes it, returning the paired
// principal. The AuthService handler then uses that principal to mint the
// session cookie.
func (p *PairingStore) Claim(sid, claimToken string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pr, ok := p.bySid[sid]
	if !ok {
		return "", errors.New("pairing not found")
	}
	if !pr.closed {
		return "", errors.New("pairing not yet completed")
	}
	if pr.claimToken == "" || pr.claimToken != claimToken {
		return "", errors.New("invalid claim token")
	}
	principal := pr.principal
	// Single-use: delete on successful claim.
	delete(p.bySid, sid)
	delete(p.byCode, pr.code)
	return principal, nil
}

func (p *PairingStore) expire(sid, reason string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pr, ok := p.bySid[sid]
	if !ok || pr.closed {
		return
	}
	pr.closed = true
	select {
	case pr.result <- &gitchatv1.WatchPairingResponse{
		Kind: &gitchatv1.WatchPairingResponse_Expired{
			Expired: &gitchatv1.Expired{Reason: reason},
		},
	}:
	default:
	}
	close(pr.result)
	delete(p.bySid, sid)
	delete(p.byCode, pr.code)
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func randIndex(n int) int {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	x := int(b[0])<<24 | int(b[1])<<16 | int(b[2])<<8 | int(b[3])
	if x < 0 {
		x = -x
	}
	return x % n
}
