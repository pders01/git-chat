package repo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"testing/iotest"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

func TestBranchFullRefInventory(t *testing.T) {
	// Neither this test nor its children may be parallel: fallback changes PATH.
	// Keep native Git independent of the user's global/system configuration.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_COUNT", "0")
	gitPath, gitErr := exec.LookPath("git")

	for _, annotatedMain := range []bool{false, true} {
		name := "lightweight-main"
		if annotatedMain {
			name = "annotated-main"
		}
		t.Run(name, func(t *testing.T) {
			entry, commitSHA := newFullRefFixture(t, annotatedMain)
			ctx := context.Background()
			for _, mode := range []string{"native", "fallback"} {
				t.Run(mode, func(t *testing.T) {
					if mode == "native" && gitErr != nil {
						t.Skipf("native git unavailable: %v", gitErr)
					}
					if mode == "fallback" {
						// All fixture objects/refs exist before Git is hidden.
						t.Setenv("PATH", "")
						if _, err := exec.LookPath("git"); err == nil {
							t.Fatal("git is still discoverable with an empty PATH")
						}
					}
					for _, namespace := range []string{"refs/heads", "refs/tags"} {
						t.Run(namespace, func(t *testing.T) {
							// Check the native helper explicitly so a silent fallback
							// cannot make the native coverage pass accidentally.
							native, nativeErr := gitListBranches(ctx, entry.Path, namespace)
							if mode == "native" && nativeErr != nil {
								t.Fatalf("gitListBranches: %v", nativeErr)
							}
							if mode == "fallback" && nativeErr == nil {
								t.Fatal("native helper unexpectedly succeeded without git")
							}
							list := entry.ListBranches
							if namespace == "refs/tags" {
								list = entry.ListTags
							}
							got, err := list(ctx)
							if err != nil {
								t.Fatal(err)
							}
							if mode == "native" {
								if len(native) != len(got) {
									t.Fatalf("Entry returned %d refs, native helper returned %d", len(got), len(native))
								}
								for i := range got {
									if !proto.Equal(got[i], native[i]) {
										t.Errorf("Entry ref %d differs from native helper", i)
									}
								}
							}

							// Exact same canonical inventory in both modes. In
							// particular, do not strip a literal refs/heads/ prefix
							// from a namespace-relative branch or tag name.
							wantNames := map[string]string{}
							for _, name := range []string{"main", "refs/heads/topic", "heads/main", "tags/main"} {
								wantNames[namespace+"/"+name] = name
							}
							if mode == "native" {
								// Native Name's existing contract is Git's ambiguous-
								// ref shortening, NOT stripping the namespace. Ask Git
								// independently rather than reconstructing its rules.
								wantNames = nativeFullRefDisplayNames(t, gitPath, entry.Path, namespace)
							}
							if len(got) != 4 {
								t.Fatalf("got %d refs, want 4: %v", len(got), got)
							}
							seen := map[string]bool{}
							for _, branch := range got {
								full := branch.GetFullRef()
								// Membership is checked against literal canonical refs,
								// independently of the display-name oracle above.
								relative := strings.TrimPrefix(full, namespace+"/")
								switch relative {
								case "main", "refs/heads/topic", "heads/main", "tags/main":
								default:
									t.Errorf("unexpected canonical ref %q", full)
								}
								if !strings.HasPrefix(full, namespace+"/") || seen[full] {
									t.Errorf("non-canonical or duplicate FullRef %q", full)
								}
								seen[full] = true
								if branch.Name != wantNames[full] {
									t.Errorf("%s: Name = %q, want legacy display %q", full, branch.Name, wantNames[full])
								}

								annotated := namespace == "refs/tags" && (relative == "tags/main" || (relative == "main" && annotatedMain))
								wantCommit, wantTime, wantSubject := commitSHA, int64(1700000000), "fixture commit"
								if annotated {
									wantSubject = "annotated " + relative
									if mode == "native" {
										ref, err := entry.repo.Reference(plumbing.ReferenceName(full), true)
										if err != nil {
											t.Fatal(err)
										}
										wantCommit, wantTime = ref.Hash().String(), 0
										if wantCommit == commitSHA {
											t.Fatal("annotated tag fixture must have a distinct object ID")
										}
									} else {
										wantTime = 1700000060
									}
								}
								// full_ref is additive: retain the existing native tag
								// object vs fallback peeled-commit/time behavior too.
								if branch.Commit != wantCommit || branch.CommitterTime != wantTime || branch.Subject != wantSubject {
									t.Errorf("%s: legacy metadata = (%q, %d, %q), want (%q, %d, %q)", full,
										branch.Commit, branch.CommitterTime, branch.Subject, wantCommit, wantTime, wantSubject)
								}
							}
						})
					}
				})
			}
		})
	}
}

