package llm

import (
	"context"
	"strings"
)

// Fake is an in-memory LLM adapter used in tests. It emits each whitespace-
// separated word of Reply as its own token chunk, then a terminal Done.
// Deterministic, network-free, fast.
type Fake struct {
	Reply         string
	InTokens      int
	OutTokens     int
	StartError    error  // if set, Stream returns this immediately
	StreamError   string // if set, emitted on the Done chunk's Error field
	LastRequest   Request
}

// NewFake returns a Fake that streams the given reply word-by-word.
func NewFake(reply string) *Fake {
	return &Fake{Reply: reply}
}

// Stream implements the LLM interface.
func (f *Fake) Stream(ctx context.Context, req Request) (<-chan Chunk, error) {
	f.LastRequest = req
	if f.StartError != nil {
		return nil, f.StartError
	}
	out := make(chan Chunk, 16)
	go func() {
		defer close(out)
		if f.Reply != "" {
			for _, word := range strings.Fields(f.Reply) {
				select {
				case out <- Chunk{Kind: ChunkToken, Token: word + " "}:
				case <-ctx.Done():
					return
				}
			}
		}
		select {
		case out <- Chunk{
			Kind:          ChunkDone,
			TokenCountIn:  f.InTokens,
			TokenCountOut: f.OutTokens,
			Error:         f.StreamError,
		}:
		case <-ctx.Done():
		}
	}()
	return out, nil
}
