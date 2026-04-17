// Package chat owns the ChatService implementation: persistence against
// SQLite, an LLM streaming pipeline, and the @file injection helper.
// Authentication is enforced upstream by the auth.RequireAuth Connect
// interceptor, so handlers here can trust that ctx carries a principal.
package chat

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/gen/go/gitchat/v1/gitchatv1connect"
	"github.com/pders01/git-chat/internal/auth"
	"github.com/pders01/git-chat/internal/chat/llm"
	"github.com/pders01/git-chat/internal/chat/tools"
	"github.com/pders01/git-chat/internal/config"
	"github.com/pders01/git-chat/internal/repo"
	"github.com/pders01/git-chat/internal/storage"
	"github.com/pders01/git-chat/internal/webhook"
)

// Service wires all the chat dependencies. The zero value is not usable;
// construct via Config with every field set.
type Service struct {
	gitchatv1connect.UnimplementedChatServiceHandler

	DB    *storage.DB
	LLM   llm.LLM
	Repos *repo.Registry
	// Config, when non-nil, enables dynamic LLM resolution: the
	// provider, model, and parameters are read from the config
	// registry on each request instead of using the static struct
	// fields. When nil, the struct fields below are used directly.
	Config *config.Registry
	// Model is the default LLM model name. Used as fallback when
	// Config is nil or LLM_MODEL is empty in the registry.
	Model       string
	Temperature float32
	MaxTokens   int
	// DisableSmartTitle suppresses the background LLM call that
	// generates session titles. Set true in tests to avoid races
	// with the Fake adapter's LastRequest tracking.
	DisableSmartTitle bool
	Webhook           *webhook.Sender
	// Tools, when non-nil, enables the agentic loop: the adapter is
	// told about the registered tools and the service wraps a
	// multi-round execute-on-tool-use loop around Stream. Leave nil
	// to keep the single-shot pipeline (e.g. for providers whose
	// adapters do not implement tool use yet, or for modes that want
	// deterministic single-turn behaviour like title generation).
	Tools *tools.Registry

	// llmMu protects llmSnap and LLM during lazy adapter swaps.
	llmMu   sync.Mutex
	llmSnap llmSnapshot
}

// llmSnapshot tracks the config values used to construct the current
// LLM adapter. When any value changes, the adapter is reconstructed.
type llmSnapshot struct {
	Backend string
	BaseURL string
	APIKey  string
}

var _ gitchatv1connect.ChatServiceHandler = (*Service)(nil)

// resolveLLM returns the current LLM adapter, lazily reconstructing it
// when the backend, base URL, or API key has changed in the config
// registry. On construction error the previous adapter is kept and the
// error is returned so the caller can surface it.
func (s *Service) resolveLLM(ctx context.Context) (llm.LLM, error) {
	if s.Config == nil {
		return s.LLM, nil
	}
	backend := s.Config.GetCtx(ctx, "LLM_BACKEND")
	baseURL := s.Config.GetCtx(ctx, "LLM_BASE_URL")
	apiKey := s.Config.GetCtx(ctx, "LLM_API_KEY")

	s.llmMu.Lock()
	defer s.llmMu.Unlock()

	snap := llmSnapshot{Backend: backend, BaseURL: baseURL, APIKey: apiKey}
	if snap == s.llmSnap && s.LLM != nil {
		return s.LLM, nil
	}
	model := s.Config.GetCtx(ctx, "LLM_MODEL")
	adapter, err := llm.Build(backend, baseURL, apiKey, &model)
	if err != nil {
		if s.LLM != nil {
			return s.LLM, err
		}
		return nil, err
	}
	s.LLM = adapter
	s.llmSnap = snap
	if model != "" {
		s.Model = model
	}
	return adapter, nil
}

// llmParams reads the current model, temperature, and max-tokens from
// the config registry with fallback to the struct fields set at startup.
func (s *Service) llmParams(ctx context.Context) (model string, temp float32, maxTok int) {
	model = s.Model
	temp = s.Temperature
	maxTok = s.MaxTokens
	if s.Config == nil {
		return
	}
	if m := s.Config.GetCtx(ctx, "LLM_MODEL"); m != "" {
		model = m
	}
	if v := s.Config.GetCtx(ctx, "LLM_TEMPERATURE"); v != "" {
		if f, err := strconv.ParseFloat(v, 32); err == nil {
			temp = float32(f)
		}
	}
	if v := s.Config.GetCtx(ctx, "LLM_MAX_TOKENS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			maxTok = n
		}
	}
	return
}

// Package-level tunables, configurable via environment variables.
var (
	maxMessageBytes      = envIntSvc("GITCHAT_MAX_MESSAGE_BYTES", 32*1024)
	maxHistoryTurns      = envIntSvc("GITCHAT_MAX_HISTORY_TURNS", 20)
	maxTitleLen          = envIntSvc("GITCHAT_TITLE_MAX_LEN", 48)
	titleTimeout         = envDurSvc("GITCHAT_TITLE_TIMEOUT", 15*time.Second)
	cardTimeout          = envDurSvc("GITCHAT_CARD_TIMEOUT", 10*time.Second)
	maxAttachmentsPerMsg = envIntSvc("GITCHAT_MAX_ATTACHMENTS_PER_MESSAGE", 8)
	maxAttachmentBytes   = envIntSvc("GITCHAT_MAX_ATTACHMENT_BYTES", 10*1024*1024)
	maxAttachmentTotal   = envIntSvc("GITCHAT_MAX_ATTACHMENTS_TOTAL_BYTES", 20*1024*1024)
	toolLoopMax          = envIntSvc("GITCHAT_TOOL_LOOP_MAX", 8)
)

