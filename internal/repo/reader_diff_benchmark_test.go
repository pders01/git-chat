package repo

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// Direct helper microbenchmarks only: no repository/object/network/model cost,
// no process-RSS/SLA claim and no unsafe many-gigabyte allocation experiment.
func BenchmarkReaderDiffSmall(b *testing.B)     { benchmarkReaderText(b, 64) }
func BenchmarkReaderDiffNearLimit(b *testing.B) { benchmarkReaderText(b, 1023) }
func benchmarkReaderText(b *testing.B, lines int) {
	before := strings.Repeat("stable\n", lines)
	after := "changed\n" + strings.Repeat("stable\n", lines-1)
	from, to := fileSide{content: before, sha: "old"}, fileSide{content: after, sha: "new"}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		patch, err := renderFilePatch(newDiffWork(context.Background()), "proof.txt", from, to, 3)
		if err != nil || patch == "" {
			b.Fatalf("bounded render failed: %v", err)
		}
	}
}
func BenchmarkReaderDiffPerFileRefusal(b *testing.B) {
	from, to := fileSide{content: strings.Repeat("old\n", 1024), sha: "old"}, fileSide{content: strings.Repeat("new\n", 1024), sha: "new"}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		patch, err := renderFilePatch(newDiffWork(context.Background()), "proof.txt", from, to, 3)
		if patch != "" || !errors.Is(err, errDiffWorkLimit) {
			b.Fatalf("per-file work refusal lost: %v", err)
		}
	}
}
func BenchmarkReaderDiffReadAggregateRefusal(b *testing.B) {
	from, to := fileSide{content: strings.Repeat("old\n", 512), sha: "old"}, fileSide{content: strings.Repeat("new\n", 512), sha: "new"}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		work := newDiffWork(context.Background())
		var err error
		for file := 0; file < 18; file++ {
			if _, _, err = countDiffLines(work, from.content, to.content); err != nil {
				break
			}
			if _, err = renderFilePatch(work, "proof.txt", from, to, 3); err != nil {
				break
			}
		}
		if !errors.Is(err, errDiffWorkLimit) {
			b.Fatalf("combined work refusal lost: %v", err)
		}
	}
}
