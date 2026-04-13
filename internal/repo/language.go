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
	".clj":        "clojure",
	".cpp":        "cpp",
	".cr":         "crystal",
	".cs":         "csharp",
	".css":        "css",
	".csv":        "csv",
	".diff":       "diff",
	".dockerfile": "dockerfile",
	".edn":        "clojure",
	".env":        "dotenv",
	".ex":         "elixir",
	".exs":        "elixir",
	".fish":       "fish",
	".fs":         "fsharp",
	".fsx":        "fsharp",
	".glsl":       "glsl",
	".go":         "go",
	".graphql":    "graphql",
	".gql":        "graphql",
	".h":          "c",
	".hpp":        "cpp",
	".hs":         "haskell",
	".hcl":        "hcl",
	".html":       "html",
	".ini":        "ini",
	".java":       "java",
	".jl":         "julia",
	".js":         "javascript",
	".json":       "json",
	".json5":      "json5",
	".jsx":        "jsx",
	".kt":         "kotlin",
	".lua":        "lua",
	".md":         "markdown",
	".mjs":        "javascript",
	".nim":        "nim",
	".nix":        "nix",
	".nu":         "nushell",
	".ml":         "ocaml",
	".mli":        "ocaml",
	".perl":       "perl",
	".php":        "php",
	".pl":         "perl",
	".pm":         "perl",
	".proto":      "proto",
	".ps1":        "powershell",
	".psm1":       "powershell",
	".py":         "python",
	".rb":         "ruby",
	".rs":         "rust",
	".scala":      "scala",
	".sh":         "shellscript",
	".sql":        "sql",
	".svelte":     "svelte",
	".swift":      "swift",
	".tf":         "hcl",
	".tfvars":     "hcl",
	".toml":       "toml",
	".ts":         "typescript",
	".tsx":        "tsx",
	".v":          "v",
	".vue":        "vue",
	".wgsl":       "wgsl",
	".xml":        "xml",
	".yaml":       "yaml",
	".yml":        "yaml",
	".zig":        "zig",
}

// specialBasenames catches extension-less files whose name implies a grammar.
var specialBasenames = map[string]string{
	"dockerfile": "dockerfile",
	"env":        "dotenv",
	"makefile":   "makefile",
	"justfile":   "makefile",
	"nginx.conf": "nginx",
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
