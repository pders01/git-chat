BINARY := dist/git-chat
GO_LDFLAGS := -s -w -X main.version=$(shell git describe --always --dirty 2>/dev/null || echo dev)
PREFIX ?= /usr/local

.PHONY: all build build-all run proto check check-go install uninstall tidy clean

all: build

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(GO_LDFLAGS)" -o $(BINARY) ./cmd/git-chat

build-all: build

run:
	go run ./cmd/git-chat --help

proto:
	@which buf > /dev/null 2>&1 || { echo "buf not installed — see https://buf.build/docs/cli/installation"; exit 1; }
	buf generate
	@if [ -n "$$CI" ]; then git diff --exit-code gen/ || { echo "generated Go code is stale — run 'make proto' locally and commit"; exit 1; }; fi

check: check-go

check-go:
	go vet ./...
	go test ./...

install:
	@if [ ! -x $(BINARY) ]; then \
		echo "$(BINARY) not found — run 'make all' before 'sudo make install'"; \
		exit 1; \
	fi
	install -d $(DESTDIR)$(PREFIX)/bin
	install -m 0755 $(BINARY) $(DESTDIR)$(PREFIX)/bin/git-chat

uninstall:
	rm -f $(DESTDIR)$(PREFIX)/bin/git-chat

tidy:
	go mod tidy

clean:
	rm -rf dist