// allowedAttachmentMIMEs restricts uploads to image types Anthropic's
// multimodal API accepts plus plain-text blobs we fold into the prompt
// body. Other types are rejected with InvalidArgument rather than
// silently dropped so the UI can surface a clear error.
var allowedAttachmentMIMEs = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
	"text/plain": true,
}

// ─── ListSessions ───────────────────────────────────────────────────────
func (s *Service) ListSessions(
	ctx context.Context,
	req *connect.Request[gitchatv1.ListSessionsRequest],
) (*connect.Response[gitchatv1.ListSessionsResponse], error) {
	principal, _, _ := auth.PrincipalFromContext(ctx)
	rows, err := s.DB.ListSessions(ctx, principal, req.Msg.RepoId, 0, 0)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := make([]*gitchatv1.ChatSession, 0, len(rows))
	for _, r := range rows {
		out = append(out, toSession(r))
	}
	return connect.NewResponse(&gitchatv1.ListSessionsResponse{Sessions: out}), nil
}

// ─── GetSession ─────────────────────────────────────────────────────────
func (s *Service) GetSession(
	ctx context.Context,
	req *connect.Request[gitchatv1.GetSessionRequest],
) (*connect.Response[gitchatv1.GetSessionResponse], error) {
	principal, _, _ := auth.PrincipalFromContext(ctx)
	sess, err := s.DB.GetSession(ctx, principal, req.Msg.SessionId)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	msgs, err := s.DB.ListMessages(ctx, sess.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	attachments, err := s.DB.ListAttachmentsForSession(ctx, sess.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	toolEvents, err := s.DB.ListToolEventsForSession(ctx, sess.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	protoMsgs := make([]*gitchatv1.ChatMessage, 0, len(msgs))
	for _, m := range msgs {
		protoMsgs = append(protoMsgs, toMessage(m, attachments[m.ID], toolEvents[m.ID]))
	}
	return connect.NewResponse(&gitchatv1.GetSessionResponse{
		Session:  toSession(sess),
		Messages: protoMsgs,
	}), nil
}

// ─── DeleteSession ──────────────────────────────────────────────────────
func (s *Service) Search(
	ctx context.Context,
	req *connect.Request[gitchatv1.SearchRequest],
) (*connect.Response[gitchatv1.SearchResponse], error) {
	limit := int(req.Msg.Limit)
	if limit <= 0 {
		limit = 10
	}
	var hits []*gitchatv1.SearchHit

	// Search KB cards.
	cards, err := s.DB.SearchCards(ctx, req.Msg.Query, limit)
	if err != nil {
		slog.Warn("search: cards query failed", "err", err)
	}
	for _, c := range cards {
		hits = append(hits, &gitchatv1.SearchHit{
			Source: c.Source,
			Id:     c.ID,
			Title:  c.Title,
			Body:   c.Body,
		})
	}

	// Search chat messages (scoped to current principal).
	principal, _, _ := auth.PrincipalFromContext(ctx)
	msgs, err := s.DB.SearchMessages(ctx, req.Msg.Query, principal, limit)
	if err != nil {
		slog.Warn("search: messages query failed", "err", err)
	}
	for _, m := range msgs {
		hits = append(hits, &gitchatv1.SearchHit{
			Source: m.Source,
			Id:     m.ID,
			Title:  m.Title,
			Body:   m.Body,
		})
	}

	// Search file paths in repo.
	if r := s.Repos.Get(req.Msg.RepoId); r != nil {
		paths, err := r.AllFilePaths()
		if err != nil {
			slog.Warn("search: file paths query failed", "err", err)
		}
		query := strings.ToLower(req.Msg.Query)
		count := 0
		for _, p := range paths {
			if count >= limit {
				break
			}
			if strings.Contains(strings.ToLower(p), query) {
				hits = append(hits, &gitchatv1.SearchHit{
					Source: "file",
					Id:     p,
					Title:  p,
				})
				count++
			}
		}
	}

	return connect.NewResponse(&gitchatv1.SearchResponse{Hits: hits}), nil
}

func (s *Service) RenameSession(
	ctx context.Context,
	req *connect.Request[gitchatv1.RenameSessionRequest],
) (*connect.Response[gitchatv1.RenameSessionResponse], error) {
	principal, _, _ := auth.PrincipalFromContext(ctx)
	title := strings.TrimSpace(req.Msg.Title)
	if title == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("empty title"))
	}
	// Verify ownership.
	if _, err := s.DB.GetSession(ctx, principal, req.Msg.SessionId); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if err := s.DB.UpdateSessionTitle(ctx, req.Msg.SessionId, title); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&gitchatv1.RenameSessionResponse{}), nil
}

// ─── PinSession ────────────────────────────────────────────────────────
func (s *Service) PinSession(
	ctx context.Context,
	req *connect.Request[gitchatv1.PinSessionRequest],
) (*connect.Response[gitchatv1.PinSessionResponse], error) {
	principal, _, _ := auth.PrincipalFromContext(ctx)
	if err := s.DB.PinSession(ctx, principal, req.Msg.SessionId, req.Msg.Pinned); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&gitchatv1.PinSessionResponse{}), nil
}

func (s *Service) DeleteSession(
	ctx context.Context,
	req *connect.Request[gitchatv1.DeleteSessionRequest],
) (*connect.Response[gitchatv1.DeleteSessionResponse], error) {
	principal, _, _ := auth.PrincipalFromContext(ctx)
	if err := s.DB.DeleteSession(ctx, principal, req.Msg.SessionId); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&gitchatv1.DeleteSessionResponse{}), nil
}

