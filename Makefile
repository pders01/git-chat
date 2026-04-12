BINARY := dist/git-chat
GO_LDFLAGS := -s -w -X main.version=$(shell git describe --always --dirty 2>/dev/null || echo dev)
DEV_PORT ?= 18081

.PHONY: all
all: web build

.PHONY: web
web:
	cd web && bun install --frozen-lockfile && bun run build

.PHONY: build
build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(GO_LDFLAGS)" -o $(BINARY) ./cmd/git-chat

.PHONY: build-all
build-all: web build

.PHONY: run
run:
	go run ./cmd/git-chat

.PHONY: dev
# dev: one-shot hot-reload rig for iterating on the frontend while running
# the real Go backend against the current working directory.
#
#   - vite dev server (HMR, instant Lit reloads) on :5173
#   - Go server bound to :$(DEV_PORT) in local mode (default 18081), using $PWD as the repo
#   - --open-host 127.0.0.1:5173 rewrites the printed Open URL so the
#     browser lands on vite (HMR-enabled) instead of the Go server's
#     embedded static assets
#   - vite proxies /gitchat.v1.*Service/ and /api back to :8080
#
# Ctrl+C cleans up both processes via the trap on SIGINT/SIGTERM/EXIT.
dev:
	@command -v bun >/dev/null || { echo "bun not installed"; exit 1; }
	@cd web && bun install --frozen-lockfile >/dev/null
	@trap 'kill 0' SIGINT SIGTERM EXIT; \
	(cd web && bun run dev) & \
	go run ./cmd/git-chat local \
		--http 127.0.0.1:$(DEV_PORT) \
		--open-host 127.0.0.1:5173 \
		$(if $(NO_BROWSER),--no-browser) \
		.; \
	wait

.PHONY: proto
proto:
	@which buf > /dev/null 2>&1 || { echo "buf not installed — see https://buf.build/docs/cli/installation"; exit 1; }
	buf generate
	@# Freshness guard for CI: fail if gen/ or web/src/gen/ is dirty after regen
	@if [ -n "$$CI" ]; then git diff --exit-code gen/ web/src/gen/ || { echo "generated code is stale — run 'make proto' locally and commit"; exit 1; }; fi

.PHONY: check
check: check-go check-web

.PHONY: check-go
check-go:
	go vet ./...
	go test ./...

.PHONY: check-web
check-web:
	cd web && bun install --frozen-lockfile && bunx tsc --noEmit

.PHONY: test-e2e
# test-e2e builds the binary, starts a server, runs Playwright tests,
# then tears everything down. Runs both desktop (1440x900) and mobile
# (375x812) projects.
test-e2e: web build
	cd web && bunx playwright test

.PHONY: tidy
tidy:
	go mod tidy

.PHONY: clean
clean:
	rm -rf dist
	rm -rf web/node_modules web/dist web/.vite
	find internal/assets/dist -mindepth 1 ! -name 'index.html' -delete
