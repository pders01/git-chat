package repo

import (
	"context"
	"errors"
)

const (
	// Includes the zero row/column: <=8 MiB of ints on a 64-bit host.
	maxDiffMatrixCells = 1_048_576
	// Stats and rendering charge separately to the same read-owned allowance.
	maxDiffReadCells = 8_388_608
	// Existing oversized-blob net-line stats must not stream without a bound.
	maxDiffStatBytes int64 = 16 * 1024 * 1024
)

var errDiffWorkLimit = errors.New("diff work limit exceeded")

// One instance per read, never per file/stage and never global. Refusal is
// latched: callers cannot recover a partial result or reset an exhausted read.
type diffWork struct {
	ctx       context.Context
	cells     int
	statBytes int64
	err       error
}

func newDiffWork(ctx context.Context) *diffWork {
	return &diffWork{ctx: ctx, cells: maxDiffReadCells, statBytes: maxDiffStatBytes}
}
func (w *diffWork) check() error {
	if w.err == nil {
		w.err = w.ctx.Err()
	}
	return w.err
}
func (w *diffWork) cellCount(m, n int) (int, error) {
	if err := w.check(); err != nil {
		return 0, err
	}
	// Check before addition/multiplication, including machine-sized inputs.
	if m < 0 || n < 0 || m >= maxDiffMatrixCells || n >= maxDiffMatrixCells {
		w.err = errDiffWorkLimit
		return 0, w.err
	}
	rows, columns := m+1, n+1
	if rows > maxDiffMatrixCells/columns {
		w.err = errDiffWorkLimit
		return 0, w.err
	}
	cells := rows * columns
	if cells > w.cells {
		w.err = errDiffWorkLimit
		return 0, w.err
	}
	return cells, nil
}
func (w *diffWork) reserveCells(m, n int) (int, error) {
	cells, err := w.cellCount(m, n)
	if err != nil {
		return 0, err
	}
	w.cells -= cells
	return cells, nil
}
func (w *diffWork) scanBytes(n int64, consume bool) error {
	if err := w.check(); err != nil {
		return err
	}
	if n < 0 || n > w.statBytes {
		w.err = errDiffWorkLimit
		return w.err
	}
	if consume {
		w.statBytes -= n
	}
	return nil
}

func (w *diffWork) finishPatch(patch string) (string, error) {
	if err := w.check(); err != nil {
		return "", err
	}
	return patch, nil
}

func textDiffHunks(w *diffWork, from, to string, contextLines int) ([]diffHunk, error) {
	if err := w.check(); err != nil {
		return nil, err
	}
	if from == to {
		return nil, nil
	}
	count := func(text string) (int, error) {
		lines := 0
		for i := 0; i < len(text); i++ {
			if i&4095 == 0 {
				if err := w.check(); err != nil {
					return 0, err
				}
			}
			if text[i] == '\n' {
				lines++
			}
		}
		if len(text) > 0 && text[len(text)-1] != '\n' {
			lines++
		}
		return lines, nil
	}
	m, err := count(from)
	if err != nil {
		return nil, err
	}
	n, err := count(to)
	if err != nil {
		return nil, err
	}
	// Refuse before allocating even the line slices. lcsDiffOps reserves the
	// actual matrix once; this lookahead must not double-charge it.
	if _, err := w.cellCount(m, n); err != nil {
		return nil, err
	}
	return diffHunks(w, splitLinesKeepNL(from), splitLinesKeepNL(to), contextLines)
}