// ─── SendMessage ────────────────────────────────────────────────────────
//
// SendMessage is the RPC binding; the real work lives in StreamMessage.
func (s *Service) SendMessage(
	ctx context.Context,
	req *connect.Request[gitchatv1.SendMessageRequest],
	stream *connect.ServerStream[gitchatv1.MessageChunk],
) error {
	return s.StreamMessage(ctx, req.Msg, stream.Send)
}

// StreamMessage runs the chat turn and streams chunks via send.
//
// Lifecycle of one call:
//  1. Resolve (or create) the session. Creation pins the session to the
//     current repo_id; subsequent turns on the session can skip repo_id.
//  2. Persist the user turn.
//  3. Load prior messages (not including the one we just inserted — we
//     add that to the prompt from the request directly).
//  4. Build the prompt, including @file context injection.
//  5. Open the LLM stream, forward tokens, accumulate the assistant text.
//  6. Persist the assistant turn (with final counts), send Done.
func (s *Service) StreamMessage(
	ctx context.Context,
	msg *gitchatv1.SendMessageRequest,
	send func(*gitchatv1.MessageChunk) error,
) error {
	principal, _, _ := auth.PrincipalFromContext(ctx)
	text := strings.TrimSpace(msg.Text)
	if text == "" && len(msg.Attachments) == 0 {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("empty message"))
	}
	// Cap message length — unbounded input goes to the LLM and SQLite.
	if len(text) > maxMessageBytes {
		return connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("message too long (%d bytes, max %d)", len(text), maxMessageBytes))
	}
	if err := validateAttachments(msg.Attachments); err != nil {
		return connect.NewError(connect.CodeInvalidArgument, err)
	}

	// ── Resolve or create the session.
	var sess *storage.SessionRow
	var repoEntry *repo.Entry
	isNew := msg.SessionId == ""
	if msg.SessionId != "" {
		existing, err := s.DB.GetSession(ctx, principal, msg.SessionId)
		if err != nil {
			if errors.Is(err, storage.ErrNotFound) {
				return connect.NewError(connect.CodeNotFound, err)
			}
			return connect.NewError(connect.CodeInternal, err)
		}
		sess = existing
		repoEntry = s.Repos.Get(sess.RepoID)
		if repoEntry == nil {
			return connect.NewError(connect.CodeFailedPrecondition,
				errors.New("session's repo is no longer registered"))
		}
	} else {
		repoEntry = s.Repos.Get(msg.RepoId)
		if repoEntry == nil {
			return connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
		}
		title := makeTitle(text)
		created, err := s.DB.CreateSession(ctx, newID(), principal, repoEntry.ID, title)
		if err != nil {
			return connect.NewError(connect.CodeInternal, err)
		}
		sess = created
	}

	// ── Edit / regenerate: truncate the session at the target message
	// before appending the new user turn. replace_from_message_id is
	// expected to be a message already in this session; any mismatch
	// (wrong session, deleted id) returns zero rows and we proceed as
	// a normal append, which matches "client raced; the message is
	// already gone" behaviour.
	if msg.ReplaceFromMessageId != "" {
		if _, err := s.DB.DeleteMessagesFrom(ctx, sess.ID, msg.ReplaceFromMessageId); err != nil {
			return connect.NewError(connect.CodeInternal, err)
		}
	}

	// ── Persist the user turn.
	userMsgID := newID()
	if err := s.DB.CreateMessage(ctx, storage.MessageRow{
		ID:        userMsgID,
		SessionID: sess.ID,
		Role:      "user",
		Content:   text,
	}); err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}
	for _, a := range msg.Attachments {
		if err := s.DB.CreateAttachment(ctx, storage.AttachmentRow{
			ID:        newID(),
			MessageID: userMsgID,
			MimeType:  a.MimeType,
			Filename:  a.Filename,
			Size:      int64(len(a.Data)),
			Data:      a.Data,
		}); err != nil {
			return connect.NewError(connect.CodeInternal, err)
		}
	}

	// Resolve the LLM adapter and parameters for this request. The
	// adapter is lazily reconstructed when config changes (e.g. user
	// switches from openai to anthropic in the settings UI).
	adapter, err := s.resolveLLM(ctx)
	if err != nil {
		slog.Warn("LLM adapter reconstruction failed, using previous", "err", err)
	}
	if adapter == nil {
		return connect.NewError(connect.CodeInternal, errors.New("no LLM adapter available"))
	}
	model, temperature, maxTokens := s.llmParams(ctx)

	// Resolve the adapter's capability profile for the active model so
	// we can strip attachments the model cannot consume before they
	// reach the LLM. Persisted attachments are untouched — only the
	// prompt payload is filtered, so the transcript still reflects
	// what the user actually uploaded.
	caps := adapter.Capabilities(ctx, model)
	var warnings []string
	if !caps.Images && hasImageAttachment(msg.Attachments) {
		warnings = append(warnings,
			fmt.Sprintf("images stripped — model %q does not report vision support", model))
	}

	// Tell the client the user turn's canonical ID (and the session's,
	// if we just created one) before we start the LLM stream. Retries
	// after a mid-stream failure need user_message_id to pass through
	// replace_from_message_id and truncate the failed pair — without
	// this the client only learns the ID from Done, which doesn't
	// arrive on error.
	startedSessionID := ""
	if isNew {
		startedSessionID = sess.ID
	}
	if err := send(&gitchatv1.MessageChunk{
		Kind: &gitchatv1.MessageChunk_Started{
			Started: &gitchatv1.Started{
				UserMessageId: userMsgID,
				SessionId:     startedSessionID,
				Warnings:      warnings,
			},
		},
	}); err != nil {
		return err
	}

	// ── Knowledge-base fast path (M5). If a valid card exists for
	// this exact (normalized) question and its provenance still
	// matches HEAD, skip the LLM entirely and return the cached
	// answer.
	normalizedQ := storage.NormalizeQuestion(text)
	repoID := repoEntry.ID
	headCommit := repoEntry.HeadCommit()

	card, cardErr := s.DB.FindValidCard(ctx, repoID, normalizedQ)
	if cardErr == nil && card != nil {
		// Verify provenance if HEAD moved since last verification.
		if card.LastVerifiedCommit != headCommit {
			if stillValid := s.verifyProvenance(ctx, card, repoEntry, headCommit); !stillValid {
				card = nil // fall through to LLM
			}
		}
		if card != nil {
			// Fast path: serve from cache.
			_ = s.DB.IncrementCardHit(ctx, card.ID)
			if err := send(&gitchatv1.MessageChunk{
				Kind: &gitchatv1.MessageChunk_CardHit{
					CardHit: &gitchatv1.KnowledgeCardHit{
						CardId:        card.ID,
						AnswerMd:      card.AnswerMD,
						Model:         card.Model,
						HitCount:      int32(card.HitCount + 1),
						CreatedCommit: card.CreatedCommit,
					},
				},
			}); err != nil {
				return err
			}
			// Persist as an assistant turn so the transcript is complete.
			assistantID := newID()
			if err := s.DB.CreateMessage(ctx, storage.MessageRow{
				ID:        assistantID,
				SessionID: sess.ID,
				Role:      "assistant",
				Content:   card.AnswerMD,
				Model:     card.Model,
			}); err != nil {
				slog.Warn("KB cache hit: failed to persist assistant message", "err", err)
			}
			if err := s.DB.TouchSession(ctx, sess.ID); err != nil {
				slog.Warn("KB cache hit: failed to touch session", "err", err)
			}
			return send(&gitchatv1.MessageChunk{
				Kind: &gitchatv1.MessageChunk_Done{
					Done: &gitchatv1.Done{
						SessionId:          sess.ID,
						UserMessageId:      userMsgID,
						AssistantMessageId: assistantID,
						Model:              card.Model,
					},
				},
			})
		}
	}

	// ── Load history (oldest → newest) for the prompt.
	history, err := s.DB.ListMessages(ctx, sess.ID)
	if err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}
	// The message we just inserted is in history; drop the tail so we
	// don't duplicate it when we append the user turn in buildPrompt.
	if n := len(history); n > 0 && history[n-1].ID == userMsgID {
		history = history[:n-1]
	}
	// Sliding window: only send the most recent N turns to the LLM.
	// Long sessions accumulate hundreds of messages that blow the
	// context window. We keep the last maxHistoryTurns messages
	// (each user+assistant pair = 2 entries). Older context is still
	// in SQLite for the user to scroll through.
	if len(history) > maxHistoryTurns {
		history = history[len(history)-maxHistoryTurns:]
	}

	// ── Build the prompt and start the LLM stream.
	//
	// We deliberately do NOT return a connect.Error when the LLM adapter
	// fails to start — we want the browser to see the failure *inside*
	// the stream (as the error field on the Done chunk), not as a
	// top-level RPC error. The connect-web client turns top-level errors
	// into opaque "unexpected end of JSON input" messages, while inline
	// errors render cleanly next to the assistant turn.
	historyAttachments, err := s.DB.ListAttachmentsForSession(ctx, sess.ID)
	if err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}
	currentAttachments := protoToLLMAttachments(msg.Attachments)
	if !caps.Images {
		currentAttachments = stripImageAttachments(currentAttachments)
		historyAttachments = stripImageHistory(historyAttachments)
	}
	historyToolEvents, err := s.DB.ListToolEventsForSession(ctx, sess.ID)
	if err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}
	msgs := s.buildPrompt(ctx, repoEntry, history, text, currentAttachments, historyAttachments, historyToolEvents)
	var assistant strings.Builder
	var finalIn, finalOut int
	var llmErr string

	// Build the tool spec once — the catalog is stable across rounds.
	var toolSpecs []llm.ToolSpec
	if s.Tools != nil {
		for _, sp := range s.Tools.Specs() {
			toolSpecs = append(toolSpecs, llm.ToolSpec{
				Name:        sp.Name,
				Description: sp.Description,
				InputSchema: sp.InputSchema,
			})
		}
	}

	// ── Agentic loop.
	//
	// Each round we stream the LLM's next response, forwarding token
	// chunks and tool_use chunks to the client as they arrive. If the
	// round emits any tool_use, we execute each tool via the registry,
	// append {assistant: tool_calls} + {tool: result} messages to the
	// prompt, and go again. The loop terminates when a round produces
	// no tool_use (the model has answered), the adapter fails, or the
	// hard round cap is hit.
	var persistedEvents []storage.ToolEventRow
	toolOrdinal := 0
	roundMsgs := append([]llm.Message(nil), msgs...)
	for round := 0; round < toolLoopMax; round++ {
		slog.Debug("agentic round starting", "round", round, "msgs", len(roundMsgs))
		llmChunks, err := adapter.Stream(ctx, llm.Request{
			Model:       model,
			Messages:    roundMsgs,
			Temperature: temperature,
			MaxTokens:   maxTokens,
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
					return err
				}
			case llm.ChunkReasoning:
				if err := send(&gitchatv1.MessageChunk{
					Kind: &gitchatv1.MessageChunk_Thinking{Thinking: c.Reasoning},
				}); err != nil {
					return err
				}
			case llm.ChunkToolUse:
				tc := llm.ToolCall{ID: c.ToolUseID, Name: c.ToolName, Args: c.ToolArgs}
				roundCalls = append(roundCalls, tc)
				if err := send(&gitchatv1.MessageChunk{
					Kind: &gitchatv1.MessageChunk_ToolCall{
						ToolCall: &gitchatv1.ToolCall{
							Id:       c.ToolUseID,
							Name:     c.ToolName,
							ArgsJson: string(c.ToolArgs),
						},
					},
				}); err != nil {
					return err
				}
			case llm.ChunkDone:
				finalIn = c.TokenCountIn
				finalOut = c.TokenCountOut
				llmErr = c.Error
			}
		}
		slog.Debug("agentic round finished", "round", round,
			"text_bytes", roundText.Len(), "calls", len(roundCalls),
			"llm_err", llmErr)
		if llmErr != "" || len(roundCalls) == 0 || s.Tools == nil {
			break
		}
		// Replay this round's assistant output into roundMsgs so the
		// next Stream call sees the tool_use blocks in history.
		roundMsgs = append(roundMsgs, llm.Message{
			Role:      llm.RoleAssistant,
			Content:   roundText.String(),
			ToolCalls: roundCalls,
		})
		// Execute each tool and forward the result both to the client
		// (for immediate UI rendering) and back into the prompt.
		for _, tc := range roundCalls {
			output, execErr := s.Tools.Execute(ctx, repoEntry, tc.Name, tc.Args)
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
				return err
			}
			persistedEvents = append(persistedEvents, storage.ToolEventRow{
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
		if round == toolLoopMax-1 {
			// Surface the cap on the next Done chunk so the UI can
			// tell the user why the assistant stopped short.
			llmErr = fmt.Sprintf("tool loop cap reached (%d rounds)", toolLoopMax)
		}
	}

	// ── Persist the assistant turn and touch the session.
	assistantContent := assistant.String()
	assistantID := newID()
	if err := s.DB.CreateMessage(ctx, storage.MessageRow{
		ID:            assistantID,
		SessionID:     sess.ID,
		Role:          "assistant",
		Content:       assistantContent,
		Model:         model,
		TokenCountIn:  finalIn,
		TokenCountOut: finalOut,
	}); err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}
	// Persist every tool call + result from the agentic loop. Errors
	// are logged but don't fail the turn — tool history is useful for
	// rehydration but not load-bearing for the answer itself.
	for _, ev := range persistedEvents {
		ev.ID = newID()
		ev.MessageID = assistantID
		if err := s.DB.CreateToolEvent(ctx, ev); err != nil {
			slog.Warn("persist tool event failed", "err", err, "tool", ev.Name)
		}
	}
	if err := s.DB.TouchSession(ctx, sess.ID); err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}

	// ── Post-LLM: check whether this question has been asked enough
	// times (N-threshold) to warrant caching as a knowledge card.
	// The current promotion policy requires N≥2 similar
	// past user messages (via FTS5) before promoting. This prevents
	// one-off poorly-phrased questions from polluting the KB.
	if assistantContent != "" && llmErr == "" {
		go s.maybePromoteCard(model, repoID, normalizedQ, assistantContent, headCommit, text, repoEntry, principal)
	}

	// Fire-and-forget title generation for new sessions. The user
	// sees the fallback truncated-first-message title immediately;
	// this goroutine generates a short LLM-powered title and updates
	// it in SQLite. The next time the client fetches the session list
	// (which happens on the Done chunk re-fetch), it picks up the
	// smart title. Errors are swallowed — a bad title is cosmetic.
	if isNew && !s.DisableSmartTitle {
		go s.generateSmartTitle(adapter, model, sess.ID, text, assistantContent)
	}

	// ── Final Done chunk.
	if err := send(&gitchatv1.MessageChunk{
		Kind: &gitchatv1.MessageChunk_Done{
			Done: &gitchatv1.Done{
				SessionId:          sess.ID,
				UserMessageId:      userMsgID,
				AssistantMessageId: assistantID,
				TokenCountIn:       int32(finalIn),
				TokenCountOut:      int32(finalOut),
				Model:              model,
				Error:              llmErr,
			},
		},
	}); err != nil {
		return err
	}
	return nil
}

