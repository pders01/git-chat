package repo

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/go-git/go-git/v5/plumbing/object"
)

// Both native Git and go-git can otherwise make shallow boundaries look like
// roots/exhaustion. Without an explicit partial-history contract, refuse reads.
func (e *Entry) requireFullHistory() error {
	shallow, err := e.repo.Storer.Shallow()
	if err != nil {
		return fmt.Errorf("read shallow history metadata: %w", err)
	}
	if len(shallow) > 0 {
		return errors.New("shallow history is unsupported for complete commit reads")
	}
	return nil
}

// The CTime walk does not implement Git's default merge/path simplification or
// all merge ordering rules. Check BEFORE pagination, so no page certifies an
// unsupported nonlinear graph. Native Git remains the supported merge reader.
func requireLinearFallback(ctx context.Context, commit *object.Commit) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if commit.NumParents() > 1 {
			return errors.New("native Git is required for non-linear commit history")
		}
		if commit.NumParents() == 0 {
			return nil
		}
		parent, err := commit.Parent(0)
		if err != nil {
			return fmt.Errorf("validate fallback ancestry: %w", err)
		}
		commit = parent
	}
}

func gitMessageSpace(value byte) bool {
	// Git's pretty-message whitespace excludes vertical tab and form feed.
	return value == ' ' || value == '\t' || value == '\r' || value == '\n'
}

// Match Git pretty %s/%b for UTF-8 message text: skip blank separator lines,
// join the subject paragraph, trim subject line ends, preserve the body tail.
// Do not use Unicode TrimSpace or trim away intentional body indentation/EOF.
func commitMessageParts(message string) (string, string) {
	readLine := func(start int) (line string, next int) {
		end := strings.IndexByte(message[start:], '\n')
		if end < 0 {
			return message[start:], len(message)
		}
		return message[start : start+end], start + end + 1
	}
	trimEnd := func(line string) string {
		for len(line) > 0 && gitMessageSpace(line[len(line)-1]) {
			line = line[:len(line)-1]
		}
		return line
	}
	position := 0
	var subject []string
	for position < len(message) {
		line, next := readLine(position)
		line = trimEnd(line)
		position = next
		if line == "" {
			if len(subject) > 0 {
				break
			}
			continue
		}
		subject = append(subject, line)
	}
	for position < len(message) {
		line, next := readLine(position)
		if trimEnd(line) != "" {
			return strings.Join(subject, " "), message[position:]
		}
		position = next
	}
	return strings.Join(subject, " "), ""
}

// Git C-quoted path spelling. Never let a literal path control byte invent
// patch header lines; UTF-8 bytes stay literal, matching core.quotePath=false.
func gitPatchPath(path string) string {
	quote := false
	for i := 0; i < len(path); i++ {
		if path[i] < 0x20 || path[i] == 0x7f || path[i] == '"' || path[i] == '\\' {
			quote = true
			break
		}
	}
	if !quote {
		return path
	}
	var out strings.Builder
	out.WriteByte('"')
	for i := 0; i < len(path); i++ {
		switch path[i] {
		case '"', '\\':
			out.WriteByte('\\')
			out.WriteByte(path[i])
		case '\t':
			out.WriteString("\\t")
		case '\n':
			out.WriteString("\\n")
		case '\r':
			out.WriteString("\\r")
		case '\b':
			out.WriteString("\\b")
		case '\f':
			out.WriteString("\\f")
		case '\v':
			out.WriteString("\\v")
		default:
			if path[i] < 0x20 || path[i] == 0x7f {
				fmt.Fprintf(&out, "\\%03o", path[i])
			} else {
				out.WriteByte(path[i])
			}
		}
	}
	out.WriteByte('"')
	return out.String()
}

func sameFileSide(from, to fileSide) bool {
	return from.kind == to.kind && from.sha == to.sha && from.mode == to.mode
}

func renderFilePatch(work *diffWork, path string, from, to fileSide, contextLines int) (string, error) {
	return renderFileChange(work, path, path, from, to, contextLines)
}

func changedFileType(from, to fileSide) bool {
	return from.kind != "missing" && to.kind != "missing" && from.mode&0170000 != to.mode&0170000
}