func newFullRefFixture(t *testing.T, annotatedMain bool) (*Entry, string) {
	t.Helper()
	dir := t.TempDir()
	r, err := git.PlainInitWithOptions(dir, &git.PlainInitOptions{InitOptions: git.InitOptions{DefaultBranch: "refs/heads/main"}})
	if err != nil {
		t.Fatal(err)
	}
	w, err := r.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	signature := &object.Signature{Name: "Fixture", Email: "fixture@example.invalid", When: time.Unix(1700000000, 0).UTC()}
	commit, err := w.Commit("fixture commit\n\nbody\n", &git.CommitOptions{Author: signature, Committer: signature, AllowEmptyCommits: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"main", "refs/heads/topic", "heads/main", "tags/main"} {
		full := plumbing.NewBranchReferenceName(name)
		if err := full.Validate(); err != nil {
			t.Fatalf("invalid branch fixture %q: %v", full, err)
		}
		if err := r.Storer.SetReference(plumbing.NewHashReference(full, commit)); err != nil {
			t.Fatal(err)
		}
		var opts *git.CreateTagOptions
		if name == "tags/main" || (name == "main" && annotatedMain) {
			opts = &git.CreateTagOptions{
				Tagger:  &object.Signature{Name: signature.Name, Email: signature.Email, When: time.Unix(1700000060, 0).UTC()},
				Message: "annotated " + name + "\n\ntag body\n",
			}
		}
		if _, err := r.CreateTag(name, commit, opts); err != nil {
			t.Fatalf("create tag %q: %v", name, err)
		}
	}
	// Do not create a Registry: it can trigger unrelated prewarming.
	return &Entry{Path: dir, repo: r}, commit.String()
}

func nativeFullRefDisplayNames(t *testing.T, gitPath, dir, namespace string) map[string]string {
	t.Helper()
	cmd := exec.Command(gitPath, "-C", dir, "for-each-ref", "--format=%(refname)%00%(refname:short)", namespace)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("native display-name oracle: %v", err)
	}
	names := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(string(out), "\n"), "\n") {
		full, short, ok := strings.Cut(line, "\x00")
		if !ok {
			t.Fatalf("malformed native display-name record %q", line)
		}
		names[full] = short
	}
	return names
}

func TestNativeForEachRefSubjectFraming(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_COUNT", "0")
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("native git unavailable: %v", err)
	}
	for _, subject := range []string{
		"real\x1ephantom\x1f" + strings.Repeat("a", 40) + "\x1f0\x1frefs/heads/phantom\x1fforged",
		"real\x1funit\x1fseparators",
	} {
		t.Run(subject, func(t *testing.T) {
			dir := t.TempDir()
			r, err := git.PlainInitWithOptions(dir, &git.PlainInitOptions{InitOptions: git.InitOptions{DefaultBranch: "refs/heads/main"}})
			if err != nil {
				t.Fatal(err)
			}
			w, err := r.Worktree()
			if err != nil {
				t.Fatal(err)
			}
			sig := &object.Signature{Name: "Fixture", Email: "fixture@example.invalid", When: time.Unix(1700000000, 0).UTC()}
			commit, err := w.Commit(subject+"\n", &git.CommitOptions{Author: sig, Committer: sig, AllowEmptyCommits: true})
			if err != nil {
				t.Fatal(err)
			}
			tag, err := r.CreateTag("main", commit, &git.CreateTagOptions{Tagger: sig, Message: subject + "\n"})
			if err != nil {
				t.Fatal(err)
			}
			for _, namespace := range []string{"refs/heads", "refs/tags"} {
				got, err := gitListBranches(context.Background(), dir, namespace)
				if err != nil {
					t.Fatal(err)
				}
				if len(got) != 1 {
					t.Fatalf("%s: got %d rows, want exactly one real ref: %v", namespace, len(got), got)
				}
				wantID, wantTime := commit.String(), int64(1700000000)
				if namespace == "refs/tags" {
					wantID, wantTime = tag.Hash().String(), 0
				}
				if got[0].FullRef != namespace+"/main" || got[0].Commit != wantID || got[0].CommitterTime != wantTime || got[0].Subject != subject {
					t.Errorf("%s: got %v, want real ref/object/time and raw subject %q", namespace, got[0], subject)
				}
			}
		})
	}
}

