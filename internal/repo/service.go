package repo

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"connectrpc.com/connect"
	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/gen/go/gitchat/v1/gitchatv1connect"
	"github.com/pders01/git-chat/internal/auth"
	"github.com/pders01/git-chat/internal/config"
	"github.com/pders01/git-chat/internal/storage"
)

// Service implements gitchat.v1.RepoService backed by a Registry.
//
// Authentication is enforced at the transport layer via
// auth.RequireAuth() as a Connect interceptor, so these handlers can
// assume the caller is authenticated.
type Service struct {
	gitchatv1connect.UnimplementedRepoServiceHandler
	Registry *Registry
	Config   *config.Registry
	DB       *storage.DB
	Catalog  *Catalog
}

var _ gitchatv1connect.RepoServiceHandler = (*Service)(nil)

func (s *Service) ListRepos(
	_ context.Context,
	_ *connect.Request[gitchatv1.ListReposRequest],
) (*connect.Response[gitchatv1.ListReposResponse], error) {
	entries := s.Registry.List()
	out := make([]*gitchatv1.Repo, 0, len(entries))
	for _, e := range entries {
		out = append(out, &gitchatv1.Repo{
			Id:            e.ID,
			Label:         e.Label,
			DefaultBranch: e.DefaultBranch,
			HeadCommit:    e.HeadCommit(),
		})
	}
	return connect.NewResponse(&gitchatv1.ListReposResponse{Repos: out}), nil
}

