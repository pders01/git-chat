package llm

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseHermesToolCalls(t *testing.T) {
	raw := `Let me read the file.
<tool_call>
<function=read_file>
<parameter=path>
internal/chat/service.go
</parameter>
</function>
</tool_call>
And then I will summarise.`

	chunks := parseHermesToolCalls(raw)
	if len(chunks) != 1 {
		t.Fatalf("want 1 chunk, got %d", len(chunks))
	}
	c := chunks[0]
	if c.Kind != ChunkToolUse {
		t.Fatalf("kind = %v, want ChunkToolUse", c.Kind)
	}
	if c.ToolName != "read_file" {
		t.Fatalf("name = %q", c.ToolName)
	}
	var args map[string]any
	if err := json.Unmarshal(c.ToolArgs, &args); err != nil {
		t.Fatalf("args json: %v", err)
	}
	if args["path"] != "internal/chat/service.go" {
		t.Fatalf("path = %v", args["path"])
	}
}

func TestParseHermesToolCallsMultiple(t *testing.T) {
	raw := `<tool_call><function=a><parameter=x>1</parameter></function></tool_call>
<tool_call><function=b><parameter=y>"hi"</parameter></function></tool_call>`
	chunks := parseHermesToolCalls(raw)
	if len(chunks) != 2 {
		t.Fatalf("want 2, got %d", len(chunks))
	}
	if chunks[0].ToolName != "a" || chunks[1].ToolName != "b" {
		t.Fatalf("names: %q %q", chunks[0].ToolName, chunks[1].ToolName)
	}
	// numeric value should round-trip as number
	if !strings.Contains(string(chunks[0].ToolArgs), `"x":1`) {
		t.Fatalf("want numeric x, got %s", chunks[0].ToolArgs)
	}
	// quoted string should survive as string
	if !strings.Contains(string(chunks[1].ToolArgs), `"y":"hi"`) {
		t.Fatalf("want string y, got %s", chunks[1].ToolArgs)
	}
}

func TestParseHermesToolCallsNone(t *testing.T) {
	if got := parseHermesToolCalls("no xml here"); len(got) != 0 {
		t.Fatalf("want 0, got %d", len(got))
	}
}
