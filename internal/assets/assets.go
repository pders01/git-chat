// Package assets serves the embedded Lit SPA bundle.
//
// Two filesystems are embedded:
//
//   - stub/ holds a small always-committed index.html shown when the
//     vite output is missing (fresh clone before `make all`).
//   - dist/ holds the real vite output. Fully gitignored except for
//     a .gitkeep sentinel that satisfies //go:embed's "pattern must
//     match at least one file" rule on fresh clones.
//
// DistFS picks at runtime: dist/ if it has an index.html, else stub/.
// The `all:` prefix on dist/ includes dotfiles (.vite metadata,
// .gitkeep).
package assets

import (
	"embed"
	"io/fs"
)

//go:embed stub
var stubFS embed.FS

//go:embed all:dist
var distFS embed.FS

// DistFS returns the SPA filesystem to serve at /. Prefers the real
// vite build; falls back to the stub so `go build` + `go run` on a
// fresh clone produces a working binary with a helpful message.
func DistFS() fs.FS {
	if distHasIndex() {
		sub, err := fs.Sub(distFS, "dist")
		if err == nil {
			return sub
		}
	}
	sub, _ := fs.Sub(stubFS, "stub")
	return sub
}

func distHasIndex() bool {
	f, err := distFS.Open("dist/index.html")
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}