func (s *Service) ListBranches(
	ctx context.Context,
	req *connect.Request[gitchatv1.ListBranchesRequest],
) (*connect.Response[gitchatv1.ListBranchesResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	branches, err := entry.ListBranches(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	tags, err := entry.ListTags(ctx)
	if err != nil {
		// Tags are best-effort — don't fail the whole response.
		tags = nil
	}
	return connect.NewResponse(&gitchatv1.ListBranchesResponse{Branches: branches, Tags: tags}), nil
}

func (s *Service) ListTree(
	_ context.Context,
	req *connect.Request[gitchatv1.ListTreeRequest],
) (*connect.Response[gitchatv1.ListTreeResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	entries, resolved, err := entry.ListTree(req.Msg.Ref, req.Msg.Path)
	if err != nil {
		return nil, mapErr(err)
	}
	return connect.NewResponse(&gitchatv1.ListTreeResponse{
		Entries:     entries,
		RefResolved: resolved,
	}), nil
}

func (s *Service) GetFile(
	_ context.Context,
	req *connect.Request[gitchatv1.GetFileRequest],
) (*connect.Response[gitchatv1.GetFileResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	resp, err := entry.GetFile(req.Msg.Ref, req.Msg.Path, req.Msg.MaxBytes)
	if err != nil {
		return nil, mapErr(err)
	}
	return connect.NewResponse(resp), nil
}

func (s *Service) GetBlame(
	ctx context.Context,
	req *connect.Request[gitchatv1.GetBlameRequest],
) (*connect.Response[gitchatv1.GetBlameResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	lines, err := entry.GetBlame(ctx, req.Msg.Ref, req.Msg.Path)
	if err != nil {
		return nil, mapErr(err)
	}
	return connect.NewResponse(&gitchatv1.GetBlameResponse{Lines: lines}), nil
}

func (s *Service) CompareBranches(
	ctx context.Context,
	req *connect.Request[gitchatv1.CompareBranchesRequest],
) (*connect.Response[gitchatv1.CompareBranchesResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	files, totalAdd, totalDel, err := entry.CompareBranches(ctx, req.Msg.BaseRef, req.Msg.HeadRef, req.Msg.DetectRenames)
	if err != nil {
		return nil, mapErr(err)
	}
	return connect.NewResponse(&gitchatv1.CompareBranchesResponse{
		Files:          files,
		TotalAdditions: totalAdd,
		TotalDeletions: totalDel,
	}), nil
}

func (s *Service) ListCommits(
	ctx context.Context,
	req *connect.Request[gitchatv1.ListCommitsRequest],
) (*connect.Response[gitchatv1.ListCommitsResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	commits, hasMore, err := entry.ListCommits(ctx, req.Msg.Ref, int(req.Msg.Limit), int(req.Msg.Offset), req.Msg.Path)
	if err != nil {
		return nil, mapErr(err)
	}
	return connect.NewResponse(&gitchatv1.ListCommitsResponse{
		Commits: commits,
		HasMore: hasMore,
	}), nil
}

func (s *Service) GetDiff(
	ctx context.Context,
	req *connect.Request[gitchatv1.GetDiffRequest],
) (*connect.Response[gitchatv1.GetDiffResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	diff, fromSHA, toSHA, empty, files, err := entry.GetDiff(ctx, req.Msg.FromRef, req.Msg.ToRef, req.Msg.Path, req.Msg.DetectRenames)
	if err != nil {
		return nil, mapErr(err)
	}
	return connect.NewResponse(&gitchatv1.GetDiffResponse{
		UnifiedDiff: diff,
		FromCommit:  fromSHA,
		ToCommit:    toSHA,
		Empty:       empty,
		Files:       files,
	}), nil
}

func (s *Service) GetStatus(
	ctx context.Context,
	req *connect.Request[gitchatv1.GetStatusRequest],
) (*connect.Response[gitchatv1.GetStatusResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	staged, unstaged, untracked, err := entry.GetStatus(ctx)
	if err != nil {
		return nil, mapErr(err)
	}
	return connect.NewResponse(&gitchatv1.GetStatusResponse{
		Staged:    staged,
		Unstaged:  unstaged,
		Untracked: untracked,
	}), nil
}

func (s *Service) GetWorkingTreeDiff(
	_ context.Context,
	req *connect.Request[gitchatv1.GetWorkingTreeDiffRequest],
) (*connect.Response[gitchatv1.GetWorkingTreeDiffResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	diff, empty, err := entry.GetWorkingTreeDiff(req.Msg.Path)
	if err != nil {
		return nil, mapErr(err)
	}
	return connect.NewResponse(&gitchatv1.GetWorkingTreeDiffResponse{
		UnifiedDiff: diff,
		Empty:       empty,
	}), nil
}

func (s *Service) GetFileChurnMap(
	ctx context.Context,
	req *connect.Request[gitchatv1.GetFileChurnMapRequest],
) (*connect.Response[gitchatv1.GetFileChurnMapResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	result, err := entry.GetFileChurnMap(ctx, req.Msg.Ref, req.Msg.SinceTimestamp, req.Msg.UntilTimestamp, int(req.Msg.MaxCommits))
	if err != nil {
		return nil, mapErr(err)
	}
	// Outer bounds for the client's time-range controls. Non-fatal: if
	// this fails we just return 0/0 and the client falls back to the
	// window it can infer from file.last_modified.
	first, last, _ := entry.GetCommitTimeRange(ctx, req.Msg.Ref)
	return connect.NewResponse(&gitchatv1.GetFileChurnMapResponse{
		Files:                   result.Files,
		FirstCommitTimestamp:    first,
		LastCommitTimestamp:     last,
		CommitsScanned:          result.CommitsScanned,
		CapReached:              result.CapReached,
		MaxCommitsScanned:       result.MaxCommitsScanned,
		EffectiveSinceTimestamp: result.EffectiveSinceTimestamp,
	}), nil
}

func (s *Service) GetConfig(
	ctx context.Context,
	_ *connect.Request[gitchatv1.GetConfigRequest],
) (*connect.Response[gitchatv1.GetConfigResponse], error) {
	entries := s.Config.All(ctx)
	return connect.NewResponse(&gitchatv1.GetConfigResponse{Entries: entries}), nil
}

func (s *Service) UpdateConfig(
	ctx context.Context,
	req *connect.Request[gitchatv1.UpdateConfigRequest],
) (*connect.Response[gitchatv1.UpdateConfigResponse], error) {
	if req.Msg.Key == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("key is required"))
	}
	// Restricted keys (API keys, base URLs, webhooks) can only be
	// changed by the local principal to prevent multi-user escalation.
	if s.Config.IsRestricted(req.Msg.Key) {
		principal, _, ok := auth.PrincipalFromContext(ctx)
		if !ok || principal != "local" {
			return nil, connect.NewError(connect.CodePermissionDenied,
				fmt.Errorf("key %q can only be changed by the server operator", req.Msg.Key))
		}
	}
	if err := s.Config.Set(ctx, req.Msg.Key, req.Msg.Value); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&gitchatv1.UpdateConfigResponse{}), nil
}

// ─── Provider Catalog ─────────────────────────────────────────────────

func (s *Service) GetProviderCatalog(
	ctx context.Context,
	_ *connect.Request[gitchatv1.GetProviderCatalogRequest],
) (*connect.Response[gitchatv1.GetProviderCatalogResponse], error) {
	var providers []*gitchatv1.CatalogProvider
	if s.Catalog != nil {
		providers = s.Catalog.Get(ctx)
	}
	return connect.NewResponse(&gitchatv1.GetProviderCatalogResponse{
		Providers: providers,
	}), nil
}

func (s *Service) RefreshProviderCatalog(
	ctx context.Context,
	_ *connect.Request[gitchatv1.RefreshProviderCatalogRequest],
) (*connect.Response[gitchatv1.GetProviderCatalogResponse], error) {
	if s.Catalog == nil {
		return connect.NewResponse(&gitchatv1.GetProviderCatalogResponse{}), nil
	}
	providers, err := s.Catalog.Refresh(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal,
			fmt.Errorf("fetch catalog from catwalk.charm.sh: %w", err))
	}
	return connect.NewResponse(&gitchatv1.GetProviderCatalogResponse{
		Providers: providers,
	}), nil
}

// ─── Model Discovery ──────────────────────────────────────────────────

func (s *Service) DiscoverModels(
	ctx context.Context,
	req *connect.Request[gitchatv1.DiscoverModelsRequest],
) (*connect.Response[gitchatv1.DiscoverModelsResponse], error) {
	ids, err := DiscoverModels(ctx, req.Msg.BaseUrl, req.Msg.ApiKey)
	if err != nil {
		return connect.NewResponse(&gitchatv1.DiscoverModelsResponse{
			Error: err.Error(),
		}), nil
	}
	// Try to resolve provider name from catalog.
	providerName := ""
	if s.Catalog != nil {
		for _, p := range s.Catalog.Get(ctx) {
			if p.DefaultBaseUrl != "" && req.Msg.BaseUrl == p.DefaultBaseUrl {
				providerName = p.Name
				break
			}
		}
	}
	return connect.NewResponse(&gitchatv1.DiscoverModelsResponse{
		ModelIds:     ids,
		ProviderName: providerName,
	}), nil
}

// ─── Local Discovery ──────────────────────────────────────────────────

func (s *Service) DiscoverLocalEndpoints(
	ctx context.Context,
	_ *connect.Request[gitchatv1.DiscoverLocalEndpointsRequest],
) (*connect.Response[gitchatv1.DiscoverLocalEndpointsResponse], error) {
	endpoints := DiscoverLocal(ctx)
	return connect.NewResponse(&gitchatv1.DiscoverLocalEndpointsResponse{
		Endpoints: endpoints,
	}), nil
}

// ─── LLM Profiles ─────────────────────────────────────────────────────

func (s *Service) ListProfiles(
	ctx context.Context,
	_ *connect.Request[gitchatv1.ListProfilesRequest],
) (*connect.Response[gitchatv1.ListProfilesResponse], error) {
	profiles, err := s.DB.ListProfiles(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := make([]*gitchatv1.LLMProfile, 0, len(profiles))
	for _, p := range profiles {
		apiKey := p.APIKey
		// Decrypt then mask for display.
		if plain, err := s.Config.DecryptSecret(apiKey); err == nil {
			apiKey = plain
		}
		masked := ""
		if apiKey != "" {
			masked = "••••••••"
		}
		out = append(out, &gitchatv1.LLMProfile{
			Id:           p.ID,
			Name:         p.Name,
			Backend:      p.Backend,
			BaseUrl:      p.BaseURL,
			Model:        p.Model,
			ApiKey:       masked,
			Temperature:  p.Temperature,
			MaxTokens:    p.MaxTokens,
			SystemPrompt: p.SystemPrompt,
		})
	}
	activeID := s.Config.GetCtx(ctx, "LLM_ACTIVE_PROFILE")
	return connect.NewResponse(&gitchatv1.ListProfilesResponse{
		Profiles:        out,
		ActiveProfileId: activeID,
	}), nil
}

func (s *Service) SaveProfile(
	ctx context.Context,
	req *connect.Request[gitchatv1.SaveProfileRequest],
) (*connect.Response[gitchatv1.SaveProfileResponse], error) {
	// Restricted to local principal.
	principal, _, ok := auth.PrincipalFromContext(ctx)
	if !ok || principal != "local" {
		return nil, connect.NewError(connect.CodePermissionDenied,
			errors.New("profiles can only be managed by the server operator"))
	}
	p := req.Msg.Profile
	if p == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("profile is required"))
	}
	if p.Name == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name is required"))
	}
	id := p.Id
	if id == "" {
		b := make([]byte, 16)
		// crypto/rand.Read failing would mean the kernel CSPRNG is
		// unavailable — extremely rare (e.g. broken minimal container).
		// Returning rather than silently using a zero-byte ID prevents
		// all-zero profile IDs from landing in the DB.
		if _, err := rand.Read(b); err != nil {
			return nil, connect.NewError(connect.CodeInternal,
				fmt.Errorf("generate profile id: %w", err))
		}
		id = hex.EncodeToString(b)
	}
	// Encrypt API key before storage.
	apiKey := p.ApiKey
	// Don't overwrite with masked placeholder on edit of existing profile.
	if apiKey == "••••••••" && p.Id != "" {
		// Load existing key from DB.
		existing, err := s.DB.GetProfile(ctx, id)
		if err == nil {
			apiKey = existing.APIKey // already encrypted
		} else {
			apiKey = ""
		}
	} else if apiKey != "" {
		enc, err := s.Config.EncryptSecret(apiKey)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("encrypt api key: %w", err))
		}
		apiKey = enc
	}
	if err := s.DB.SaveProfile(ctx, storage.LLMProfile{
		ID:           id,
		Name:         p.Name,
		Backend:      p.Backend,
		BaseURL:      p.BaseUrl,
		Model:        p.Model,
		APIKey:       apiKey,
		Temperature:  p.Temperature,
		MaxTokens:    p.MaxTokens,
		SystemPrompt: p.SystemPrompt,
	}); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&gitchatv1.SaveProfileResponse{Id: id}), nil
}

func (s *Service) DeleteProfile(
	ctx context.Context,
	req *connect.Request[gitchatv1.DeleteProfileRequest],
) (*connect.Response[gitchatv1.DeleteProfileResponse], error) {
	principal, _, ok := auth.PrincipalFromContext(ctx)
	if !ok || principal != "local" {
		return nil, connect.NewError(connect.CodePermissionDenied,
			errors.New("profiles can only be managed by the server operator"))
	}
	if err := s.DB.DeleteProfile(ctx, req.Msg.Id); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	// If the deleted profile was active, clear the active profile.
	// A DB failure here leaves LLM_ACTIVE_PROFILE pointing at a deleted
	// ID — every subsequent turn then fails at resolve time with no
	// visible cause. Propagate to the caller so the UI can re-sync.
	if active := s.Config.GetCtx(ctx, "LLM_ACTIVE_PROFILE"); active == req.Msg.Id {
		if err := s.Config.Set(ctx, "LLM_ACTIVE_PROFILE", ""); err != nil {
			return nil, connect.NewError(connect.CodeInternal,
				fmt.Errorf("clear active profile after delete: %w", err))
		}
	}
	return connect.NewResponse(&gitchatv1.DeleteProfileResponse{}), nil
}

func (s *Service) ActivateProfile(
	ctx context.Context,
	req *connect.Request[gitchatv1.ActivateProfileRequest],
) (*connect.Response[gitchatv1.ActivateProfileResponse], error) {
	principal, _, ok := auth.PrincipalFromContext(ctx)
	if !ok || principal != "local" {
		return nil, connect.NewError(connect.CodePermissionDenied,
			errors.New("profiles can only be managed by the server operator"))
	}
	// Allow deactivation (empty ID = use individual LLM_* settings).
	if req.Msg.Id == "" {
		if err := s.Config.Set(ctx, "LLM_ACTIVE_PROFILE", ""); err != nil {
			return nil, connect.NewError(connect.CodeInternal,
				fmt.Errorf("deactivate profile: %w", err))
		}
		return connect.NewResponse(&gitchatv1.ActivateProfileResponse{}), nil
	}
	p, err := s.DB.GetProfile(ctx, req.Msg.Id)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	// Decrypt the API key to write it into the config override.
	apiKey := p.APIKey
	if plain, err := s.Config.DecryptSecret(apiKey); err == nil {
		apiKey = plain
	}
	// Write profile values into config overrides atomically.
	if err := s.Config.SetBatch(ctx, map[string]string{
		"LLM_BACKEND":        p.Backend,
		"LLM_BASE_URL":       p.BaseURL,
		"LLM_MODEL":          p.Model,
		"LLM_API_KEY":        apiKey,
		"LLM_TEMPERATURE":    p.Temperature,
		"LLM_MAX_TOKENS":     p.MaxTokens,
		"LLM_SYSTEM_PROMPT":  p.SystemPrompt,
		"LLM_ACTIVE_PROFILE": req.Msg.Id,
	}); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&gitchatv1.ActivateProfileResponse{}), nil
}

func (s *Service) lookup(id string) *Entry {
	return s.Registry.Get(id)
}

func mapErr(err error) error {
	if errors.Is(err, ErrNotFound) {
		return connect.NewError(connect.CodeNotFound, err)
	}
	return connect.NewError(connect.CodeInternal, err)
}
