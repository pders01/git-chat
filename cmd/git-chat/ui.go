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
	styleBanner  = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colBrand).
			Padding(0, 2)
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

// renderOpenBanner returns a styled block advertising the URL the user
// should open in their browser. Includes the resolved revspec when set.
func renderOpenBanner(openURL, rangeSummary string) string {
	var b strings.Builder
	b.WriteString(styleHeading.Render("Open"))
	b.WriteString("  ")
	b.WriteString(styleURL.Render(openURL))
	if rangeSummary != "" {
		b.WriteString("\n")
		b.WriteString(styleDim.Render("range"))
		b.WriteString(" ")
		b.WriteString(styleBrand.Render(rangeSummary))
	}
	return "\n" + styleBanner.Render(b.String()) + "\n"
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
		{"git chat", "open current repo in browser"},
		{"git chat <path>", "open a specific repo or directory"},
		{"git chat <path> <revspec>", "open compare view pre-filled with a git range"},
		{"git chat serve [flags]", "multi-user self-hosted mode"},
		{"git chat local [path] [revspec] [flags]", "explicit solo-local mode"},
		{"git chat mcp [path]", "MCP server mode (stdio)"},
		{"git chat add-key <principal>", "append SSH pubkey from stdin"},
		{"git chat version", "print version"},
		{"git chat help", "show this help"},
	} {
		fmt.Fprintf(&b, "  %-40s %s\n", flag(line[0]), dim(line[1]))
	}

	b.WriteString("\n" + heading("flags (local / serve):") + "\n")
	for _, line := range [][2]string{
		{"--http <addr>", "listen address (default: 127.0.0.1:0)"},
		{"--llm-backend <name>", "openai (default) or anthropic"},
		{"--llm-model <name>", "model name"},
		{"--llm-api-key <key>", "API key"},
		{"--range <revspec>", "open compare view for A..B, A...B, or single ref"},
		{"                  ", "use --range=<val> if val starts with '-' (e.g. --range=-5..HEAD)"},
		{"--no-browser", "don't auto-open browser"},
	} {
		fmt.Fprintf(&b, "  %-24s %s\n", flag(line[0]), dim(line[1]))
	}

	b.WriteString("\n" + heading("examples:") + "\n")
	for _, line := range [][2]string{
		{"git chat", "chat about the repo in $PWD"},
		{"git chat ~/Projects/myproject", "open a specific repo"},
		{"git chat . HEAD~5..HEAD", "compare the last 5 commits"},
		{"git chat . main...feature", "compare feature branch against its merge-base"},
		{"git chat --range v1.0..v2.0", "compare two tags in $PWD"},
		{"git chat serve --repo ~/r1 --repo ~/r2", "multi-repo server"},
	} {
		fmt.Fprintf(&b, "  %s\n    %s\n", flag(line[0]), dim(line[1]))
	}

	return b.String()
}

// renderFatal formats a top-level CLI error.
func renderFatal(err error) string {
	return styleError.Render("git-chat:") + " " + err.Error() + "\n"
}
