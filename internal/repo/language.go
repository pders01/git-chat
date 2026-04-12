package repo

import (
	"path/filepath"
	"strings"
)

// languageByExt maps a lowercase file extension (leading dot included) to
// the Shiki grammar name. Keep the list in alphabetical order by extension.
var languageByExt = map[string]string{
	".c":          "c",
	".cc":         "cpp",
	".cpp":        "cpp",
	".cs":         "csharp",
	".css":        "css",
	".diff":       "diff",
	".dockerfile": "dockerfile",
	".go":         "go",
	".h":          "c",
	".hpp":        "cpp",
	".html":       "html",
	".java":       "java",
	".js":         "javascript",
	".json":       "json",
	".jsx":        "jsx",
	".kt":         "kotlin",
	".lua":        "lua",
	".md":         "markdown",
	".mjs":        "javascript",
	".php":        "php",
	".proto":      "proto",
	".py":         "python",
	".rb":         "ruby",
	".rs":         "rust",
	".scala":      "scala",
	".sh":         "shellscript",
	".sql":        "sql",
	".svelte":     "svelte",
	".swift":      "swift",
	".toml":       "toml",
	".ts":         "typescript",
	".tsx":        "tsx",
	".vue":        "vue",
	".xml":        "xml",
	".yaml":       "yaml",
	".yml":        "yaml",
	".zig":        "zig",
}

// specialBasenames catches extension-less files whose name implies a grammar.
var specialBasenames = map[string]string{
	"dockerfile": "dockerfile",
	"makefile":   "makefile",
	"justfile":   "makefile",
}

// LanguageForPath returns the Shiki grammar name for a repository file
// path, or the empty string if none applies. The empty string tells the
// frontend to skip highlighting and render as plain text.
func LanguageForPath(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if lang, ok := languageByExt[ext]; ok {
		return lang
	}
	base := strings.ToLower(filepath.Base(path))
	if lang, ok := specialBasenames[base]; ok {
		return lang
	}
	return ""
}
