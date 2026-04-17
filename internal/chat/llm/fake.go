package llm

import (
	"context"
	"strings"
)

// Fake is an in-memory LLM adapter used in tests. It emits each whitespace-
// separated word of Reply as its own token chunk, then a terminal Done.
// Deterministic, network-free, fast.
type Fake struct {
	Reply       string
	InTokens    int
	OutTokens   int
	StartError  error  // if set, Stream returns this immediately
	StreamError string // if set, emitted on the Done chunk's Error field
	LastRequest Request
	// Requests accumulates every Request passed to Stream so tool-use
	// tests can assert on the whole sequence, not just the most recent
	// one (LastRequest remains for single-call assertions).
	Requests []Request
	// SupportsImages toggles the Capabilities response for tests
	// exercising the vision-degradation path.
	SupportsImages bool
	// Scripted is a FIFO of reply scripts; each Stream call pops the
	// front script. When the script emits tool_use chunks the caller is
	// expected to execute them, append ToolCall + tool-result messages,
	// and call Stream again — letting tests rehearse multi-round
	// agentic loops deterministically. When Scripted is empty Stream
	// falls back to the word-by-word Reply behaviour.
	Scripted []FakeScript
}

// FakeScript describes one Stream invocation in the agentic loop:
// which tool_use chunks to emit, what text to say alongside them, and
// what stop_reason to claim on the Done chunk. A typical two-round
// tool-use test scripts a first turn with ToolUses non-empty and
// StopReason="tool_use", then a second turn with Text set and
// StopReason="end_turn".
type FakeScript struct {
	Text       string
	ToolUses   []ToolCall
	StopReason string
}

// NewFake returns a Fake that streams the given reply word-by-word.
func NewFake(reply string) *Fake {
	return &Fake{Reply: reply}
}

// Stream implements the LLM interface.
func (f *Fake) Stream(ctx context.Context, req Request) (<-chan Chunk, error) {
	f.LastRequest = req
	f.Requests = append(f.Requests, req)
	if f.StartError != nil {
		return nil, f.StartError
	}
	// Pop the next scripted turn, if any. Fall back to the default
	// word-by-word Reply when no script is queued so legacy tests keep
	// working unchanged.
	var script *FakeScript
	if len(f.Scripted) > 0 {
		head := f.Scripted[0]
		f.Scripted = f.Scripted[1:]
		script = &head
	}
	out := make(chan Chunk, 16)
	go func() {
		defer close(out)
		text := f.Reply
		var toolUses []ToolCall
		stop := ""
		if script != nil {
			text = script.Text
			toolUses = script.ToolUses
			stop = script.StopReason
		}
		if text != "" {
			for _, word := range strings.Fields(text) {
				select {
				case out <- Chunk{Kind: ChunkToken, Token: word + " "}:
				case <-ctx.Done():
					return
				}
			}
		}
		for _, tu := range toolUses {
			select {
			case out <- Chunk{
				Kind:      ChunkToolUse,
				ToolUseID: tu.ID,
				ToolName:  tu.Name,
				ToolArgs:  tu.Args,
			}:
			case <-ctx.Done():
				return
			}
		}
		select {
		case out <- Chunk{
			Kind:          ChunkDone,
			TokenCountIn:  f.InTokens,
			TokenCountOut: f.OutTokens,
			StopReason:    stop,
			Error:         f.StreamError,
		}:
		case <-ctx.Done():
		}
	}()
	return out, nil
}

// Capabilities returns the flag the test case configured. Defaults to
// no image support so callers that don't set SupportsImages exercise
// the degradation path by default.
func (f *Fake) Capabilities(_ context.Context, _ string) Capabilities {
	return Capabilities{Images: f.SupportsImages}
}
