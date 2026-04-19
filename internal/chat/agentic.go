package chat

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/chat/llm"
	"github.com/pders01/git-chat/internal/storage"
)

// agenticLoop streams LLM responses and executes tool calls in a loop.
// Returns the accumulated assistant text, token counts, tool events, and
// any LLM error string.
//
// Responsibilities:
//   - Stream LLM chunks (Token, Reasoning, ToolUse, Done) to the client.
//   - Accumulate assistant text across rounds.
//   - When the LLM emits tool calls, execute them (via s.Tools) and feed
//     results back as role=tool messages for the next round.
//   - Enforce hard caps: GITCHAT_TOOL_LOOP_MAX rounds, GITCHAT_TOOL_LOOP_MAX_TOKENS
//     cumulative in+out tokens. Either hitting the cap populates llmErr.
//   - Bail out cleanly on client disconnect so we don't keep spending
//     tokens against a dead stream.
//
// Exits on:
//   - LLM stream error (llmErr set)
//   - Empty tool-call set (natural end of conversation)
//   - s.Tools == nil (tools disabled)
//   - Token cap or round cap reached
//   - Client disconnect (ctx.Err() or send error)
func (s *Service) agenticLoop(
	ctx context.Context, sc *streamCtx,
	msgs []llm.Message, toolSpecs []llm.ToolSpec,
	send func(*gitchatv1.MessageChunk) error,
) (assistantText string, totalIn, totalOut int, events []storage.ToolEventRow, llmErr string) {
	var assistant strings.Builder
	toolOrdinal := 0
	roundMsgs := append([]llm.Message(nil), msgs...)
	toolLoopMax := s.cfgInt(ctx, "GITCHAT_TOOL_LOOP_MAX", defaultToolLoopMax)
	toolLoopMaxTokens := s.cfgInt(ctx, "GITCHAT_TOOL_LOOP_MAX_TOKENS", defaultToolLoopMaxTokens)

	for round := 0; round < toolLoopMax; round++ {
		if ctx.Err() != nil {
			llmErr = "client disconnected"
			break
		}
		slog.Debug("agentic round starting", "round", round, "msgs", len(roundMsgs))
		llmChunks, err := sc.adapter.Stream(ctx, llm.Request{
			Model:       sc.model,
			Messages:    roundMsgs,
			Temperature: sc.temp,
			MaxTokens:   sc.maxTok,
			Tools:       toolSpecs,
		})
		if err != nil {
			llmErr = err.Error()
			break
		}
		var roundText strings.Builder
		var roundCalls []llm.ToolCall
		for c := range llmChunks {
			switch c.Kind {
			case llm.ChunkToken:
				assistant.WriteString(c.Token)
				roundText.WriteString(c.Token)
				if err := send(&gitchatv1.MessageChunk{
					Kind: &gitchatv1.MessageChunk_Token{Token: c.Token},
				}); err != nil {
					return assistant.String(), totalIn, totalOut, events, "send error"
				}
			case llm.ChunkReasoning:
				if err := send(&gitchatv1.MessageChunk{
					Kind: &gitchatv1.MessageChunk_Thinking{Thinking: c.Reasoning},
				}); err != nil {
					return assistant.String(), totalIn, totalOut, events, "send error"
				}
			case llm.ChunkToolUse:
				tc := llm.ToolCall{ID: c.ToolUseID, Name: c.ToolName, Args: c.ToolArgs}
				roundCalls = append(roundCalls, tc)
				// Match Token/Reasoning chunks: if the client is gone,
				// don't keep executing tools (and spending tokens).
				if err := send(&gitchatv1.MessageChunk{
					Kind: &gitchatv1.MessageChunk_ToolCall{
						ToolCall: &gitchatv1.ToolCall{
							Id:       c.ToolUseID,
							Name:     c.ToolName,
							ArgsJson: string(c.ToolArgs),
						},
					},
				}); err != nil {
					return assistant.String(), totalIn, totalOut, events, "send error"
				}
			case llm.ChunkDone:
				totalIn += c.TokenCountIn
				totalOut += c.TokenCountOut
				llmErr = c.Error
			}
		}
		slog.Debug("agentic round finished", "round", round,
			"text_bytes", roundText.Len(), "calls", len(roundCalls),
			"tokens_in", totalIn, "tokens_out", totalOut,
			"llm_err", llmErr)
		if llmErr != "" || len(roundCalls) == 0 || s.Tools == nil {
			break
		}
		if totalIn+totalOut > toolLoopMaxTokens {
			llmErr = fmt.Sprintf("token budget exceeded (%d tokens used, limit %d)", totalIn+totalOut, toolLoopMaxTokens)
			break
		}
		if round == toolLoopMax-1 {
			llmErr = fmt.Sprintf("tool loop cap reached (%d rounds)", toolLoopMax)
			break
		}
		roundMsgs = append(roundMsgs, llm.Message{
			Role:      llm.RoleAssistant,
			Content:   roundText.String(),
			ToolCalls: roundCalls,
		})
		for _, tc := range roundCalls {
			if ctx.Err() != nil {
				llmErr = "client disconnected"
				break
			}
			toolCtx, toolCancel := context.WithTimeout(ctx, 30*time.Second)
			output, execErr := s.Tools.Execute(toolCtx, sc.repo, tc.Name, tc.Args)
			toolCancel()
			isErr := false
			if execErr != nil {
				output = execErr.Error()
				isErr = true
			}
			if err := send(&gitchatv1.MessageChunk{
				Kind: &gitchatv1.MessageChunk_ToolResult{
					ToolResult: &gitchatv1.ToolResult{
						Id:      tc.ID,
						Content: output,
						IsError: isErr,
					},
				},
			}); err != nil {
				// Persist the events we already accumulated via the
				// caller's event slice, then bail — no point continuing
				// to spend tokens against a dead stream.
				events = append(events, storage.ToolEventRow{
					ToolCallID:    tc.ID,
					Name:          tc.Name,
					ArgsJSON:      string(tc.Args),
					ResultContent: output,
					IsError:       isErr,
					Ordinal:       toolOrdinal,
				})
				toolOrdinal++
				return assistant.String(), totalIn, totalOut, events, "send error"
			}
			events = append(events, storage.ToolEventRow{
				ToolCallID:    tc.ID,
				Name:          tc.Name,
				ArgsJSON:      string(tc.Args),
				ResultContent: output,
				IsError:       isErr,
				Ordinal:       toolOrdinal,
			})
			toolOrdinal++
			roundMsgs = append(roundMsgs, llm.Message{
				Role:      llm.RoleTool,
				ToolUseID: tc.ID,
				Content:   output,
			})
		}
	}
	return assistant.String(), totalIn, totalOut, events, llmErr
}
