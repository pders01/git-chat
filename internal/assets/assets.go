// Package assets holds the embedded Lit SPA bundle.
//
// The `all:` prefix includes dotfiles (e.g. .vite metadata) in the embed.
// The dist/ directory must contain at least one file at compile time; we
// commit a stub index.html so `go build` works on a fresh clone before
// `bun run build` has ever run.
package assets

import "embed"

//go:embed all:dist
var DistFS embed.FS