// ─── ListCards ─────────────────────────────────────────────────────────
func (s *Service) ListCards(
	ctx context.Context,
	req *connect.Request[gitchatv1.ListCardsRequest],
) (*connect.Response[gitchatv1.ListCardsResponse], error) {
	rows, err := s.DB.ListCards(ctx, req.Msg.RepoId)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	cards := make([]*gitchatv1.KBCard, 0, len(rows))
	for _, r := range rows {
		preview := r.AnswerMD
		if len(preview) > 200 {
			preview = preview[:200]
		}
		cards = append(cards, &gitchatv1.KBCard{
			Id:            r.ID,
			Question:      r.QuestionNormalized,
			AnswerPreview: preview,
			Model:         r.Model,
			CreatedBy:     r.CreatedBy,
			HitCount:      int32(r.HitCount),
			CreatedAt:     r.CreatedAt,
			Invalidated:   r.InvalidatedAt != 0,
		})
	}
	return connect.NewResponse(&gitchatv1.ListCardsResponse{Cards: cards}), nil
}

// ─── GetCard ──────────────────────────────────────────────────────────
func (s *Service) GetCard(
	ctx context.Context,
	req *connect.Request[gitchatv1.GetCardRequest],
) (*connect.Response[gitchatv1.GetCardResponse], error) {
	card, err := s.DB.GetCard(ctx, req.Msg.CardId)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	provRows, _ := s.DB.ListProvenance(ctx, req.Msg.CardId)
	prov := make([]*gitchatv1.CardProvenance, 0, len(provRows))
	for _, p := range provRows {
		prov = append(prov, &gitchatv1.CardProvenance{
			Path:    p.Path,
			BlobSha: p.BlobSHA,
		})
	}
	return connect.NewResponse(&gitchatv1.GetCardResponse{
		Id:            card.ID,
		Question:      card.QuestionNormalized,
		AnswerMd:      card.AnswerMD,
		Model:         card.Model,
		CreatedBy:     card.CreatedBy,
		HitCount:      int32(card.HitCount),
		CreatedAt:     card.CreatedAt,
		Invalidated:   card.InvalidatedAt != 0,
		CreatedCommit: card.CreatedCommit,
		Provenance:    prov,
	}), nil
}