func TestParseForEachRefFullRef(t *testing.T) {
	const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	branch := framedRefFixture("heads/main", sha, "1700000000", "refs/heads/main", "subject")
	tag := framedRefFixture("tags/main", sha, "", "refs/tags/main", "tag subject")
	wantBranch := &gitchatv1.Branch{Name: "heads/main", Commit: sha, CommitterTime: 1700000000, FullRef: "refs/heads/main", Subject: "subject"}
	for _, tc := range []struct {
		name, input string
		want        []*gitchatv1.Branch
	}{
		{"empty", "", nil},
		{"valid", branch, []*gitchatv1.Branch{wantBranch}},
		{"multiple records", branch + tag, []*gitchatv1.Branch{wantBranch, {Name: "tags/main", Commit: sha, FullRef: "refs/tags/main", Subject: "tag subject"}}},
		{"order unchanged", tag + branch, []*gitchatv1.Branch{{Name: "tags/main", Commit: sha, FullRef: "refs/tags/main", Subject: "tag subject"}, wantBranch}},
		{"subject separators preserved", framedRefFixture("main", sha, "1", "refs/heads/main", "real\x1ephantom\x1f"+sha+"\x1f0\x1frefs/heads/phantom\x1fforged"), []*gitchatv1.Branch{{Name: "main", Commit: sha, CommitterTime: 1, FullRef: "refs/heads/main", Subject: "real\x1ephantom\x1f" + sha + "\x1f0\x1frefs/heads/phantom\x1fforged"}}},
		{"subject whitespace preserved", framedRefFixture("main", sha, "1", "refs/heads/main", "\n  subject\r\n "), []*gitchatv1.Branch{{Name: "main", Commit: sha, CommitterTime: 1, FullRef: "refs/heads/main", Subject: "\n  subject\r\n "}}},
		{"empty subject", framedRefFixture("main", sha, "1", "refs/heads/main", ""), []*gitchatv1.Branch{{Name: "main", Commit: sha, CommitterTime: 1, FullRef: "refs/heads/main"}}},
		{"literal namespace retained", framedRefFixture("heads/refs/heads/topic", sha, "0", "refs/heads/refs/heads/topic", "subject"), []*gitchatv1.Branch{{Name: "heads/refs/heads/topic", Commit: sha, FullRef: "refs/heads/refs/heads/topic", Subject: "subject"}}},
		{"at label retained", framedRefFixture("@", sha, "-1", "refs/tags/@", "subject"), []*gitchatv1.Branch{{Name: "@", Commit: sha, CommitterTime: -1, FullRef: "refs/tags/@", Subject: "subject"}}},
		{"sha256 retained", framedRefFixture("main", strings.Repeat("a", 64), "9223372036854775807", "refs/heads/main", "subject"), []*gitchatv1.Branch{{Name: "main", Commit: strings.Repeat("a", 64), CommitterTime: 9223372036854775807, FullRef: "refs/heads/main", Subject: "subject"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseForEachRef(strings.NewReader(tc.input))
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %d records, want %d: %v", len(got), len(tc.want), got)
			}
			for i := range got {
				if !proto.Equal(got[i], tc.want[i]) {
					t.Errorf("record %d = %v, want %v", i, got[i], tc.want[i])
				}
			}
		})
	}
	t.Run("reader error", func(t *testing.T) {
		wantErr := errors.New("fixture read error")
		if _, err := parseForEachRef(iotest.ErrReader(wantErr)); !errors.Is(err, wantErr) {
			t.Fatalf("error = %v, want %v", err, wantErr)
		}
	})
}

