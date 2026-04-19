package chat

import (
	"context"
	"log/slog"
	"strings"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/repo"
	"github.com/pders01/git-chat/internal/storage"
	"github.com/pders01/git-chat/internal/webhook"
)

// This file contains the knowledge-base fast path and lifecycle:
//
//   - tryKBCacheHit: serve a cached answer when we can (and short-
//     circuit the LLM round trip entirely).
//   - verifyProvenance + notifyInvalidation: stale-cache invalidation
//     keyed on blob-SHA comparison against HEAD.
//   - maybePromoteCard: post-response promotion to the cache for
//     questions that have been asked enough to be worth caching.
//
// All three methods remain on *Service so the shared state (DB,
// Webhook, cfgInt/cfgDur) stays reachable. This file groups them so
// the KB lifecycle is legible in one place; service.go then only
// *calls* tryKBCacheHit (cache read) and maybePromoteCard (cache write).

// tryKBCacheHit checks whether a valid knowledge card can answer the
// question without calling the LLM. Returns (true, nil) when the cache
// hit was served, (false, nil) to fall through to the LLM.
func (s *Service) tryKBCacheHit(
	ctx context.Context, sc *streamCtx,
	send func(*gitchatv1.MessageChunk) error,
) (bool, error) {
	normalizedQ := storage.NormalizeQuestion(sc.text)
	headCommit := sc.repo.HeadCommit()

	card, cardErr := s.DB.FindValidCard(ctx, sc.repo.ID, normalizedQ)
	if cardErr != nil || card == nil {
		return false, nil
	}
	if card.LastVerifiedCommit != headCommit {
		if !s.verifyProvenance(ctx, card, sc.repo, headCommit) {
			return false, nil
		}
	}

	if err := s.DB.IncrementCardHit(ctx, card.ID); err != nil {
		// Hit-count drift corrupts KB promotion thresholds — promotion
		// decides whether an answer graduates to cached. Log loudly so
		// operators notice; the cache hit itself still serves the user.
		slog.Warn("KB increment-hit failed", "card_id", card.ID, "err", err)
	}
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
		return true, err
	}
	assistantID := newID()
	if err := s.DB.CreateMessage(ctx, storage.MessageRow{
		ID:        assistantID,
		SessionID: sc.sess.ID,
		Role:      "assistant",
		Content:   card.AnswerMD,
		Model:     card.Model,
	}); err != nil {
		slog.Warn("KB cache hit: failed to persist assistant message", "err", err)
	}
	if err := s.DB.TouchSession(ctx, sc.sess.ID); err != nil {
		slog.Warn("KB cache hit: failed to touch session", "err", err)
	}
	return true, send(&gitchatv1.MessageChunk{
		Kind: &gitchatv1.MessageChunk_Done{
			Done: &gitchatv1.Done{
				SessionId:          sc.sess.ID,
				UserMessageId:      sc.userMsgID,
				AssistantMessageId: assistantID,
				Model:              card.Model,
			},
		},
	})
}

// verifyProvenance checks whether a card's recorded blob SHAs still
// match the current HEAD. Returns true if the card is still valid.
// If provenance is empty (no @-mentions when the card was derived),
// the card is auto-verified — it's a general question whose answer
// doesn't depend on specific files.
func (s *Service) verifyProvenance(ctx context.Context, card *storage.CardRow, r *repo.Entry, headCommit string) bool {
	// Helper: log-and-continue for provenance DB writes. These writes
	// aren't on the user's critical path — the caller has already decided
	// the correctness action (return true/false); we just need the record
	// to persist. If the write fails, the card remains in its prior state
	// and the next verification will re-check, so we log rather than
	// propagate. Silent discards hid DB contention in production.
	invalidate := func(reason string, path string) {
		if err := s.DB.InvalidateCard(ctx, card.ID); err != nil {
			slog.Warn("KB invalidate failed", "card_id", card.ID, "reason", reason, "err", err)
		}
		s.notifyInvalidation(ctx, card, r.ID, path, reason)
	}
	markVerified := func() {
		if err := s.DB.UpdateCardVerification(ctx, card.ID, headCommit); err != nil {
			slog.Warn("KB verify-update failed", "card_id", card.ID, "err", err)
		}
	}

	provRows, err := s.DB.ListProvenance(ctx, card.ID)
	if err != nil {
		// Can't verify → treat as stale to be safe.
		invalidate("provenance_error", "")
		return false
	}
	if len(provRows) == 0 {
		// No file dependencies → auto-verify.
		markVerified()
		return true
	}
	for _, p := range provRows {
		resp, err := r.GetFile("", p.Path, 1)
		if err != nil {
			// File was deleted → stale.
			invalidate("file_deleted", p.Path)
			return false
		}
		if resp.BlobSha != p.BlobSHA {
			// File changed → stale.
			invalidate("file_changed", p.Path)
			return false
		}
	}
	// All provenance SHAs match → still valid.
	markVerified()
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

// maybePromoteCard checks whether a question has been asked enough
// times to justify caching, and if so, upserts a knowledge card.
// Runs in a background goroutine — errors are cosmetic.
func (s *Service) maybePromoteCard(model, repoID, normalizedQ, answer, headCommit, userText string, r *repo.Entry, principal string) {
	bg := context.Background()
	ctx, cancel := context.WithTimeout(bg, s.cfgDur(bg, "GITCHAT_CARD_TIMEOUT", defaultCardTimeout))
	defer cancel()

	// Count similar historical questions via FTS5. If below
	// threshold, skip promotion — this question hasn't been asked
	// enough to warrant caching.
	count, err := s.DB.CountSimilarUserMessages(ctx, normalizedQ)
	if err != nil {
		slog.Debug("similar-count query failed", "err", err)
		// On error, fall through and cache anyway — better to have
		// a spurious card than to silently skip promotion.
	} else if count < s.cfgInt(ctx, "GITCHAT_KB_PROMOTION_THRESHOLD", defaultCardPromotionThreshold) {
		return
	}

	newCardID := newID()
	cardID, err := s.DB.UpsertCard(ctx, storage.CardRow{
		ID:                 newCardID,
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
	// UpsertCard returns the canonical ID — equal to newCardID only when
	// the insert landed fresh (no conflict). Updates to an existing
	// card's answer don't fire this event; otherwise webhooks would get
	// noisy every time someone re-asked a covered question.
	if cardID == newCardID && s.Webhook != nil {
		s.Webhook.Send(ctx, webhook.Event{
			Type:     "card_created",
			RepoID:   repoID,
			CardID:   cardID,
			Question: normalizedQ,
		})
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