// ─── SummarizeActivity ────────────────────────────────────────────────

func (s *Service) SummarizeActivity(
	ctx context.Context,
	req *connect.Request[gitchatv1.SummarizeActivityRequest],
) (*connect.Response[gitchatv1.SummarizeActivityResponse], error) {
	r := s.Repos.Get(req.Msg.RepoId)
	if r == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}

	commits, _, _ := r.ListCommits(ctx, "", 10, 0, "")
	if len(commits) == 0 {
		return connect.NewResponse(&gitchatv1.SummarizeActivityResponse{
			Summary: "No commits yet.",
		}), nil
	}

	// Build a commit log for the LLM.
	var commitLog strings.Builder
	for _, c := range commits {
		fmt.Fprintf(&commitLog, "- %s %s (%s)\n", c.ShortSha, c.Message, c.AuthorName)
	}

	prompt := []llm.Message{
		{Role: llm.RoleSystem, Content: `You are summarizing recent git activity for a dashboard. Be concise and informative.
Output exactly TWO sections separated by ---:
1. A 2-3 sentence summary of what's been happening in the project recently. Mention key areas of work, not individual commits.
2. Three suggested questions a developer might want to ask about this repo, one per line. Make them specific to the actual activity.`},
		{Role: llm.RoleUser, Content: "Here are the recent commits:\n\n" + commitLog.String() + "\nSummarize the recent activity and suggest questions."},
	}

	adapter, err := s.resolveLLM(ctx)
	if err != nil {
		slog.Warn("LLM adapter reconstruction failed in SummarizeActivity", "err", err)
	}
	if adapter == nil {
		return connect.NewResponse(&gitchatv1.SummarizeActivityResponse{
			Summary: "Recent commits:\n" + commitLog.String(),
		}), nil
	}
	model, _, _ := s.llmParams(ctx)

	ctx2, cancel := context.WithTimeout(ctx, titleTimeout)
	defer cancel()

	chunks, err := adapter.Stream(ctx2, llm.Request{
		Model:    model,
		Messages: prompt,
	})
	if err != nil {
		// Fallback: return raw commit list.
		return connect.NewResponse(&gitchatv1.SummarizeActivityResponse{
			Summary: "Recent commits:\n" + commitLog.String(),
		}), nil
	}

	var sb strings.Builder
	for chunk := range chunks {
		if chunk.Kind == llm.ChunkToken {
			sb.WriteString(chunk.Token)
		} else if chunk.Kind == llm.ChunkDone {
			break
		}
	}

	result := sb.String()
	parts := strings.SplitN(result, "---", 2)
	summary := strings.TrimSpace(parts[0])
	var suggestions []string
	if len(parts) > 1 {
		for _, line := range strings.Split(strings.TrimSpace(parts[1]), "\n") {
			line = strings.TrimSpace(line)
			line = strings.TrimLeft(line, "0123456789.-) ")
			if line != "" {
				suggestions = append(suggestions, line)
			}
		}
	}

	return connect.NewResponse(&gitchatv1.SummarizeActivityResponse{
		Summary:     summary,
		Suggestions: suggestions,
	}), nil
}