// Match the native format's NUL prefix, five terminated fields, and the
// single newline that for-each-ref itself adds (not part of any field).
func framedRefFixture(fields ...string) string {
	return "\x00" + strings.Join(fields, "\x00") + "\x00\n"
}

func TestParseForEachRefRejectsMalformed(t *testing.T) {
	const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	fields := []string{"main", sha, "1700000000", "refs/heads/main", "subject"}
	valid := framedRefFixture(fields...)
	reject := func(t *testing.T, input string) {
		t.Helper()
		got, err := parseForEachRef(strings.NewReader(input))
		if err == nil || got != nil {
			t.Fatalf("got %v, error %v; want error and no partial rows", got, err)
		}
	}
	for _, tc := range []struct{ name, input string }{
		{"garbage", "garbage"},
		{"legacy framing", "main\x1f" + sha + "\x1f0\x1frefs/heads/main\x1fsubject\x1e\n"},
		{"missing prefix", valid[1:]},
		{"extra prefix", "\x00" + valid},
		{"leading newline", "\n" + valid},
		{"extra newline", valid + "\n"},
		{"missing record newline", strings.TrimSuffix(valid, "\n")},
		{"CRLF record newline", strings.TrimSuffix(valid, "\n") + "\r\n"},
		{"extra field", framedRefFixture(append(append([]string{}, fields...), "extra")...)},
		{"missing field", framedRefFixture(fields[:4]...)},
		{"embedded subject NUL", framedRefFixture("main", sha, "1", "refs/heads/main", "real\x00forged")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reject(t, tc.input)
			reject(t, valid+tc.input)
			reject(t, tc.input+valid)
		})
	}
	for _, tc := range []struct {
		name  string
		index int
		bad   []string
	}{
		{"display name", 0, []string{"", " main", "main ", "\nmain", "main\n", "main\x1ephantom", "main\x1fforged"}},
		{"object ID", 1, []string{"", "abc123", strings.Repeat("0", 40), strings.Repeat("a", 39), strings.Repeat("a", 41), strings.Repeat("a", 63), strings.Repeat("a", 65), strings.Repeat("A", 40), strings.Repeat("g", 40), " " + sha, sha + "\n"}},
		{"timestamp", 2, []string{"not-a-time", " 1", "1 ", "1\n", "+1", "01", "-0", "1.0", "9223372036854775808", "-9223372036854775809"}},
		{"canonical ref", 3, []string{"", "main", "HEAD", "refs/", "/refs/heads/main", " refs/heads/main", "refs/heads/main ", "refs/heads/main\n", "refs/heads//main", "refs/heads/./main", "refs/heads/../main", "refs/heads/topic..name", "refs/heads/.hidden", "refs/heads/main.", "refs/heads/main.lock", "refs/heads/main.lock/topic", "refs/heads/main@{1}", "refs/heads/main~1", "refs/heads/main^", "refs/heads/main?", "refs/heads/main*", "refs/heads/main[", "refs/heads/main:topic", "refs/heads/main\\topic", "refs/heads/main\x7f", "refs/heads/main\x1ephantom", "refs/heads/main\x1fforged"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, bad := range tc.bad {
				t.Run(bad, func(t *testing.T) {
					changed := append([]string{}, fields...)
					changed[tc.index] = bad
					malformed := framedRefFixture(changed...)
					reject(t, malformed)
					reject(t, valid+malformed)
					reject(t, malformed+valid)
				})
			}
		})
	}
	// Every nonempty partial record is an error, including truncation just
	// after any field separator. No previously parsed row may escape.
	for cut := 1; cut < len(valid); cut++ {
		reject(t, valid[:cut])
		reject(t, valid+valid[:cut])
	}
}

