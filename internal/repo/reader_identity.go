package repo

import (
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"
)

// Native Git can transcode declared legacy encodings; go-git exposes raw text.
// Without that conversion contract, refusing is safer than publishing different
// valid-looking UTF-8. NUL cannot be a literal native fixed-field separator.
func requireFallbackCommitText(commit *object.Commit) error {
	encoding := string(commit.Encoding)
	if !strings.EqualFold(encoding, "UTF-8") && !strings.EqualFold(encoding, "UTF8") {
		return errors.New("fallback commit text requires native Git for this encoding")
	}
	for _, text := range []string{commit.Message, commit.Author.Name, commit.Author.Email} {
		if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
			return errors.New("invalid fallback commit text")
		}
	}
	return nil
}

// go-git leaves exact-blob renames with chmod as separate add/delete entries.
// Coalesce only unambiguous one-to-one regular-file pairs; do not guess among
// duplicate blobs or cross file types. Callers already cap rename detection.
func exactPermissionRenames(changes object.Changes) object.Changes {
	type candidates struct{ deletes, adds []int }
	byHash := make(map[plumbing.Hash]*candidates)
	for i, change := range changes {
		var entry object.ChangeEntry
		deletion := change.To.Name == ""
		if deletion {
			entry = change.From
		} else if change.From.Name == "" {
			entry = change.To
		} else {
			continue
		}
		if entry.TreeEntry.Mode != filemode.Regular && entry.TreeEntry.Mode != filemode.Executable && entry.TreeEntry.Mode != filemode.Deprecated {
			continue
		}
		group := byHash[entry.TreeEntry.Hash]
		if group == nil {
			group = &candidates{}
			byHash[entry.TreeEntry.Hash] = group
		}
		if deletion {
			group.deletes = append(group.deletes, i)
		} else {
			group.adds = append(group.adds, i)
		}
	}
	replacements := make(map[int]*object.Change)
	skip := make(map[int]bool)
	for _, group := range byHash {
		if len(group.deletes) != 1 || len(group.adds) != 1 {
			continue
		}
		del, add := group.deletes[0], group.adds[0]
		replacements[del] = &object.Change{From: changes[del].From, To: changes[add].To}
		skip[add] = true
	}
	out := make(object.Changes, 0, len(changes))
	for i, change := range changes {
		if skip[i] {
			continue
		}
		if replacement := replacements[i]; replacement != nil {
			change = replacement
		}
		out = append(out, change)
	}
	return out
}

func commitHasDiffPath(commit *object.Commit, path string) (bool, error) {
	if commit == nil {
		return false, nil
	}
	tree, err := commit.Tree()
	if err != nil {
		return false, err
	}
	_, err = tree.FindEntry(path)
	if errors.Is(err, object.ErrEntryNotFound) || errors.Is(err, object.ErrDirectoryNotFound) {
		return false, nil
	}
	return err == nil, err
}

// A caller's fromPath is a rename hint, not permission to label arbitrary
// unrelated/copy paths as a rename. Validate identity in both immutable trees.
func validateDiffRename(fromCommit, toCommit *object.Commit, fromPath, path string, from, to fileSide) error {
	if from.kind == "missing" || to.kind == "missing" {
		return errors.New("invalid diff rename hint")
	}
	oldStillPresent, err := commitHasDiffPath(toCommit, fromPath)
	if err != nil {
		return err
	}
	newAlreadyPresent, err := commitHasDiffPath(fromCommit, path)
	if err != nil {
		return err
	}
	if oldStillPresent || newAlreadyPresent {
		return errors.New("invalid diff rename hint")
	}
	return nil
}