// ─── DeleteCard ────────────────────────────────────────────────────────
func (s *Service) DeleteCard(
	ctx context.Context,
	req *connect.Request[gitchatv1.DeleteCardRequest],
) (*connect.Response[gitchatv1.DeleteCardResponse], error) {
	if err := s.DB.DeleteCard(ctx, req.Msg.CardId); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&gitchatv1.DeleteCardResponse{}), nil
}

// ─── Helpers ────────────────────────────────────────────────────────────

// generateSmartTitle calls the LLM with a tiny prompt to generate a
// 3-5 word title for a new session. Runs in a background goroutine
// so the user doesn't wait for it — the fallback (truncated first
// message) is shown immediately, and the smart title replaces it on
// the next session-list fetch. Errors are swallowed (cosmetic-only).
func (s *Service) generateSmartTitle(adapter llm.LLM, model, sessionID, userMsg, assistantMsg string) {
	// Use a brief excerpt of the assistant reply — the full content
	// can be pages long and we only need the gist for a title.
	assistantExcerpt := assistantMsg
	if len(assistantExcerpt) > 300 {
		assistantExcerpt = assistantExcerpt[:300] + "…"
	}

	prompt := []llm.Message{
		{Role: llm.RoleSystem, Content: "Generate a concise 3-5 word title for the following conversation. Output ONLY the title, no quotes, no punctuation, no explanation."},
		{Role: llm.RoleUser, Content: userMsg},
		{Role: llm.RoleAssistant, Content: assistantExcerpt},
		{Role: llm.RoleUser, Content: "Generate a 3-5 word title for this conversation."},
	}

	ctx, cancel := context.WithTimeout(context.Background(), titleTimeout)
	defer cancel()

	chunks, err := adapter.Stream(ctx, llm.Request{
		Model:    model,
		Messages: prompt,
	})
	if err != nil {
		slog.Debug("title generation failed to start", "err", err)
		return
	}

	var title strings.Builder
	for c := range chunks {
		if c.Kind == llm.ChunkToken {
			title.WriteString(c.Token)
		}
	}

	result := strings.TrimSpace(title.String())
	// Strip surrounding quotes if the model added them despite instruction.
	result = strings.Trim(result, "\"'`")
	result = strings.TrimSpace(result)
	if result == "" || len(result) > 80 {
		return // give up — keep the fallback
	}

	writeCtx, writeCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer writeCancel()
	if err := s.DB.UpdateSessionTitle(writeCtx, sessionID, result); err != nil {
		slog.Debug("title update failed", "err", err)
	}
}