func TestBranchFullRefProtoCompatibility(t *testing.T) {
	legacy := &gitchatv1.Branch{Name: "heads/main", Commit: "abc123", CommitterTime: 1700000000, Subject: "subject"}
	current := proto.Clone(legacy).(*gitchatv1.Branch)
	current.FullRef = "refs/heads/refs/heads/topic"
	// Build an old producer's wire payload using fixed historical numbers,
	// independently of the current generated descriptor.
	appendString := func(b []byte, n protowire.Number, s string) []byte {
		return protowire.AppendString(protowire.AppendTag(b, n, protowire.BytesType), s)
	}
	oldWire := appendString(nil, 1, legacy.Name)
	oldWire = appendString(oldWire, 2, legacy.Commit)
	oldWire = protowire.AppendVarint(protowire.AppendTag(oldWire, 3, protowire.VarintType), uint64(legacy.CommitterTime))
	oldWire = appendString(oldWire, 4, legacy.Subject)

	t.Run("field numbers", func(t *testing.T) {
		fields := current.ProtoReflect().Descriptor().Fields()
		for i, name := range []protoreflect.Name{"name", "commit", "committer_time", "subject", "full_ref"} {
			field := fields.ByName(name)
			if field == nil || field.Number() != protoreflect.FieldNumber(i+1) {
				t.Errorf("field %s: descriptor = %v, want number %d", name, field, i+1)
			}
		}
	})
	t.Run("binary roundtrip", func(t *testing.T) {
		wire, err := proto.Marshal(current)
		if err != nil {
			t.Fatal(err)
		}
		wantWire := appendString(bytes.Clone(oldWire), 5, current.FullRef)
		if !bytes.Equal(wire, wantWire) {
			t.Errorf("wire = %x, want historical fields plus field 5: %x", wire, wantWire)
		}
		var got gitchatv1.Branch
		if err := proto.Unmarshal(wire, &got); err != nil {
			t.Fatal(err)
		}
		if !proto.Equal(&got, current) {
			t.Errorf("roundtrip = %v, want %v", &got, current)
		}
	})
	t.Run("JSON roundtrip", func(t *testing.T) {
		wire, err := protojson.Marshal(current)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(wire, &fields); err != nil {
			t.Fatal(err)
		}
		if string(fields["fullRef"]) != `"refs/heads/refs/heads/topic"` {
			t.Errorf("JSON fullRef = %s", fields["fullRef"])
		}
		var got gitchatv1.Branch
		if err := protojson.Unmarshal(wire, &got); err != nil {
			t.Fatal(err)
		}
		if !proto.Equal(&got, current) {
			t.Errorf("roundtrip = %v, want %v", &got, current)
		}
	})
	t.Run("old binary payload", func(t *testing.T) {
		var got gitchatv1.Branch
		if err := proto.Unmarshal(oldWire, &got); err != nil {
			t.Fatal(err)
		}
		if !proto.Equal(&got, legacy) || got.GetFullRef() != "" {
			t.Errorf("old payload = %v, want unchanged legacy fields and empty FullRef", &got)
		}
		wire, err := proto.Marshal(&got)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(wire, oldWire) {
			t.Errorf("old payload re-encoded = %x, want %x", wire, oldWire)
		}
	})
	t.Run("old JSON payload", func(t *testing.T) {
		var got gitchatv1.Branch
		if err := protojson.Unmarshal([]byte(`{"name":"heads/main","commit":"abc123","committerTime":"1700000000","subject":"subject"}`), &got); err != nil {
			t.Fatal(err)
		}
		if !proto.Equal(&got, legacy) || got.GetFullRef() != "" {
			t.Errorf("old JSON = %v, want unchanged legacy fields and empty FullRef", &got)
		}
		wire, err := protojson.Marshal(&got)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(wire, []byte("fullRef")) {
			t.Errorf("absent fullRef should stay omitted: %s", wire)
		}
	})
}
