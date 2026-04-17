package llm

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestBuildUserBlocksTextOnly(t *testing.T) {
	blocks := buildUserBlocks(Message{Role: RoleUser, Content: "hello"})
	if len(blocks) != 1 {
		t.Fatalf("want 1 block, got %d", len(blocks))
	}
}

func TestBuildUserBlocksImageAndText(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}
	blocks := buildUserBlocks(Message{
		Role:    RoleUser,
		Content: "what is this",
		Attachments: []Attachment{
			{MimeType: "image/png", Filename: "shot.png", Data: png},
		},
	})
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks (image + text), got %d", len(blocks))
	}
	// Serialize and sanity-check the image source carries our payload.
	data, err := blocks[0].MarshalJSON()
	if err != nil {
		t.Fatalf("marshal image block: %v", err)
	}
	enc := base64.StdEncoding.EncodeToString(png)
	if !strings.Contains(string(data), enc) {
		t.Fatalf("image block JSON missing base64 payload\n%s", data)
	}
}

func TestBuildUserBlocksTextAttachmentFolded(t *testing.T) {
	blocks := buildUserBlocks(Message{
		Role:    RoleUser,
		Content: "review this",
		Attachments: []Attachment{
			{MimeType: "text/plain", Filename: "notes.txt", Data: []byte("line one")},
		},
	})
	if len(blocks) != 1 {
		t.Fatalf("text-only fold should collapse to 1 block, got %d", len(blocks))
	}
	data, _ := blocks[0].MarshalJSON()
	s := string(data)
	if !strings.Contains(s, "notes.txt") || !strings.Contains(s, "line one") ||
		!strings.Contains(s, "review this") {
		t.Fatalf("folded text missing pieces: %s", s)
	}
}
