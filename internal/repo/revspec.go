package repo

import (
	"fmt"
	"strings"

	"github.com/go-git/go-git/v5/plumbing"
)

// RevRange is a resolved git revision range. FromRef/ToRef are the textual
// forms suitable for display (and for passing back as URL params that the
// server's resolveCommit can re-resolve).
type RevRange struct {
	From    string // full SHA of the "from" boundary, empty means root/empty-tree
	To      string // full SHA of the "to" boundary (HEAD of the range)
	FromRef string
	ToRef   string
	Kind    RangeKind
}

// RangeKind identifies which syntactic form produced the range.
type RangeKind int

const (
	RangeTwoDot RangeKind = iota
	RangeThreeDot
	RangeSingle
)

// ResolveRange parses a user-provided revspec and resolves it against the
// entry's repository. Supported forms:
//
//	A..B   two-dot: FromRef=A, ToRef=B (verbatim)
//	A...B  three-dot: FromRef=merge-base(A,B) as SHA, ToRef=B
//	X      single ref: FromRef=X^ (or empty if X is the root commit), ToRef=X
func (e *Entry) ResolveRange(spec string) (*RevRange, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return nil, fmt.Errorf("empty revspec")
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	if i := strings.Index(spec, "..."); i >= 0 {
		base, head := spec[:i], spec[i+3:]
		if base == "" && head == "" {
			return nil, fmt.Errorf("invalid three-dot range %q", spec)
		}
		if base == "" {
			base = "HEAD"
		}
		if head == "" {
			head = "HEAD"
		}
		baseH, err := e.repo.ResolveRevision(plumbing.Revision(base))
		if err != nil {
			return nil, fmt.Errorf("resolve %q: %w", base, err)
		}
		headH, err := e.repo.ResolveRevision(plumbing.Revision(head))
		if err != nil {
			return nil, fmt.Errorf("resolve %q: %w", head, err)
		}
		baseC, err := e.repo.CommitObject(*baseH)
		if err != nil {
			return nil, fmt.Errorf("load commit %s: %w", baseH, err)
		}
		headC, err := e.repo.CommitObject(*headH)
		if err != nil {
			return nil, fmt.Errorf("load commit %s: %w", headH, err)
		}
		mbs, err := baseC.MergeBase(headC)
		if err != nil {
			return nil, fmt.Errorf("merge-base %s..%s: %w", base, head, err)
		}
		if len(mbs) == 0 {
			return nil, fmt.Errorf("no common ancestor between %q and %q", base, head)
		}
		mbSHA := mbs[0].Hash.String()
		// Use a 12-char abbreviation for display/URL: go-git's
		// ResolveRevision accepts any unambiguous prefix, and 12 chars is
		// the same length `git log --oneline` uses by default. Much less
		// visual noise than the full 40-char hash.
		mbShort := mbSHA
		if len(mbShort) > 12 {
			mbShort = mbShort[:12]
		}
		return &RevRange{
			From:    mbSHA,
			To:      headH.String(),
			FromRef: mbShort,
			ToRef:   head,
			Kind:    RangeThreeDot,
		}, nil
	}

	if i := strings.Index(spec, ".."); i >= 0 {
		from, to := spec[:i], spec[i+2:]
		if from == "" && to == "" {
			return nil, fmt.Errorf("invalid two-dot range %q", spec)
		}
		if from == "" {
			from = "HEAD"
		}
		if to == "" {
			to = "HEAD"
		}
		fromH, err := e.repo.ResolveRevision(plumbing.Revision(from))
		if err != nil {
			return nil, fmt.Errorf("resolve %q: %w", from, err)
		}
		toH, err := e.repo.ResolveRevision(plumbing.Revision(to))
		if err != nil {
			return nil, fmt.Errorf("resolve %q: %w", to, err)
		}
		return &RevRange{
			From:    fromH.String(),
			To:      toH.String(),
			FromRef: from,
			ToRef:   to,
			Kind:    RangeTwoDot,
		}, nil
	}

	toH, err := e.repo.ResolveRevision(plumbing.Revision(spec))
	if err != nil {
		return nil, fmt.Errorf("resolve %q: %w", spec, err)
	}
	parentSpec := spec + "^"
	fromH, err := e.repo.ResolveRevision(plumbing.Revision(parentSpec))
	if err != nil {
		// Root commit — no parent exists. We deliberately refuse rather than
		// emit an empty `compare=..SHA` URL, which the server would
		// misinterpret as "default branch vs SHA" and show a confusing diff.
		return nil, fmt.Errorf("revspec %q is a root commit (no parent); pass an explicit two-dot range instead", spec)
	}
	return &RevRange{
		From:    fromH.String(),
		To:      toH.String(),
		FromRef: parentSpec,
		ToRef:   spec,
		Kind:    RangeSingle,
	}, nil
}

// Summary returns a compact "A..B" string suitable for logs and URLs.
func (r *RevRange) Summary() string {
	if r == nil {
		return ""
	}
	from := r.FromRef
	if from == "" {
		from = "(root)"
	}
	return from + ".." + r.ToRef
}