// verifyProvenance checks whether a card's recorded blob SHAs still
// match the current HEAD. Returns true if the card is still valid.
// If provenance is empty (no @-mentions when the card was derived),
// the card is auto-verified — it's a general question whose answer
// doesn't depend on specific files.
func (s *Service) verifyProvenance(ctx context.Context, card *storage.CardRow, r *repo.Entry, headCommit string) bool {
	provRows, err := s.DB.ListProvenance(ctx, card.ID)
	if err != nil {
		// Can't verify → treat as stale to be safe.
		_ = s.DB.InvalidateCard(ctx, card.ID)
		s.notifyInvalidation(ctx, card, r.ID, "", "provenance_error")
		return false
	}
	if len(provRows) == 0 {
		// No file dependencies → auto-verify.
		_ = s.DB.UpdateCardVerification(ctx, card.ID, headCommit)
		return true
	}
	for _, p := range provRows {
		resp, err := r.GetFile("", p.Path, 1)
		if err != nil {
			// File was deleted → stale.
			_ = s.DB.InvalidateCard(ctx, card.ID)
			s.notifyInvalidation(ctx, card, r.ID, p.Path, "file_deleted")
			return false
		}
		if resp.BlobSha != p.BlobSHA {
			// File changed → stale.
			_ = s.DB.InvalidateCard(ctx, card.ID)
			s.notifyInvalidation(ctx, card, r.ID, p.Path, "file_changed")
			return false
		}
	}
	// All provenance SHAs match → still valid.
	_ = s.DB.UpdateCardVerification(ctx, card.ID, headCommit)
	return true
}

func (s *Service) notifyInvalidation(ctx context.Context, card *storage.CardRow, repoID, path, reason string) {
	if s.Webhook == nil {
		return
	}
	s.Webhook.Send(ctx, webhook.Event{
		Type:     "card_invalidated",
		RepoID:   repoID,
		CardID:   card.ID,
		Question: card.QuestionNormalized,
		Reason:   reason,
		Path:     path,
	})
}

// cardPromotionThreshold is the minimum number of similar past user
// messages (via FTS5) required before a question gets promoted to a
// knowledge card. Set to 2 so the first ask always goes to the LLM,
// and only on the second similar question does caching kick in. This
// prevents one-off exploratory questions from polluting the KB.
var cardPromotionThreshold = envIntSvc("GITCHAT_KB_PROMOTION_THRESHOLD", 2)

// maybePromoteCard checks whether a question has been asked enough
// times to justify caching, and if so, upserts a knowledge card.
// Runs in a background goroutine — errors are cosmetic.
func (s *Service) maybePromoteCard(model, repoID, normalizedQ, answer, headCommit, userText string, r *repo.Entry, principal string) {
	ctx, cancel := context.WithTimeout(context.Background(), cardTimeout)
	defer cancel()

	// Count similar historical questions via FTS5. If below
	// threshold, skip promotion — this question hasn't been asked
	// enough to warrant caching.
	count, err := s.DB.CountSimilarUserMessages(ctx, normalizedQ)
	if err != nil {
		slog.Debug("similar-count query failed", "err", err)
		// On error, fall through and cache anyway — better to have
		// a spurious card than to silently skip promotion.
	} else if count < cardPromotionThreshold {
		return
	}

	cardID, err := s.DB.UpsertCard(ctx, storage.CardRow{
		ID:                 newID(),
		RepoID:             repoID,
		QuestionNormalized: normalizedQ,
		AnswerMD:           answer,
		Model:              model,
		CreatedCommit:      headCommit,
		LastVerifiedCommit: headCommit,
		CreatedBy:          principal,
	})
	if err != nil {
		slog.Debug("card upsert failed", "err", err)
		return
	}

	// Gather provenance from @-mentions in the user message.
	var prov []storage.ProvenanceRow
	for _, m := range filePattern.FindAllStringSubmatch(userText, -1) {
		path := strings.TrimSuffix(m[1], "/")
		resp, err := r.GetFile("", path, 1)
		if err != nil {
			continue
		}
		prov = append(prov, storage.ProvenanceRow{
			CardID:  cardID,
			Path:    path,
			BlobSHA: resp.BlobSha,
		})
	}
	if len(prov) > 0 {
		if err := s.DB.ReplaceProvenance(ctx, cardID, prov); err != nil {
			slog.Debug("provenance replace failed", "err", err)
		}
	}
}

// makeTitle derives a session title from the first message. Keeps it
// short enough to render in a sidebar, truncating on a word boundary.
func makeTitle(text string) string {
	text = strings.TrimSpace(text)
	// Collapse any whitespace run to a single space.
	text = strings.Join(strings.Fields(text), " ")
	if len(text) <= maxTitleLen {
		return text
	}
	cut := text[:maxTitleLen]
	if i := strings.LastIndexByte(cut, ' '); i > maxTitleLen/2 {
		cut = cut[:i]
	}
	return cut + "…"
}

func toSession(r *storage.SessionRow) *gitchatv1.ChatSession {
	return &gitchatv1.ChatSession{
		Id:           r.ID,
		RepoId:       r.RepoID,
		Title:        r.Title,
		CreatedAt:    r.CreatedAt,
		UpdatedAt:    r.UpdatedAt,
		MessageCount: int32(r.MessageCount),
		Pinned:       r.Pinned,
	}
}

