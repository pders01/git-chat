package repo

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// Compiled-in fallbacks for tunables whose canonical source is the
// config Registry (DB override → env → registered default → here).
// The Registry path honours live UI edits; these constants only apply
// if no Registry was wired in or the key isn't registered.
const (
	defaultMaxFileBytesFallback      int64 = 512 * 1024
	defaultMaxDiffBytesFallback            = 512 * 1024
	defaultCommitLimitFallback             = 50
	defaultDiffContextLinesFallback        = 3
	defaultMaxChurnCommitsFallback         = 5000
	defaultChurnWindowDaysFallback         = 90
)

// errPathEscape is returned when a caller-supplied path would escape the
// repository root after cleaning.
var errPathEscape = errors.New("path escapes repository boundary")

// SafePath validates that a relative path does not escape the repo root.
// Returns the cleaned path or an error.
func SafePath(p string) (string, error) {
	clean := filepath.Clean(p)
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errPathEscape
	}
	return clean, nil
}

// ListBranches returns local branches sorted by committer time, newest first.
func (e *Entry) ListBranches(ctx context.Context) ([]*gitchatv1.Branch, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if out, err := gitListBranches(ctx, e.Path, "refs/heads"); err == nil {
		return out, nil
	}

	// Fallback: go-git. Much slower on large repos because each branch
	// triggers a packfile commit lookup to populate committer time +
	// subject — but keeps the RPC working without the git binary.
	iter, err := e.repo.Branches()
	if err != nil {
		return nil, fmt.Errorf("iterate branches: %w", err)
	}
	var out []*gitchatv1.Branch
	err = iter.ForEach(func(ref *plumbing.Reference) error {
		commit, err := e.repo.CommitObject(ref.Hash())
		if err != nil {
			return nil
		}
		out = append(out, &gitchatv1.Branch{
			Name:          ref.Name().Short(),
			Commit:        ref.Hash().String(),
			CommitterTime: commit.Committer.When.Unix(),
			Subject:       firstLine(commit.Message),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CommitterTime > out[j].CommitterTime
	})
	return out, nil
}

// ListTags returns all tags in the repository, sorted by tagger time
// (most-recent first). Tags are returned as Branch messages for
// wire-compatibility — name holds the tag name, Commit the target SHA,
// CommitterTime the tagger timestamp, and Subject the tag message.
func (e *Entry) ListTags(ctx context.Context) ([]*gitchatv1.Branch, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if out, err := gitListBranches(ctx, e.Path, "refs/tags"); err == nil {
		return out, nil
	}

	// Fallback: go-git. Annotated vs lightweight tag resolution is done
	// via two different object lookups, same data the `for-each-ref`
	// subprocess produces in one shot above.
	iter, err := e.repo.Tags()
	if err != nil {
		return nil, fmt.Errorf("iterate tags: %w", err)
	}
	var out []*gitchatv1.Branch
	err = iter.ForEach(func(ref *plumbing.Reference) error {
		tag := &gitchatv1.Branch{
			Name:   ref.Name().Short(),
			Commit: ref.Hash().String(),
		}
		// Try to resolve as annotated tag first.
		if tagObj, err := e.repo.TagObject(ref.Hash()); err == nil {
			tag.CommitterTime = tagObj.Tagger.When.Unix()
			tag.Subject = firstLine(tagObj.Message)
			// Resolve to the commit it points to.
			if commit, err := tagObj.Commit(); err == nil {
				tag.Commit = commit.Hash.String()
			}
		} else if commit, err := e.repo.CommitObject(ref.Hash()); err == nil {
			// Lightweight tag pointing directly to a commit.
			tag.CommitterTime = commit.Committer.When.Unix()
			tag.Subject = firstLine(commit.Message)
		}
		out = append(out, tag)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CommitterTime > out[j].CommitterTime
	})
	return out, nil
}

// ListTree returns entries at a path under a given ref. Empty path lists
// the repository root. Empty ref uses the default branch.
func (e *Entry) ListTree(ref, path string) ([]*gitchatv1.TreeEntry, string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	commit, resolved, err := e.resolveCommit(ref)
	if err != nil {
		return nil, "", err
	}
	tree, err := commit.Tree()
	if err != nil {
		return nil, "", fmt.Errorf("get tree: %w", err)
	}

	var target *object.Tree
	if path == "" || path == "." || path == "/" {
		target = tree
	} else {
		sub, err := tree.Tree(path)
		if err != nil {
			if errors.Is(err, object.ErrDirectoryNotFound) {
				return nil, "", ErrNotFound
			}
			return nil, "", fmt.Errorf("locate %q: %w", path, err)
		}
		target = sub
	}

	out := make([]*gitchatv1.TreeEntry, 0, len(target.Entries))
	for _, entry := range target.Entries {
		te := &gitchatv1.TreeEntry{
			Name:    entry.Name,
			Type:    entryType(entry.Mode),
			BlobSha: entry.Hash.String(),
		}
		if te.Type == gitchatv1.EntryType_ENTRY_TYPE_FILE {
			// Size is only cheaply available for blobs; fetch it from the
			// object store. On failure we leave Size=0.
			if blob, err := e.repo.BlobObject(entry.Hash); err == nil {
				te.Size = blob.Size
			}
		}
		out = append(out, te)
	}

	sort.Slice(out, func(i, j int) bool {
		// Directories first, then files, alphabetical within each group.
		ai, bi := out[i], out[j]
		if (ai.Type == gitchatv1.EntryType_ENTRY_TYPE_DIR) != (bi.Type == gitchatv1.EntryType_ENTRY_TYPE_DIR) {
			return ai.Type == gitchatv1.EntryType_ENTRY_TYPE_DIR
		}
		return ai.Name < bi.Name
	})
	return out, resolved, nil
}

// AllFilePaths returns every blob path at HEAD, sorted. Used by the
// chat prompt's "did you mean …?" hint when a user's @-mention misses.
// Not indexed — callers should only invoke this on the slow path (when
// there's already a miss to explain).
func (e *Entry) AllFilePaths() ([]string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	commit, _, err := e.resolveCommit("")
	if err != nil {
		return nil, err
	}
	tree, err := commit.Tree()
	if err != nil {
		return nil, fmt.Errorf("get tree: %w", err)
	}
	iter := tree.Files()
	var out []string
	err = iter.ForEach(func(f *object.File) error {
		out = append(out, f.Name)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

// GetFile returns the blob contents at path under ref.
func (e *Entry) GetFile(ref, path string, maxBytes int64) (*gitchatv1.GetFileResponse, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if maxBytes <= 0 {
		// GetFile's public signature has no ctx; Registry's own DB lookup
		// is timeout-guarded so Background is safe here.
		maxBytes = e.cfgInt64(context.Background(), "GITCHAT_DEFAULT_FILE_BYTES", defaultMaxFileBytesFallback)
	}
	commit, _, err := e.resolveCommit(ref)
	if err != nil {
		return nil, err
	}
	tree, err := commit.Tree()
	if err != nil {
		return nil, fmt.Errorf("get tree: %w", err)
	}
	file, err := tree.File(path)
	if err != nil {
		if errors.Is(err, object.ErrFileNotFound) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("find file: %w", err)
	}

	reader, err := file.Reader()
	if err != nil {
		return nil, fmt.Errorf("open blob: %w", err)
	}
	defer reader.Close()

	buf := make([]byte, maxBytes+1)
	n, err := io.ReadFull(reader, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("read blob: %w", err)
	}
	content := buf[:min64(int64(n), maxBytes)]
	truncated := int64(n) > maxBytes || file.Size > maxBytes

	return &gitchatv1.GetFileResponse{
		Content:   append([]byte(nil), content...), // defensive copy
		Size:      file.Size,
		Truncated: truncated,
		IsBinary:  isBinary(content),
		BlobSha:   file.Hash.String(),
		Language:  LanguageForPath(path),
	}, nil
}

// maxWholeDiffBytes caps the total size of a whole-commit diff. Large
// commits get truncated with a "(N more files truncated)" notice so
// the LLM can still reason about the start of the patch without
// blowing its context window. Configured via GITCHAT_MAX_DIFF_BYTES.

// ListCommits returns the most recent commits on a ref, newest first.
// Includes diff stats (files changed, additions, deletions) per commit.
// When pathFilter is non-empty, only commits that touched that file are
// included (the offset/limit still apply to the filtered result set).
//
// Primary path shells out to `git log --numstat`: one subprocess fills
// every field the UI needs (metadata + per-file add/delete counts) in
// native speed, replacing a go-git loop that called Tree.Diff + Patch
// per commit and cost ~1.4s for the default 50-commit page on Koha.
// Falls back to the go-git walk when the exec fails.
func (e *Entry) ListCommits(ctx context.Context, ref string, limit, offset int, pathFilter string) ([]*gitchatv1.CommitEntry, bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if limit <= 0 {
		limit = e.cfgInt(ctx, "GITCHAT_DEFAULT_COMMIT_LIMIT", defaultCommitLimitFallback)
	}
	// Cap limit to prevent memory issues on large repos
	if limit > 200 {
		limit = 200
	}
	// Cap offset for performance
	if offset > 10000 {
		offset = 10000
	}

	commits, hasMore, gitErr := gitLogCommits(ctx, e.Path, ref, limit, offset, pathFilter)
	if gitErr == nil {
		return commits, hasMore, nil
	}

	// ── Fallback: go-git walk ──────────────────────────────────────
	commit, _, err := e.resolveCommit(ref)
	if err != nil {
		return nil, false, err
	}

	// Walk the commit history.
	iter := object.NewCommitIterCTime(commit, nil, nil)
	defer iter.Close()

	// Walk history until we've collected `limit` matching commits or
	// the iterator runs dry. The previous `maxProcess = offset + limit*3`
	// guard silently truncated with pathFilter when matching commits were
	// sparse (e.g. a rarely-touched file) — it returned fewer than `limit`
	// rows AND reported has_more=false, so the UI thought history ended.
	// The primary path (git log -- path) paginates correctly in git, and
	// this fallback now matches that contract.
	skipped := 0
	var out []*gitchatv1.CommitEntry
	for {
		c, err := iter.Next()
		if err != nil {
			break
		}

		// Path filter: skip commits that didn't touch the file.
		if pathFilter != "" && !commitTouchedPath(c, pathFilter) {
			continue
		}

		// Skip `offset` matching commits.
		if skipped < offset {
			skipped++
			continue
		}

		if len(out) == limit {
			// One extra to detect has_more.
			return out, true, nil
		}

		parents := make([]string, c.NumParents())
		for pi := range parents {
			parents[pi] = c.ParentHashes[pi].String()
		}
		entry := &gitchatv1.CommitEntry{
			Sha:         c.Hash.String(),
			ShortSha:    ShortSHA(c.Hash.String()),
			Message:     firstLine(c.Message),
			Body:        commitBody(c.Message),
			AuthorName:  c.Author.Name,
			AuthorEmail: c.Author.Email,
			AuthorTime:  c.Author.When.Unix(),
			ParentShas:  parents,
		}
		// Diff stats — compare against first parent (root commits
		// show as all-additions).
		if stats := commitDiffStats(ctx, c); stats != nil {
			entry.FilesChanged = int32(stats.files)
			entry.Additions = int32(stats.additions)
			entry.Deletions = int32(stats.deletions)
		}
		out = append(out, entry)
	}
	return out, false, nil
}

// commitTouchedPath returns true if the commit changed the file at path
// compared to its first parent (or if it's a root commit containing
// the path).
func commitTouchedPath(c *object.Commit, path string) bool {
	cTree, err := c.Tree()
	if err != nil {
		return false
	}

	// Get file at path in this commit's tree.
	cFile, cErr := cTree.File(path)

	if c.NumParents() == 0 {
		// Root commit: file is touched if it exists.
		return cErr == nil
	}

	parent, err := c.Parents().Next()
	if err != nil {
		return false
	}
	pTree, err := parent.Tree()
	if err != nil {
		return cErr == nil // parent broken, consider touched if file exists
	}

	pFile, pErr := pTree.File(path)

	// File added (not in parent) or deleted (not in child).
	if cErr != nil && pErr != nil {
		return false // doesn't exist in either
	}
	if cErr != nil || pErr != nil {
		return true // added or deleted
	}
	// Both exist: compare hashes.
	return cFile.Hash != pFile.Hash
}

type diffStats struct {
	files, additions, deletions int
}

func commitDiffStats(ctx context.Context, c *object.Commit) *diffStats {
	cTree, err := c.Tree()
	if err != nil {
		return nil
	}
	var pTree *object.Tree
	if c.NumParents() > 0 {
		parent, err := c.Parents().Next()
		if err == nil {
			pTree, _ = parent.Tree()
		}
	}
	if pTree == nil {
		// Root commit: count files and estimate lines from size to avoid
		// reading entire blob contents for every file.
		var files, lines int
		cTree.Files().ForEach(func(f *object.File) error {
			files++
			lines += int(f.Size) / 40 // rough estimate: ~40 bytes/line
			return nil
		})
		return &diffStats{files: files, additions: lines}
	}
	// Rename detection off: for per-commit +/- counts in the log sidebar,
	// users don't need renames coalesced — and the similarity-matrix cost
	// dominated ListCommits (~2s for 50 commits on Koha). A renamed file
	// now shows up as a delete of the original + an add of the new, with
	// inflated counts; acceptable for a compact summary.
	changes, err := diffTrees(ctx, pTree, cTree)
	if err != nil {
		return nil
	}
	patch, err := changes.Patch()
	if err != nil {
		return nil
	}
	stats := patch.Stats()
	s := &diffStats{files: len(stats)}
	for _, st := range stats {
		s.additions += st.Addition
		s.deletions += st.Deletion
	}
	return s
}

// GetFileChurnMap returns per-file commit counts, additions, deletions,
// last modified timestamp, and file size over a time window [since, until].
// If both since and until are 0 the entire history is walked.
//
// Primary path is a single `git log --numstat` subprocess that replaces
// the ~5000 Tree.Diff + Patch calls go-git made per page (~1.3s on Koha).
// Falls back to the go-git walk on exec error.
// ChurnMapResult bundles a churn map with metadata about the scan so
// callers can tell whether the server's per-request cap was hit and
// the sums represent a partial walk of the requested window.
type ChurnMapResult struct {
	Files                   []*gitchatv1.FileChurn
	CommitsScanned          int32
	CapReached              bool
	MaxCommitsScanned       int32
	EffectiveSinceTimestamp int64
}

// churnHardCap bounds the commit scan even when a client explicitly
// opts out of the default cap via MaxCommits. Keeps a misbehaving
// client from asking for a trillion commits and locking up the repo.
const churnHardCap = 500000

// churnCacheCap bounds how many (tipSHA, since, until, maxCommits)
// churn map results we keep per-Entry. Each entry holds the full file
// list (tens of thousands of FileChurn records for a deep scan), so
// this stays small — we're trading memory for "instant second click
// on the same query". Same random-half-drop eviction as blameCache:
// cheap, effectively LRU-ish for bursty browsing.
const churnCacheCap = 32

// churnCacheKey composes the cache lookup string. Tip SHA ensures the
// cache invalidates naturally when the repo's HEAD moves; the other
// three bound the data subset. since==0 + until==0 + maxCommits==0 is
// the "server default" — distinct key from an explicit zero window.
func churnCacheKey(tipSHA string, since, until int64, maxCommits int) string {
	return fmt.Sprintf("%s|%d|%d|%d", tipSHA, since, until, maxCommits)
}

// churnAcc accumulates per-path churn numbers during a single call.
// Hoisted out of GetFileChurnMap so the subprocess and go-git paths
// can share the type without nesting. authors tracks the commit count
// per author for this file; the top-by-count author is surfaced as
// top_author in the proto response. Left nil by the go-git fallback
// because author lookup there would cost an extra object read per commit.
type churnAcc struct {
	commits   int
	additions int64
	deletions int64
	lastMod   int64
	authors   map[string]int
}

func (a *churnAcc) recordAuthor(name string) {
	if name == "" {
		return
	}
	if a.authors == nil {
		a.authors = make(map[string]int, 2)
	}
	a.authors[name]++
}

func (a *churnAcc) topAuthor() string {
	var best string
	var bestCount int
	for name, n := range a.authors {
		if n > bestCount || (n == bestCount && name < best) {
			best = name
			bestCount = n
		}
	}
	return best
}

func (e *Entry) GetFileChurnMap(ctx context.Context, ref string, since, until int64, maxCommitsOverride int) (*ChurnMapResult, error) {
	// Apply sensible defaults for large repos to avoid walking entire history.
	// cfgInt goes to SQLite/env — unrelated to go-git, so no lock needed.
	if since == 0 && until == 0 {
		until = time.Now().Unix()
		since = until - int64(e.cfgInt(ctx, "GITCHAT_CHURN_WINDOW_DAYS", defaultChurnWindowDaysFallback)*24*3600)
	}

	// Resolve the effective cap: 0 = server default; non-zero = client
	// override clamped to churnHardCap. Kept separate from the package
	// var so tests and the default path aren't disturbed.
	effCap := e.cfgInt(ctx, "GITCHAT_MAX_CHURN_COMMITS", defaultMaxChurnCommitsFallback)
	if maxCommitsOverride > 0 {
		effCap = maxCommitsOverride
		if effCap > churnHardCap {
			effCap = churnHardCap
		}
	}

	// Phase 1 — resolve tip under mu (go-git access).
	e.mu.Lock()
	_, resolvedTip, err := e.resolveCommit(ref)
	e.mu.Unlock()
	if err != nil {
		return nil, err
	}

	// Phase 2 — cache lookup under cacheMu (parallel readers). Tip-SHA-keyed,
	// so refs that haven't moved return instantly.
	cacheKey := churnCacheKey(resolvedTip, since, until, effCap)
	e.cacheMu.RLock()
	cached, hit := e.churnCache[cacheKey]
	e.cacheMu.RUnlock()
	if hit {
		return cached.(*ChurnMapResult), nil
	}

	m := map[string]*churnAcc{}
	var commitsScanned int
	var capReached bool
	// Smallest author timestamp seen during the scan. Becomes the
	// "effective since" we hand back to the client so its slider can
	// anchor at the true boundary of the returned data instead of the
	// user-requested since, which the cap may have silently narrowed.
	var oldestScannedTs int64

	// Phase 3 — subprocess scan with no locks held.
	//
	// Request cap+1 so we can disambiguate "exactly cap commits in the
	// window" (complete data) from "more than cap, we truncated"
	// (partial data). If git returns cap+1, flag the cap and drop the
	// extra entry before processing.
	entries, gitErr := gitLogChurn(ctx, e.Path, ref, since, until, effCap+1)
	if gitErr == nil {
		if len(entries) > effCap {
			capReached = true
			entries = entries[:effCap]
		}
		commitsScanned = len(entries)
		for _, entry := range entries {
			ts := entry.authorTime
			if ts > 0 && (oldestScannedTs == 0 || ts < oldestScannedTs) {
				oldestScannedTs = ts
			}
			for _, row := range entry.rows {
				acc, ok := m[row.path]
				if !ok {
					acc = &churnAcc{}
					m[row.path] = acc
				}
				acc.commits++
				if row.adds > 0 {
					acc.additions += row.adds
				}
				if row.dels > 0 {
					acc.deletions += row.dels
				}
				if ts > acc.lastMod {
					acc.lastMod = ts
				}
				acc.recordAuthor(entry.authorName)
			}
		}
	} else {
		// Phase 3b — go-git fallback. Stays under mu for the whole walk
		// since every iter/diff call touches packfile internals.
		if err := e.churnWalkGoGit(resolvedTip, since, until, effCap, m, &commitsScanned, &capReached, &oldestScannedTs); err != nil {
			return nil, err
		}
	}

	// Phase 4 — file sizes: subprocess first (no lock), go-git fallback under mu.
	sizeMap, sizeErr := gitLsTreeSizes(ctx, e.Path, ref)
	if sizeErr != nil {
		sizeMap, err = e.sizeMapGoGit(resolvedTip)
		if err != nil {
			return nil, err
		}
	}

	// Phase 5 — merge + sort (pure, no lock).
	out := make([]*gitchatv1.FileChurn, 0, len(m))
	for path, acc := range m {
		out = append(out, &gitchatv1.FileChurn{
			Path:           path,
			CommitCount:    int32(acc.commits),
			TotalAdditions: acc.additions,
			TotalDeletions: acc.deletions,
			LastModified:   acc.lastMod,
			Size:           sizeMap[path],
			TopAuthor:      acc.topAuthor(),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CommitCount != out[j].CommitCount {
			return out[i].CommitCount > out[j].CommitCount
		}
		return out[i].Path < out[j].Path
	})

	result := &ChurnMapResult{
		Files:                   out,
		CommitsScanned:          int32(commitsScanned),
		CapReached:              capReached,
		MaxCommitsScanned:       int32(effCap),
		EffectiveSinceTimestamp: oldestScannedTs,
	}

	// Phase 6 — cache store under cacheMu. Half-drop random entries when
	// full — matches blameCache's eviction style.
	e.cacheMu.Lock()
	if e.churnCache == nil {
		e.churnCache = make(map[string]any, churnCacheCap)
	}
	if len(e.churnCache) >= churnCacheCap {
		drop := churnCacheCap / 2
		for k := range e.churnCache {
			delete(e.churnCache, k)
			drop--
			if drop <= 0 {
				break
			}
		}
	}
	e.churnCache[cacheKey] = result
	e.cacheMu.Unlock()

	return result, nil
}

// churnWalkGoGit walks commits via go-git and accumulates into m. Holds
// e.mu for the entire walk because every iter/tree/diff call touches
// go-git internals. Only reached when the `git log --numstat` subprocess
// fails (e.g. missing git binary).
func (e *Entry) churnWalkGoGit(resolvedTip string, since, until int64, effCap int, m map[string]*churnAcc, commitsScanned *int, capReached *bool, oldestScannedTs *int64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	commit, cerr := e.repo.CommitObject(plumbing.NewHash(resolvedTip))
	if cerr != nil {
		return fmt.Errorf("lookup commit %s: %w", resolvedTip, cerr)
	}
	filterTime := since > 0 || until > 0
	iter := object.NewCommitIterCTime(commit, nil, nil)
	defer iter.Close()

	commitsProcessed := 0
	for {
		c, err := iter.Next()
		if err != nil {
			break
		}
		commitsProcessed++
		// Walk one beyond the cap so we can distinguish "exactly cap
		// commits walked" from "more than cap walked" — same rationale
		// as the +1 in the primary path.
		if commitsProcessed > effCap {
			*capReached = true
			break
		}

		ts := c.Author.When.Unix()
		if filterTime {
			if since > 0 && ts < since {
				break
			}
			if until > 0 && ts > until {
				continue
			}
		}
		*commitsScanned++
		if ts > 0 && (*oldestScannedTs == 0 || ts < *oldestScannedTs) {
			*oldestScannedTs = ts
		}

		cTree, err := c.Tree()
		if err != nil {
			continue
		}
		var pTree *object.Tree
		if c.NumParents() > 0 {
			parent, perr := c.Parents().Next()
			if perr == nil {
				pTree, _ = parent.Tree()
			}
		}

		if pTree == nil {
			cTree.Files().ForEach(func(f *object.File) error {
				acc, ok := m[f.Name]
				if !ok {
					acc = &churnAcc{}
					m[f.Name] = acc
				}
				acc.commits++
				acc.additions += f.Size / 40
				if ts > acc.lastMod {
					acc.lastMod = ts
				}
				return nil
			})
			continue
		}

		changes, err := pTree.Diff(cTree)
		if err != nil {
			continue
		}
		patch, err := changes.Patch()
		if err != nil {
			continue
		}
		for _, st := range patch.Stats() {
			acc, ok := m[st.Name]
			if !ok {
				acc = &churnAcc{}
				m[st.Name] = acc
			}
			acc.commits++
			acc.additions += int64(st.Addition)
			acc.deletions += int64(st.Deletion)
			if ts > acc.lastMod {
				acc.lastMod = ts
			}
		}
	}
	return nil
}

// sizeMapGoGit collects blob sizes via go-git's tree walker. Slow (opens
// each blob header individually) but keeps churn working on hosts
// without the git binary.
func (e *Entry) sizeMapGoGit(resolvedTip string) (map[string]int64, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	commit, cerr := e.repo.CommitObject(plumbing.NewHash(resolvedTip))
	if cerr != nil {
		return nil, fmt.Errorf("lookup commit %s: %w", resolvedTip, cerr)
	}
	tree, terr := commit.Tree()
	if terr != nil {
		return nil, fmt.Errorf("get tree for sizes: %w", terr)
	}
	out := map[string]int64{}
	fileIter := tree.Files()
	defer fileIter.Close()
	for {
		f, ferr := fileIter.Next()
		if ferr != nil {
			break
		}
		out[f.Name] = f.Size
	}
	return out, nil
}

// GetCommitTimeRange returns the committer time of the ref's root
// commit (first) and tip commit (last). Used by the frontend's
// code-city time slider to show "all history" as the repo's true
// inception date rather than the oldest surviving file's last
// modification.
//
// Two cheap git calls:
//   - first: git log ref --max-parents=0 --format=%ct -1
//     (root commits; most repos have one, we take the oldest if several)
//   - last:  git log ref -1 --format=%ct
func (e *Entry) GetCommitTimeRange(ctx context.Context, ref string) (int64, int64, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	target := ref
	if target == "" {
		target = "HEAD"
	}
	// Tip commit time.
	tipOut, tipErr := (&gitCmd{
		repoDir: e.Path,
		args:    []string{"log", target, "-1", "--format=%ct"},
	}).run(ctx)
	if tipErr != nil {
		return 0, 0, tipErr
	}
	last, _ := strconv.ParseInt(strings.TrimSpace(string(tipOut)), 10, 64)
	// Root commit time. With --max-parents=0 we get all parentless
	// commits; take the smallest ct so merged-in unrelated histories
	// don't pick a later root.
	rootOut, rootErr := (&gitCmd{
		repoDir: e.Path,
		args:    []string{"log", target, "--max-parents=0", "--format=%ct"},
	}).run(ctx)
	if rootErr != nil {
		// Shallow clone / missing root / other failure: return
		// last as first so the client's slider spans a zero-width
		// range rather than from epoch 0. Better than signalling
		// "no root" with 0, which the client falls through to a
		// file.last_modified heuristic that defeats the feature.
		return last, last, nil
	}
	var first int64
	for _, line := range strings.Split(strings.TrimSpace(string(rootOut)), "\n") {
		v, perr := strconv.ParseInt(strings.TrimSpace(line), 10, 64)
		if perr != nil {
			continue
		}
		if first == 0 || v < first {
			first = v
		}
	}
	return first, last, nil
}

// CompareBranches returns the files changed between two refs with
// per-file add/delete stats. detectRenames runs the expensive
// similarity-matrix detection over all added+deleted blobs; callers
// typically send a first request with it false (fast) and a second
// request with it true (progressive enhancement).
func (e *Entry) CompareBranches(ctx context.Context, baseRef, headRef string, detectRenames bool) ([]*gitchatv1.ChangedFile, int32, int32, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	maxDiffBytes := e.cfgInt(ctx, "GITCHAT_MAX_DIFF_BYTES", defaultMaxDiffBytesFallback)
	baseCommit, _, err := e.resolveCommit(baseRef)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("resolve base: %w", err)
	}
	headCommit, _, err := e.resolveCommit(headRef)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("resolve head: %w", err)
	}
	baseTree, err := baseCommit.Tree()
	if err != nil {
		return nil, 0, 0, err
	}
	headTree, err := headCommit.Tree()
	if err != nil {
		return nil, 0, 0, err
	}
	changes, err := diffTrees(ctx, baseTree, headTree)
	if err != nil {
		return nil, 0, 0, err
	}
	// Cap changes for very large diffs BEFORE any rename detection. The
	// similarity matrix is O(adds × deletes) over blob reads — running it
	// on thousands of rows just to discard most of them was a real DoS
	// footgun when detect_renames=true came from the client. Stats are
	// computed via our own line-counter rather than go-git's Patch()
	// (see countDiffLines).
	maxChanges := 500
	if len(changes) > maxChanges {
		changes = changes[:maxChanges]
	}
	if detectRenames {
		if detected, derr := detectRenamesIn(changes); derr == nil {
			changes = detected
		}
		// If detection errored, fall through with the cheap changes; the
		// file list still renders, just without renames coalesced.
	}
	var totalAdd, totalDel int32
	out := make([]*gitchatv1.ChangedFile, 0, len(changes))
	for _, c := range changes {
		name := c.To.Name
		if name == "" {
			name = c.From.Name
		}
		status := "modified"
		fromPath := ""
		switch {
		case c.From.Name == "":
			status = "added"
		case c.To.Name == "":
			status = "deleted"
		case c.From.Name != c.To.Name:
			status = "renamed"
			fromPath = c.From.Name
		}
		fromContent, _ := fileContent(baseCommit, c.From.Name, maxDiffBytes)
		toContent, _ := fileContent(headCommit, c.To.Name, maxDiffBytes)
		adds, dels := countDiffLines(fromContent, toContent)
		out = append(out, &gitchatv1.ChangedFile{
			Path:      name,
			Status:    status,
			Additions: adds,
			Deletions: dels,
			FromPath:  fromPath,
		})
		totalAdd += adds
		totalDel += dels
	}
	return out, totalAdd, totalDel, nil
}

// blameCacheCap bounds how many (commit, path) blame results we keep
// per-Entry. Koha-scale blames are ~10-25s; one cache hit recovers that
// entirely, so even a modest cap pays for itself. When full, half the
// entries are dropped at random (map iteration order) — cheap,
// effectively LRU-ish for bursty browsing.
const blameCacheCap = 256

// GetBlame returns per-line author attribution for a file. Results are
// memoised per (commitSHA, path) because blame on a large-history file
// (Koha C4/*.pm at ~23s via go-git) dominates perceived latency and
// blame for a fixed commit never changes.
//
// Primary path shells out to `git blame --porcelain`: the C
// implementation is typically 5-10× faster than go-git on deep history.
// If the git binary is unavailable or the exec fails for any reason, we
// fall back to go-git's native blame — keeping functionality portable.
//
// ctx is threaded to the subprocess so a client cancel (or deadline)
// actually kills the git process instead of leaving it orphaned.
//
// Locking is phased (see Entry doc comment): mu held only for go-git
// access; the 23-second subprocess runs with no lock so other requests
// to the same repo parallelize.
func (e *Entry) GetBlame(ctx context.Context, ref, path string) ([]*gitchatv1.BlameLine, error) {
	// Phase 1 — resolve the ref under mu (go-git access).
	e.mu.Lock()
	_, resolved, err := e.resolveCommit(ref)
	e.mu.Unlock()
	if err != nil {
		return nil, err
	}

	// Phase 2 — cache lookup under cacheMu (parallel readers).
	key := resolved + "\x00" + path
	e.cacheMu.RLock()
	cached, hit := e.blameCache[key]
	e.cacheMu.RUnlock()
	if hit {
		return cached.([]*gitchatv1.BlameLine), nil
	}

	// Phase 3 — subprocess blame with no locks held.
	out, err := gitBlamePorcelain(ctx, e.Path, resolved, path)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, err
		}
		// Phase 3b — fallback to go-git blame under mu.
		e.mu.Lock()
		commit, cerr := e.repo.CommitObject(plumbing.NewHash(resolved))
		if cerr != nil {
			e.mu.Unlock()
			return nil, fmt.Errorf("blame %q: %w", path, cerr)
		}
		result, gogitErr := git.Blame(commit, path)
		e.mu.Unlock()
		if gogitErr != nil {
			return nil, fmt.Errorf("blame %q: %w", path, gogitErr)
		}
		out = make([]*gitchatv1.BlameLine, 0, len(result.Lines))
		for _, l := range result.Lines {
			out = append(out, &gitchatv1.BlameLine{
				Text:        l.Text,
				AuthorName:  l.AuthorName,
				AuthorEmail: l.Author,
				Date:        l.Date.Unix(),
				CommitSha:   l.Hash.String(), // full SHA; truncated on output
			})
		}
	}

	// Phase 4 — enrich with commit messages (go-git lookups under mu).
	// CommitObject by full SHA is O(1); ResolveRevision on a 7-char
	// abbreviation does a prefix scan, which used to dominate blame
	// latency on deep histories.
	e.mu.Lock()
	msgCache := map[string]string{}
	for _, bl := range out {
		full := bl.CommitSha
		msg, ok := msgCache[full]
		if !ok {
			if c, err := e.repo.CommitObject(plumbing.NewHash(full)); err == nil {
				msg = strings.TrimSpace(c.Message)
			}
			msgCache[full] = msg
		}
		bl.CommitMessage = msg
		bl.CommitSha = ShortSHA(full)
	}
	e.mu.Unlock()

	// Phase 5 — cache store under cacheMu.
	e.cacheMu.Lock()
	if e.blameCache == nil {
		e.blameCache = make(map[string]any, blameCacheCap)
	}
	if len(e.blameCache) >= blameCacheCap {
		drop := blameCacheCap / 2
		for k := range e.blameCache {
			delete(e.blameCache, k)
			if drop--; drop <= 0 {
				break
			}
		}
	}
	e.blameCache[key] = out
	e.cacheMu.Unlock()

	return out, nil
}


// GetDiff returns a unified-diff patch for either a single file or an
// entire commit range, depending on whether `path` is provided.
//
//   - path != "":  patch for just that file between fromRef and toRef.
//   - path == "":  patch for every file changed between fromRef and
//     toRef, concatenated into one multi-file unified diff, capped at
//     GITCHAT_MAX_DIFF_BYTES with a truncation note.
//
// Empty fromRef defaults to the parent of toRef (i.e. "what did this
// commit do"); empty toRef defaults to HEAD. Returns empty=true if
// nothing changed between the two commits for the scope requested.
func (e *Entry) GetDiff(ctx context.Context, fromRef, toRef, path string, detectRenames bool) (diff, fromSHA, toSHA string, empty bool, files []*gitchatv1.ChangedFile, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	// Resolve to-side first so we can default fromRef to its parent.
	toCommit, toResolved, err := e.resolveCommit(toRef)
	if err != nil {
		return "", "", "", false, nil, err
	}

	var fromCommit *object.Commit
	var fromResolved string
	if fromRef == "" {
		// Default: diff against first parent. Root commits have no
		// parent — treat the "from" side as empty (everything is new).
		if toCommit.NumParents() > 0 {
			parent, perr := toCommit.Parents().Next()
			if perr != nil {
				return "", "", "", false, nil, fmt.Errorf("get parent: %w", perr)
			}
			fromCommit = parent
			fromResolved = parent.Hash.String()
		}
	} else {
		fc, resolved, rerr := e.resolveCommit(fromRef)
		if rerr != nil {
			return "", "", "", false, nil, rerr
		}
		fromCommit = fc
		fromResolved = resolved
	}

	// Resolve tunables once per GetDiff call so a UI edit mid-session
	// takes effect on the next request without restart.
	maxDiffBytes := e.cfgInt(ctx, "GITCHAT_MAX_DIFF_BYTES", defaultMaxDiffBytesFallback)
	contextLines := e.cfgInt(ctx, "GITCHAT_DIFF_CONTEXT_LINES", defaultDiffContextLinesFallback)

	// ── Single-file path ───────────────────────────────────────────
	if path != "" {
		from, fromErr := fileContentDetail(fromCommit, path, maxDiffBytes)
		to, toErr := fileContentDetail(toCommit, path, maxDiffBytes)
		if fromErr != nil && toErr != nil {
			return "", fromResolved, toResolved, false, nil, ErrNotFound
		}
		// Identity on (kind, sha): both-missing, same-blob, or same
		// placeholder over the same blob all count as no change.
		if from.kind == to.kind && from.sha == to.sha {
			return "", fromResolved, toResolved, true, nil, nil
		}
		// Placeholder-on-either-side diffs can't be rendered as a
		// useful unified patch (we'd be diffing two sentinel strings),
		// so emit a minimal placeholder patch the frontend formats
		// into a clean "file too large / binary" banner.
		if from.kind != "" || to.kind != "" {
			return renderPlaceholderPatch(path, from, to), fromResolved, toResolved, false, nil, nil
		}
		patch := renderUnifiedDiff(path, fromResolved, toResolved, from.content, to.content, contextLines)
		return patch, fromResolved, toResolved, false, nil, nil
	}

	// ── Whole-commit path ──────────────────────────────────────────
	// Enumerate every path touched between from and to, compute each
	// file's single-file patch, and concatenate. Sort for determinism.
	// Also builds per-file metadata in a single tree-diff pass.
	changed, files, err := changedPathsWithFiles(ctx, fromCommit, toCommit, detectRenames)
	if err != nil {
		return "", fromResolved, toResolved, false, nil, err
	}
	if len(changed) == 0 {
		return "", fromResolved, toResolved, true, nil, nil
	}
	// Cap files processed for large diffs. files is index-aligned with
	// changed, so we slice both together before appending the sentinel.
	maxFiles := 100
	if len(changed) > maxFiles {
		truncatedCount := len(changed) - maxFiles
		changed = changed[:maxFiles]
		files = files[:maxFiles]
		files = append(files, &gitchatv1.ChangedFile{
			Path:   fmt.Sprintf("... and %d more files", truncatedCount),
			Status: "truncated",
		})
	}

	var sb bytes.Buffer
	truncated := 0
	for i, p := range changed {
		from, _ := fileContentDetail(fromCommit, p, maxDiffBytes)
		to, _ := fileContentDetail(toCommit, p, maxDiffBytes)
		// True no-change: same kind + same blob SHA on both sides.
		// Placeholder text alone isn't authoritative because two
		// "too-large" sides over different blobs share the same kind
		// but different SHAs — we still want to emit them.
		if from.kind == to.kind && from.sha == to.sha {
			continue
		}
		if i < len(files) {
			files[i].Additions, files[i].Deletions = fileDiffStats(from, to)
		}
		var filePatch string
		if from.kind != "" || to.kind != "" {
			filePatch = renderPlaceholderPatch(p, from, to)
		} else {
			filePatch = renderUnifiedDiff(p, fromResolved, toResolved, from.content, to.content, contextLines)
		}
		if sb.Len()+len(filePatch) > maxDiffBytes {
			truncated = len(changed) - i
			break
		}
		sb.WriteString(filePatch)
	}
	if truncated > 0 {
		fmt.Fprintf(&sb, "\n… (%d more file(s) truncated)\n", truncated)
	}
	if sb.Len() == 0 {
		return "", fromResolved, toResolved, true, files, nil
	}
	return sb.String(), fromResolved, toResolved, false, files, nil
}

// changedPathsWithFiles returns sorted changed paths plus one ChangedFile
// per path carrying Path + Status (no +/− stats). The returned files slice
// is index-aligned with paths, so callers can look up a file by index and
// lazily fill in Additions/Deletions when they render the actual patch.
//
// We deliberately do NOT call changes.Patch() here: for large divergences
// (e.g. Koha main vs. a release branch ~ thousands of touched files) the
// full Myers diff dominated CPU (67% flat in profiling) just to produce
// per-file stats that the caller often discards past its file cap.
func changedPathsWithFiles(ctx context.Context, from, to *object.Commit, detectRenames bool) ([]string, []*gitchatv1.ChangedFile, error) {
	toTree, err := to.Tree()
	if err != nil {
		return nil, nil, fmt.Errorf("to tree: %w", err)
	}
	if from == nil {
		// Root commit — every file is new.
		var paths []string
		err := toTree.Files().ForEach(func(f *object.File) error {
			paths = append(paths, f.Name)
			return nil
		})
		if err != nil {
			return nil, nil, err
		}
		sort.Strings(paths)
		files := make([]*gitchatv1.ChangedFile, len(paths))
		for i, p := range paths {
			files[i] = &gitchatv1.ChangedFile{Path: p, Status: "added"}
		}
		return paths, files, nil
	}

	fromTree, err := from.Tree()
	if err != nil {
		return nil, nil, fmt.Errorf("from tree: %w", err)
	}
	changes, err := diffTrees(ctx, fromTree, toTree)
	if err != nil {
		return nil, nil, fmt.Errorf("tree diff: %w", err)
	}
	// Rename detection is O(adds × deletes) over blob reads. Only run it
	// when the change set is small enough that the caller won't truncate
	// the bulk of it anyway. maxFilesForRenames matches GetDiff's
	// per-file-output cap — if we'd truncate past 100, detecting renames
	// on the tail is wasted work.
	const maxFilesForRenames = 100
	if detectRenames && len(changes) <= maxFilesForRenames {
		if detected, derr := detectRenamesIn(changes); derr == nil {
			changes = detected
		}
	}

	type entry struct {
		status   string
		fromPath string
		order    int
	}
	byPath := make(map[string]entry, len(changes))
	for _, c := range changes {
		name := c.To.Name
		if name == "" {
			name = c.From.Name
		}
		status := "modified"
		fromPath := ""
		switch {
		case c.From.Name == "":
			status = "added"
		case c.To.Name == "":
			status = "deleted"
		case c.From.Name != c.To.Name:
			status = "renamed"
			fromPath = c.From.Name
		}
		if _, seen := byPath[name]; !seen {
			byPath[name] = entry{status: status, fromPath: fromPath, order: len(byPath)}
		}
	}

	paths := make([]string, 0, len(byPath))
	for p := range byPath {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	files := make([]*gitchatv1.ChangedFile, len(paths))
	for i, p := range paths {
		e := byPath[p]
		files[i] = &gitchatv1.ChangedFile{Path: p, Status: e.status, FromPath: e.fromPath}
	}
	return paths, files, nil
}

// countDiffLines counts additions and deletions between two file
// contents using the same line-splitter renderUnifiedDiff uses. Much
// cheaper than go-git's Patch() because it skips the intra-line diff
// (Myers bisection) — status-bar stats only need line counts, not char
// alignment.
func countDiffLines(fromContent, toContent string) (adds, dels int32) {
	if fromContent == toContent {
		return 0, 0
	}
	fromLines := splitLinesKeepNL(fromContent)
	toLines := splitLinesKeepNL(toContent)
	// countDiffLines only needs the +/- tally, which is independent of
	// how hunks are grouped for rendering. Pass the fallback context so
	// we don't drag a tunable resolve into hot-loop stat computation.
	for _, h := range diffHunks(fromLines, toLines, defaultDiffContextLinesFallback) {
		for _, line := range h.lines {
			if line == "" {
				continue
			}
			switch line[0] {
			case '+':
				adds++
			case '-':
				dels++
			}
		}
	}
	return adds, dels
}

// GetStatus returns the working tree status: staged, unstaged, and
// untracked files categorized by their git status.
//
// Primary path shells out to `git status --porcelain=v1 -z`; go-git's
// worktree.Status() walks the full index and hashes every blob to
// detect content changes, which on Koha-sized repos cost ~3.4s per
// call. The subprocess returns the same buckets in 50-200ms. Context
// cancel kills the subprocess. Falls back to go-git if the exec fails.
func (e *Entry) GetStatus(ctx context.Context) (staged, unstaged, untracked []*gitchatv1.StatusFile, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	staged, unstaged, untracked, err = gitStatusPorcelain(ctx, e.Path)
	if err == nil {
		return staged, unstaged, untracked, nil
	}

	// Fall back to go-git so the feature still works on hosts without
	// the git binary (or if the exec errored unexpectedly).
	w, werr := e.repo.Worktree()
	if werr != nil {
		return nil, nil, nil, fmt.Errorf("worktree: %w", werr)
	}
	status, serr := w.Status()
	if serr != nil {
		return nil, nil, nil, fmt.Errorf("status: %w", serr)
	}
	staged, unstaged, untracked = nil, nil, nil
	for path, fs := range status {
		if s := mapStatusCode(fs.Staging); s != "" {
			staged = append(staged, &gitchatv1.StatusFile{Path: path, Status: s})
		}
		if s := mapStatusCode(fs.Worktree); s != "" {
			if fs.Staging == git.Untracked && fs.Worktree == git.Untracked {
				untracked = append(untracked, &gitchatv1.StatusFile{Path: path, Status: "added"})
			} else {
				unstaged = append(unstaged, &gitchatv1.StatusFile{Path: path, Status: s})
			}
		}
	}
	sort.Slice(staged, func(i, j int) bool { return staged[i].Path < staged[j].Path })
	sort.Slice(unstaged, func(i, j int) bool { return unstaged[i].Path < unstaged[j].Path })
	sort.Slice(untracked, func(i, j int) bool { return untracked[i].Path < untracked[j].Path })
	return staged, unstaged, untracked, nil
}

func mapStatusCode(c git.StatusCode) string {
	switch c {
	case git.Added:
		return "added"
	case git.Modified:
		return "modified"
	case git.Deleted:
		return "deleted"
	case git.Renamed:
		return "renamed"
	case git.Copied:
		return "copied"
	case git.Untracked:
		return "added"
	case git.UpdatedButUnmerged:
		// Merge conflict. The primary (git status --porcelain) path
		// surfaces these via the 'U' status char → "unmerged"; the
		// fallback used to silently drop them, hiding conflicts from
		// the changes view when users were mid-merge.
		return "unmerged"
	default:
		return ""
	}
}

// GetWorkingTreeDiff returns a unified diff for a single file between
// its HEAD version and its current working tree content.
func (e *Entry) GetWorkingTreeDiff(path string) (string, bool, error) {
	clean, err := SafePath(path)
	if err != nil {
		return "", false, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	// No ctx in signature; Registry's own DB lookup is timeout-guarded.
	ctx := context.Background()
	maxDiffBytes := e.cfgInt(ctx, "GITCHAT_MAX_DIFF_BYTES", defaultMaxDiffBytesFallback)
	contextLines := e.cfgInt(ctx, "GITCHAT_DIFF_CONTEXT_LINES", defaultDiffContextLinesFallback)
	headCommit, _, err := e.resolveCommit("")
	if err != nil {
		return "", false, err
	}
	headContent, _ := fileContent(headCommit, clean, maxDiffBytes)

	diskPath := filepath.Join(e.Path, clean)
	diskBytes, err := os.ReadFile(diskPath)
	if err != nil {
		if os.IsNotExist(err) {
			// File deleted from working tree.
			if headContent == "" {
				return "", true, nil
			}
			patch := renderUnifiedDiff(path, "HEAD", "working tree", headContent, "", contextLines)
			return patch, false, nil
		}
		return "", false, fmt.Errorf("read %s: %w", path, err)
	}
	diskContent := string(diskBytes)

	if headContent == diskContent {
		return "", true, nil
	}
	patch := renderUnifiedDiff(path, "HEAD", "working tree", headContent, diskContent, contextLines)
	return patch, false, nil
}

// fileSide captures everything GetDiff needs to know about one side of a
// per-file change. `content` is what we'd render into a patch; `kind`
// distinguishes real content ("") from sentinel placeholders
// ("too-large", "binary") and missing paths ("missing"). `blob` is the
// underlying go-git handle for streaming reads (e.g. cheap line counts
// on oversized blobs where we intentionally skip loading the full bytes
// into memory). `sha` plus `kind` are what callers compare for identity
// — two placeholder strings that happen to share literal text no longer
// masquerade as "unchanged" when the blobs behind them differ.
type fileSide struct {
	content string
	kind    string // "" (real) | "missing" | "too-large" | "binary"
	blob    *object.Blob
	sha     string
	size    int64
}

// fileContentDetail resolves `path` at `commit` to a fileSide. Missing
// paths return kind="missing" with empty sha; oversized or binary blobs
// return sentinel content tagged with the blob SHA so equality checks
// across sides only collapse when the underlying blobs truly match.
// `maxBytes` is the per-file size cap; blobs above it get a sentinel
// instead of their contents. Callers resolve this from the config
// Registry so UI edits to GITCHAT_MAX_DIFF_BYTES take effect live.
func fileContentDetail(commit *object.Commit, path string, maxBytes int) (fileSide, error) {
	if commit == nil {
		return fileSide{kind: "missing"}, nil
	}
	tree, err := commit.Tree()
	if err != nil {
		return fileSide{}, fmt.Errorf("get tree: %w", err)
	}
	f, err := tree.File(path)
	if err != nil {
		if errors.Is(err, object.ErrFileNotFound) {
			return fileSide{kind: "missing"}, nil
		}
		return fileSide{}, fmt.Errorf("find file: %w", err)
	}
	sha := f.Hash.String()
	if f.Size > int64(maxBytes) {
		return fileSide{
			content: fmt.Sprintf("(file too large for inline diff: %s, %d bytes)", sha[:12], f.Size),
			kind:    "too-large",
			blob:    &f.Blob,
			sha:     sha,
			size:    f.Size,
		}, nil
	}
	contents, err := f.Contents()
	if err != nil {
		return fileSide{}, fmt.Errorf("read blob: %w", err)
	}
	if isBinary([]byte(contents[:min(len(contents), 8192)])) {
		return fileSide{
			content: fmt.Sprintf("(binary file: %s)", sha[:12]),
			kind:    "binary",
			blob:    &f.Blob,
			sha:     sha,
			size:    f.Size,
		}, nil
	}
	return fileSide{content: contents, blob: &f.Blob, sha: sha, size: f.Size}, nil
}

// fileContent is a string-only adapter over fileContentDetail for
// callers that don't need blob handles (rename detection, single-file
// render). The returned string still carries the SHA-tagged placeholder
// for oversized/binary content so any equality check downstream won't
// silently collide when the blobs actually differ.
func fileContent(commit *object.Commit, path string, maxBytes int) (string, error) {
	side, err := fileContentDetail(commit, path, maxBytes)
	return side.content, err
}

// blobLineCount streams `blob` and returns the number of lines,
// defined as the count of '\n' plus one if the final byte isn't a
// newline. Used for per-file stats on oversized blobs where we've
// declined to load the full contents into a string — so we can still
// put a useful net-delta number in the file list instead of zeros.
func blobLineCount(blob *object.Blob) (int, error) {
	if blob == nil {
		return 0, nil
	}
	r, err := blob.Reader()
	if err != nil {
		return 0, err
	}
	defer r.Close()
	var buf [64 * 1024]byte
	count := 0
	hadBytes := false
	var last byte
	for {
		n, rerr := r.Read(buf[:])
		if n > 0 {
			hadBytes = true
			last = buf[n-1]
			for i := 0; i < n; i++ {
				if buf[i] == '\n' {
					count++
				}
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return 0, rerr
		}
	}
	if hadBytes && last != '\n' {
		count++
	}
	return count, nil
}

// fileDiffStats picks the cheapest accurate stat path for this pair of
// sides. Both real: feed the full content into the LCS line differ.
// Either side placeholder: stream newline counts and report net delta
// — undercounts in-place edits (swapping all 1000 lines shows 0/0) but
// accurately reports growth/shrink, which beats the previous always-0
// behaviour. Binary on either side: stats are meaningless, return 0/0.
func fileDiffStats(from, to fileSide) (int32, int32) {
	if from.kind == "" && to.kind == "" {
		return countDiffLines(from.content, to.content)
	}
	if from.kind == "binary" || to.kind == "binary" {
		return 0, 0
	}
	fromLines, _ := blobLineCount(from.blob)
	toLines, _ := blobLineCount(to.blob)
	adds, dels := int32(0), int32(0)
	if toLines > fromLines {
		adds = int32(toLines - fromLines)
	}
	if fromLines > toLines {
		dels = int32(fromLines - toLines)
	}
	return adds, dels
}

// renderUnifiedDiff produces a `diff --git` style unified patch for a
// single file. Uses the stdlib-free unified diff builder via
// github.com/go-git/go-git's own patch machinery would require a full
// tree diff; for a single-file view we compute it directly from the
// two content strings with a line-level LCS. That's cheaper and gives
// us full control over the output format.
func renderUnifiedDiff(path, fromSHA, toSHA, fromContent, toContent string, contextLines int) string {
	fromLines := splitLinesKeepNL(fromContent)
	toLines := splitLinesKeepNL(toContent)
	hunks := diffHunks(fromLines, toLines, contextLines)

	var sb bytes.Buffer
	// Header mimics git's shape so Shiki's diff grammar highlights it.
	fmt.Fprintf(&sb, "diff --git a/%s b/%s\n", path, path)
	if fromSHA != "" && toSHA != "" {
		fmt.Fprintf(&sb, "index %s..%s\n", ShortSHA(fromSHA), ShortSHA(toSHA))
	}
	if fromContent == "" {
		sb.WriteString("--- /dev/null\n")
	} else {
		fmt.Fprintf(&sb, "--- a/%s\n", path)
	}
	if toContent == "" {
		sb.WriteString("+++ /dev/null\n")
	} else {
		fmt.Fprintf(&sb, "+++ b/%s\n", path)
	}
	for _, h := range hunks {
		fmt.Fprintf(&sb, "@@ -%d,%d +%d,%d @@\n", h.fromStart, h.fromLen, h.toStart, h.toLen)
		for _, line := range h.lines {
			sb.WriteString(line)
		}
	}
	return sb.String()
}

// renderPlaceholderPatch emits a minimal unified-diff-shaped stub for a
// file where at least one side is a placeholder (too-large or binary).
// We can't Myers-diff sentinel strings usefully, so we encode the
// state in a single hunk the frontend detects and rewrites into a
// clean "file too large / binary file changed" banner. Shape stays
// diff-adjacent so tools that dump the raw patch (CLI, chat prompts)
// still show something readable.
func renderPlaceholderPatch(path string, from, to fileSide) string {
	var sb bytes.Buffer
	fmt.Fprintf(&sb, "diff --git a/%s b/%s\n", path, path)
	if from.sha != "" && to.sha != "" {
		fmt.Fprintf(&sb, "index %s..%s\n", ShortSHA(from.sha), ShortSHA(to.sha))
	}
	fmt.Fprintf(&sb, "--- a/%s\n", path)
	fmt.Fprintf(&sb, "+++ b/%s\n", path)
	// Single synthetic hunk: the marker lines are prefixed with '#' so
	// no diff parser interprets them as +/- content. The frontend looks
	// for the "placeholder-diff:" sentinel to swap in the banner UI.
	sb.WriteString("@@ placeholder-diff @@\n")
	fmt.Fprintf(&sb, "# from: kind=%q size=%d sha=%s\n", describeKind(from), from.size, ShortSHA(from.sha))
	fmt.Fprintf(&sb, "# to:   kind=%q size=%d sha=%s\n", describeKind(to), to.size, ShortSHA(to.sha))
	return sb.String()
}

func describeKind(s fileSide) string {
	if s.kind == "" {
		return "content"
	}
	return s.kind
}

// ShortSHALen is the display-width for abbreviated commit hashes shared
// between backend and frontend. 7 is git's historical default but becomes
// ambiguous in large repos — git itself auto-extends to 11+ for repos with
// more than ~16k commits, so we default to 12 (matches `git log --oneline`
// on Koha-scale histories).
const ShortSHALen = 12

// ShortSHA truncates a full hex SHA to ShortSHALen. Safe for short inputs.
func ShortSHA(s string) string {
	if len(s) > ShortSHALen {
		return s[:ShortSHALen]
	}
	return s
}


// splitLinesKeepNL splits s into lines, keeping trailing newlines so
// the diff output preserves line terminators. An input ending in "\n"
// produces N lines; an input without the trailing newline produces the
// final line without one (matching git's "\ No newline at end of file"
// behaviour, though we don't emit that marker here).
func splitLinesKeepNL(s string) []string {
	if s == "" {
		return nil
	}
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i+1])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

// diffHunk is one contiguous change block.
type diffHunk struct {
	fromStart, fromLen int
	toStart, toLen     int
	lines              []string // each prefixed with ' ', '-', or '+'
}

// diffHunks computes hunks from line arrays using a simple LCS-based
// diff. Good enough for file-pair diffing; not optimized for huge
// files. The file cap is already ~16 KiB via GetFile's max, so
// O(m*n) here is fine.
func diffHunks(a, b []string, contextLines int) []diffHunk {
	ops := lcsDiffOps(a, b)
	if len(ops) == 0 {
		return nil
	}

	// Group non-equal ops into hunks with context lines around.
	context := contextLines
	var hunks []diffHunk
	n := len(ops)
	i := 0
	for i < n {
		// Skip leading equals.
		for i < n && ops[i].kind == opEqual {
			i++
		}
		if i >= n {
			break
		}
		// Start of a change block. Back up for context.
		ctxStart := i - context
		if ctxStart < 0 {
			ctxStart = 0
		}
		// Find end of the change block: stretch through 2*context
		// equals (i.e. merge adjacent changes into one hunk).
		j := i
		for j < n {
			if ops[j].kind != opEqual {
				j++
				continue
			}
			// Count run of equals from j.
			k := j
			for k < n && ops[k].kind == opEqual {
				k++
			}
			runLen := k - j
			if runLen >= 2*context || k >= n {
				break
			}
			j = k
		}
		ctxEnd := j + context
		if ctxEnd > n {
			ctxEnd = n
		}
		// Don't extend forward past the file into more context than
		// we have equals for — recompute from the actual ops.
		actualEnd := j
		for actualEnd < ctxEnd && actualEnd < n && ops[actualEnd].kind == opEqual {
			actualEnd++
		}

		h := buildHunk(ops[ctxStart:actualEnd])
		hunks = append(hunks, h)
		i = actualEnd
	}
	return hunks
}

// diffOp kinds.
type diffOp struct {
	kind     int    // opEqual | opDel | opIns
	line     string // the line from a or b
	aIdx     int    // 1-based line number in a (0 for inserts)
	bIdx     int    // 1-based line number in b (0 for deletes)
}

const (
	opEqual = iota
	opDel
	opIns
)

// lcsDiffOps returns a sequence of ops (equal/del/ins) describing the
// transformation from a to b. Standard dynamic-programming LCS — O(m*n)
// space and time. Adequate for file-pair diffs up to ~10k lines.
func lcsDiffOps(a, b []string) []diffOp {
	m, n := len(a), len(b)
	// dp[i][j] = length of LCS of a[:i] and b[:j]
	dp := make([][]int, m+1)
	for i := range dp {
		dp[i] = make([]int, n+1)
	}
	for i := 1; i <= m; i++ {
		for j := 1; j <= n; j++ {
			if a[i-1] == b[j-1] {
				dp[i][j] = dp[i-1][j-1] + 1
			} else if dp[i-1][j] >= dp[i][j-1] {
				dp[i][j] = dp[i-1][j]
			} else {
				dp[i][j] = dp[i][j-1]
			}
		}
	}
	// Walk back to produce ops in forward order.
	var ops []diffOp
	i, j := m, n
	for i > 0 || j > 0 {
		switch {
		case i > 0 && j > 0 && a[i-1] == b[j-1]:
			ops = append(ops, diffOp{kind: opEqual, line: a[i-1], aIdx: i, bIdx: j})
			i--
			j--
		case j > 0 && (i == 0 || dp[i][j-1] >= dp[i-1][j]):
			ops = append(ops, diffOp{kind: opIns, line: b[j-1], bIdx: j})
			j--
		default:
			ops = append(ops, diffOp{kind: opDel, line: a[i-1], aIdx: i})
			i--
		}
	}
	// Reverse.
	for l, r := 0, len(ops)-1; l < r; l, r = l+1, r-1 {
		ops[l], ops[r] = ops[r], ops[l]
	}
	return ops
}

// buildHunk renders a slice of ops into a diffHunk with proper line
// numbers and prefixed lines.
func buildHunk(slice []diffOp) diffHunk {
	var h diffHunk
	// Establish starting line numbers from the first op in the slice.
	for _, op := range slice {
		if op.aIdx > 0 {
			h.fromStart = op.aIdx
			break
		}
	}
	for _, op := range slice {
		if op.bIdx > 0 {
			h.toStart = op.bIdx
			break
		}
	}
	if h.fromStart == 0 {
		h.fromStart = 1
	}
	if h.toStart == 0 {
		h.toStart = 1
	}
	for _, op := range slice {
		switch op.kind {
		case opEqual:
			h.lines = append(h.lines, " "+ensureNL(op.line))
			h.fromLen++
			h.toLen++
		case opDel:
			h.lines = append(h.lines, "-"+ensureNL(op.line))
			h.fromLen++
		case opIns:
			h.lines = append(h.lines, "+"+ensureNL(op.line))
			h.toLen++
		}
	}
	return h
}

func ensureNL(s string) string {
	if s == "" || s[len(s)-1] == '\n' {
		return s
	}
	return s + "\n"
}

// resolveCommit returns the commit for a ref. Empty ref uses the default
// branch. The returned string is the full SHA that was used.
func (e *Entry) resolveCommit(ref string) (*object.Commit, string, error) {
	if ref == "" {
		ref = e.DefaultBranch
	}
	hash, err := e.repo.ResolveRevision(plumbing.Revision(ref))
	if err != nil {
		return nil, "", fmt.Errorf("resolve ref %q: %w", ref, err)
	}
	commit, err := e.repo.CommitObject(*hash)
	if err != nil {
		return nil, "", fmt.Errorf("read commit %s: %w", hash, err)
	}
	return commit, hash.String(), nil
}

// diffTrees compares two trees and returns the merkletrie change set
// without rename detection. Rename detection is a separate, opt-in pass
// via detectRenamesIn below so callers can cap the change set first and
// avoid running the similarity matrix over thousands of rows only to
// throw most of them away.
//
// ctx is threaded to go-git's DiffTreeContext so a client cancel or
// RPC deadline actually stops the merkletrie walk — previously this
// swallowed context.Background() and kept running until done, which
// on Koha-scale diffs was 0.5-2s of wasted CPU per abandoned request.
func diffTrees(ctx context.Context, from, to *object.Tree) (object.Changes, error) {
	return object.DiffTreeWithOptions(ctx, from, to, nil)
}

// detectRenamesIn runs go-git's rename detector on a (pre-capped) change
// set. Operates on a local copy of DefaultDiffTreeOptions so we never
// share that package-level pointer with concurrent callers; that's
// latent-safe today because all option fields are scalars, but it would
// become a race if go-git ever adds a slice or map field.
func detectRenamesIn(changes object.Changes) (object.Changes, error) {
	opts := *object.DefaultDiffTreeOptions
	return object.DetectRenames(changes, &opts)
}

func entryType(m filemode.FileMode) gitchatv1.EntryType {
	switch m {
	case filemode.Dir:
		return gitchatv1.EntryType_ENTRY_TYPE_DIR
	case filemode.Symlink:
		return gitchatv1.EntryType_ENTRY_TYPE_SYMLINK
	case filemode.Submodule:
		return gitchatv1.EntryType_ENTRY_TYPE_SUBMODULE
	case filemode.Regular, filemode.Executable, filemode.Deprecated:
		return gitchatv1.EntryType_ENTRY_TYPE_FILE
	default:
		return gitchatv1.EntryType_ENTRY_TYPE_UNSPECIFIED
	}
}

// isBinary is a coarse heuristic: a file is binary if the first 8KB
// contains a NUL byte. Same rule git itself uses.
func isBinary(content []byte) bool {
	check := content
	if len(check) > 8192 {
		check = check[:8192]
	}
	return bytes.IndexByte(check, 0) >= 0
}

func commitBody(s string) string {
	// Body is everything after the subject + blank separator line.
	idx := strings.Index(s, "\n\n")
	if idx < 0 {
		return ""
	}
	return strings.TrimSpace(s[idx+2:])
}

func firstLine(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			return s[:i]
		}
	}
	return s
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

