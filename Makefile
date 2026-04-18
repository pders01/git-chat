BINARY := dist/git-chat
GO_LDFLAGS := -s -w -X main.version=$(shell git describe --always --dirty 2>/dev/null || echo dev)
DEV_PORT ?= 18081
PREFIX ?= /usr/local

.PHONY: all
all: web build

.PHONY: web
web:
	@if [ "$$(id -u)" = "0" ]; then \
		echo "refusing to build web assets as root — bun would write internal/assets/dist/* owned by root, breaking later non-sudo rebuilds"; \
		echo "hint: run 'make all' as your user first, then 'sudo make install'"; \
		exit 1; \
	fi
	# Pre-clean vite output but preserve .gitkeep (required by //go:embed
	# on fresh clones). vite.config.ts has emptyOutDir: false.
	find internal/assets/dist -mindepth 1 ! -name '.gitkeep' -exec rm -rf {} +
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
	cd web && bun install --frozen-lockfile && bun run check && bun run lint && bun run fmt:check

.PHONY: test-e2e
# test-e2e builds the binary, starts a server, runs Playwright tests,
# then tears everything down. Runs both desktop (1440x900) and mobile
# (375x812) projects.
test-e2e: web build
	cd web && bunx playwright test

.PHONY: install
# install only copies the already-built binary. Intentionally does NOT
# depend on `all` so that `sudo make install` never runs `bun run build`
# as root (which would leave internal/assets/dist/* owned by root and
# break later non-sudo rebuilds). Build first with `make all`.
install:
	@if [ ! -x $(BINARY) ]; then \
		echo "$(BINARY) not found — run 'make all' (as your user) before 'sudo make install'"; \
		exit 1; \
	fi
	install -d $(DESTDIR)$(PREFIX)/bin
	install -m 0755 $(BINARY) $(DESTDIR)$(PREFIX)/bin/git-chat

.PHONY: uninstall
uninstall:
	rm -f $(DESTDIR)$(PREFIX)/bin/git-chat

.PHONY: tidy
tidy:
	go mod tidy

.PHONY: clean
clean:
	rm -rf dist
	rm -rf web/node_modules web/dist web/.vite
	find internal/assets/dist -mindepth 1 ! -name 'index.html' -delete