func renderFileChange(work *diffWork, fromPath, path string, from, to fileSide, contextLines int) (string, error) {
	if err := work.check(); err != nil {
		return "", err
	}
	// A type transition is deletion plus creation, even for identical blobs.
	// A permissions-only old/new mode header cannot represent this change.
	if changedFileType(from, to) {
		deleted, err := renderFileChange(work, fromPath, fromPath, from, fileSide{kind: "missing"}, contextLines)
		if err != nil {
			return "", err
		}
		added, err := renderFileChange(work, path, path, fileSide{kind: "missing"}, to, contextLines)
		if err != nil {
			return "", err
		}
		return work.finishPatch(deleted + added)
	}
	var metadata strings.Builder
	switch {
	case from.kind == "missing" && to.kind != "missing":
		fmt.Fprintf(&metadata, "new file mode %06o\n", to.mode)
	case to.kind == "missing" && from.kind != "missing":
		fmt.Fprintf(&metadata, "deleted file mode %06o\n", from.mode)
	case from.mode != to.mode:
		fmt.Fprintf(&metadata, "old mode %06o\nnew mode %06o\n", from.mode, to.mode)
	}
	if fromPath != path && from.kind != "missing" && to.kind != "missing" {
		if from.sha == to.sha {
			metadata.WriteString("similarity index 100%\n")
		}
		fmt.Fprintf(&metadata, "rename from %s\nrename to %s\n", gitRenamePath(fromPath), gitRenamePath(path))
	}
	header := "diff --git " + gitPatchPath("a/"+fromPath) + " " + gitPatchPath("b/"+path) + "\n"
	if from.sha == to.sha && from.kind == to.kind && (from.mode != to.mode || fromPath != path) {
		return work.finishPatch(header + metadata.String())
	}
	var patch string
	if needsPlaceholder(from.kind) || needsPlaceholder(to.kind) {
		patch = renderPlaceholderPatch(fromPath, path, from, to)
	} else {
		var err error
		patch, err = renderTextChange(work, fromPath, path, from, to, contextLines)
		if err != nil {
			return "", err
		}
	}
	// Empty-file creation/deletion is metadata, not a fabricated content hunk.
	if from.content == "" && to.content == "" && !needsPlaceholder(from.kind) && !needsPlaceholder(to.kind) {
		return work.finishPatch(header + metadata.String())
	}
	first := strings.IndexByte(patch, '\n')
	if first < 0 {
		return "", errors.New("invalid generated patch header")
	}
	return work.finishPatch(patch[:first+1] + metadata.String() + patch[first+1:])
}

// Presence comes from tree entries, not content length. Empty files still use
// real ---/+++ paths; only genuinely missing sides use /dev/null.
func renderTextPatch(work *diffWork, path string, from, to fileSide, contextLines int) (string, error) {
	return renderTextChange(work, path, path, from, to, contextLines)
}

func gitRenamePath(path string) string {
	quoted := gitPatchPath(path)
	if quoted == path && strings.ContainsRune(path, ' ') {
		return "\"" + path + "\""
	}
	return quoted
}

func renderTextChange(work *diffWork, fromPath, path string, from, to fileSide, contextLines int) (string, error) {
	hunks, err := textDiffHunks(work, from.content, to.content, contextLines)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	fmt.Fprintf(&out, "diff --git %s %s\n", gitPatchPath("a/"+fromPath), gitPatchPath("b/"+path))
	if from.sha != "" && to.sha != "" {
		fmt.Fprintf(&out, "index %s..%s\n", ShortSHA(from.sha), ShortSHA(to.sha))
	}
	if from.kind == "missing" {
		out.WriteString("--- /dev/null\n")
	} else {
		fmt.Fprintf(&out, "--- %s\n", gitPatchPath("a/"+fromPath))
	}
	if to.kind == "missing" {
		out.WriteString("+++ /dev/null\n")
	} else {
		fmt.Fprintf(&out, "+++ %s\n", gitPatchPath("b/"+path))
	}
	for _, h := range hunks {
		if err := work.check(); err != nil {
			return "", err
		}
		fmt.Fprintf(&out, "@@ -%d,%d +%d,%d @@\n", h.fromStart, h.fromLen, h.toStart, h.toLen)
		for i, line := range h.lines {
			if i&1023 == 0 {
				if err := work.check(); err != nil {
					return "", err
				}
			}
			out.WriteString(line)
		}
	}
	return work.finishPatch(out.String())
}