func toMessage(r *storage.MessageRow, atts []*storage.AttachmentRow, events []*storage.ToolEventRow) *gitchatv1.ChatMessage {
	out := &gitchatv1.ChatMessage{
		Id:            r.ID,
		SessionId:     r.SessionID,
		Role:          protoRole(r.Role),
		Content:       r.Content,
		Model:         r.Model,
		TokenCountIn:  int32(r.TokenCountIn),
		TokenCountOut: int32(r.TokenCountOut),
		CreatedAt:     r.CreatedAt,
	}
	if len(atts) > 0 {
		out.Attachments = make([]*gitchatv1.Attachment, 0, len(atts))
		for _, a := range atts {
			out.Attachments = append(out.Attachments, &gitchatv1.Attachment{
				Id:       a.ID,
				MimeType: a.MimeType,
				Filename: a.Filename,
				Size:     a.Size,
				Data:     a.Data,
			})
		}
	}
	if len(events) > 0 {
		out.ToolEvents = make([]*gitchatv1.ToolEvent, 0, len(events))
		for _, e := range events {
			out.ToolEvents = append(out.ToolEvents, &gitchatv1.ToolEvent{
				ToolCallId:    e.ToolCallID,
				Name:          e.Name,
				ArgsJson:      e.ArgsJSON,
				ResultContent: e.ResultContent,
				IsError:       e.IsError,
				Ordinal:       int32(e.Ordinal),
			})
		}
	}
	return out
}

// validateAttachments enforces per-message caps on attachment count,
// per-file size, total bytes, and MIME allowlist. Any failure returns
// a human-readable error suitable for surfacing to the client.
func validateAttachments(atts []*gitchatv1.Attachment) error {
	if len(atts) == 0 {
		return nil
	}
	if len(atts) > maxAttachmentsPerMsg {
		return fmt.Errorf("too many attachments (%d, max %d)", len(atts), maxAttachmentsPerMsg)
	}
	var total int
	for _, a := range atts {
		if !allowedAttachmentMIMEs[a.MimeType] {
			return fmt.Errorf("unsupported attachment type %q", a.MimeType)
		}
		if len(a.Data) == 0 {
			return fmt.Errorf("empty attachment %q", a.Filename)
		}
		if len(a.Data) > maxAttachmentBytes {
			return fmt.Errorf("attachment %q too large (%d bytes, max %d)",
				a.Filename, len(a.Data), maxAttachmentBytes)
		}
		total += len(a.Data)
	}
	if total > maxAttachmentTotal {
		return fmt.Errorf("attachments exceed total size cap (%d bytes, max %d)",
			total, maxAttachmentTotal)
	}
	return nil
}

// protoToLLMAttachments adapts proto attachments to the adapter-facing
// shape. Called once per send for the current turn.
func protoToLLMAttachments(atts []*gitchatv1.Attachment) []llm.Attachment {
	if len(atts) == 0 {
		return nil
	}
	out := make([]llm.Attachment, 0, len(atts))
	for _, a := range atts {
		out = append(out, llm.Attachment{
			MimeType: a.MimeType,
			Filename: a.Filename,
			Data:     a.Data,
		})
	}
	return out
}

// hasImageAttachment reports whether the incoming request includes at
// least one image MIME. Used to decide whether to emit a vision-
// degradation warning.
func hasImageAttachment(atts []*gitchatv1.Attachment) bool {
	for _, a := range atts {
		if strings.HasPrefix(a.MimeType, "image/") {
			return true
		}
	}
	return false
}

// stripImageAttachments drops image entries from an adapter-facing
// attachment slice. Text attachments pass through unchanged so the
// model still sees their contents via the adapter's text fold.
func stripImageAttachments(atts []llm.Attachment) []llm.Attachment {
	out := atts[:0]
	for _, a := range atts {
		if strings.HasPrefix(a.MimeType, "image/") {
			continue
		}
		out = append(out, a)
	}
	return out
}

// stripImageHistory applies the same filter to the per-message history
// map used by buildPrompt. Mutating the values in place is safe — the
// map is scoped to a single SendMessage invocation.
func stripImageHistory(m map[string][]*storage.AttachmentRow) map[string][]*storage.AttachmentRow {
	for k, rows := range m {
		kept := rows[:0]
		for _, r := range rows {
			if strings.HasPrefix(r.MimeType, "image/") {
				continue
			}
			kept = append(kept, r)
		}
		m[k] = kept
	}
	return m
}

// storageToLLMAttachments adapts storage rows to the adapter-facing
// shape. Called while building the prompt to hydrate historical user
// turns with their images.
func storageToLLMAttachments(atts []*storage.AttachmentRow) []llm.Attachment {
	if len(atts) == 0 {
		return nil
	}
	out := make([]llm.Attachment, 0, len(atts))
	for _, a := range atts {
		out = append(out, llm.Attachment{
			MimeType: a.MimeType,
			Filename: a.Filename,
			Data:     a.Data,
		})
	}
	return out
}

func protoRole(s string) gitchatv1.MessageRole {
	switch s {
	case "user":
		return gitchatv1.MessageRole_MESSAGE_ROLE_USER
	case "assistant":
		return gitchatv1.MessageRole_MESSAGE_ROLE_ASSISTANT
	case "system":
		return gitchatv1.MessageRole_MESSAGE_ROLE_SYSTEM
	default:
		return gitchatv1.MessageRole_MESSAGE_ROLE_UNSPECIFIED
	}
}

// envIntSvc reads an env var as int, returning def if unset or invalid.
func envIntSvc(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// envDurSvc reads an env var as a time.Duration string (e.g. "30s",
// "2m"), returning def if unset or invalid.
func envDurSvc(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return def
}
