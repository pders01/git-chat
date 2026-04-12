package repo

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/gen/go/gitchat/v1/gitchatv1connect"
)

// Service implements gitchat.v1.RepoService backed by a Registry.
//
// Authentication is enforced at the transport layer via
// auth.RequireAuth() as a Connect interceptor, so these handlers can
// assume the caller is authenticated.
type Service struct {
	gitchatv1connect.UnimplementedRepoServiceHandler
	Registry *Registry
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
	_ context.Context,
	req *connect.Request[gitchatv1.ListBranchesRequest],
) (*connect.Response[gitchatv1.ListBranchesResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	branches, err := entry.ListBranches()
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&gitchatv1.ListBranchesResponse{Branches: branches}), nil
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
	_ context.Context,
	req *connect.Request[gitchatv1.GetBlameRequest],
) (*connect.Response[gitchatv1.GetBlameResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	lines, err := entry.GetBlame(req.Msg.Ref, req.Msg.Path)
	if err != nil {
		return nil, mapErr(err)
	}
	return connect.NewResponse(&gitchatv1.GetBlameResponse{Lines: lines}), nil
}

func (s *Service) CompareBranches(
	_ context.Context,
	req *connect.Request[gitchatv1.CompareBranchesRequest],
) (*connect.Response[gitchatv1.CompareBranchesResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	files, totalAdd, totalDel, err := entry.CompareBranches(req.Msg.BaseRef, req.Msg.HeadRef)
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
	_ context.Context,
	req *connect.Request[gitchatv1.ListCommitsRequest],
) (*connect.Response[gitchatv1.ListCommitsResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	commits, hasMore, err := entry.ListCommits(req.Msg.Ref, int(req.Msg.Limit), int(req.Msg.Offset))
	if err != nil {
		return nil, mapErr(err)
	}
	return connect.NewResponse(&gitchatv1.ListCommitsResponse{
		Commits: commits,
		HasMore: hasMore,
	}), nil
}

func (s *Service) GetDiff(
	_ context.Context,
	req *connect.Request[gitchatv1.GetDiffRequest],
) (*connect.Response[gitchatv1.GetDiffResponse], error) {
	entry := s.lookup(req.Msg.RepoId)
	if entry == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("repo not found"))
	}
	diff, fromSHA, toSHA, empty, files, err := entry.GetDiff(req.Msg.FromRef, req.Msg.ToRef, req.Msg.Path)
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

func (s *Service) lookup(id string) *Entry {
	return s.Registry.Get(id)
}

func mapErr(err error) error {
	if errors.Is(err, ErrNotFound) {
		return connect.NewError(connect.CodeNotFound, err)
	}
	return connect.NewError(connect.CodeInternal, err)
}
