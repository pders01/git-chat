package main

import (
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/log"
)

var (
	colBrand   = lipgloss.AdaptiveColor{Light: "#7D56F4", Dark: "#B599FF"}
	colAccent  = lipgloss.AdaptiveColor{Light: "#00A67D", Dark: "#4AE3B5"}
	colDim     = lipgloss.AdaptiveColor{Light: "#6B7280", Dark: "#9CA3AF"}
	colErrFg   = lipgloss.AdaptiveColor{Light: "#B91C1C", Dark: "#FCA5A5"}
	colHeading = lipgloss.AdaptiveColor{Light: "#111827", Dark: "#F3F4F6"}

	styleBrand   = lipgloss.NewStyle().Foreground(colBrand).Bold(true)
	styleHeading = lipgloss.NewStyle().Foreground(colHeading).Bold(true)
	styleDim     = lipgloss.NewStyle().Foreground(colDim)
	styleURL     = lipgloss.NewStyle().Foreground(colAccent).Underline(true)
	styleError   = lipgloss.NewStyle().Foreground(colErrFg).Bold(true)
	styleFlag    = lipgloss.NewStyle().Foreground(colBrand)
)

// installLogger wires charmbracelet/log as the global slog default. Level
// names: "debug", "info", "warn", "error". All existing slog.* call sites
// keep working unchanged.
func installLogger(w io.Writer, level string) {
	lvl := log.InfoLevel
	switch strings.ToLower(level) {
	case "debug":
		lvl = log.DebugLevel
	case "warn", "warning":
		lvl = log.WarnLevel
	case "error":
		lvl = log.ErrorLevel
	}
	h := log.NewWithOptions(w, log.Options{
		ReportTimestamp: true,
		TimeFormat:      time.Kitchen,
		Level:           lvl,
		Prefix:          "git-chat",
	})
	slog.SetDefault(slog.New(h))
}

// renderUsage returns the styled help text for `git chat --help`.
func renderUsage() string {
	heading := func(s string) string { return styleHeading.Render(s) }
	flag := func(s string) string { return styleFlag.Render(s) }
	dim := func(s string) string { return styleDim.Render(s) }

	var b strings.Builder
	b.WriteString(styleBrand.Render("git-chat") + dim(" — chat with a git repo, with a self-curated knowledge base.") + "\n\n")

	b.WriteString(heading("usage:") + "\n")
	for _, line := range [][2]string{
		{"git chat chat [flags] <message>", "one-shot terminal chat"},
		{"git chat mcp [path]", "MCP server mode (stdio)"},
		{"git chat local [path] [flags]", "loopback Connect API"},
		{"git chat serve [flags]", "multi-user Connect API"},
		{"git chat add-key <principal>", "append SSH pubkey from stdin"},
		{"git chat remove-key <principal>", "revoke a principal's SSH key"},
		{"git chat list-keys", "show registered principals"},
		{"git chat version", "print version"},
		{"git chat help", "show this help"},
	} {
		fmt.Fprintf(&b, "  %-40s %s\n", flag(line[0]), dim(line[1]))
	}

	b.WriteString("\n" + heading("common flags:") + "\n")
	for _, line := range [][2]string{
		{"--http <addr>", "API listen address"},
		{"--repo <path>", "repository path (repeatable in server modes)"},
		{"--llm-backend <name>", "openai (default) or anthropic"},
		{"--llm-model <name>", "model name"},
		{"--llm-api-key <key>", "API key"},
	} {
		fmt.Fprintf(&b, "  %-24s %s\n", flag(line[0]), dim(line[1]))
	}

	b.WriteString("\n" + heading("examples:") + "\n")
	for _, line := range [][2]string{
		{"git chat chat \"summarize this repository\"", "run one terminal turn"},
		{"git chat mcp .", "serve repository tools over stdio"},
		{"git chat local .", "start a loopback API and print a claim token"},
		{"git chat serve --repo ~/r1 --repo ~/r2", "start a multi-repository API"},
	} {
		fmt.Fprintf(&b, "  %s\n    %s\n", flag(line[0]), dim(line[1]))
	}

	return b.String()
}

// renderFatal formats a top-level CLI error.
func renderFatal(err error) string {
	return styleError.Render("git-chat:") + " " + err.Error() + "\n"
}
