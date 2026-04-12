# Multi-stage build: frontend → Go binary → minimal runtime image.
# Result is a ~25 MB image with zero runtime dependencies.

# ── Stage 1: frontend build ─────────────────────────────────
FROM oven/bun:1.2 AS frontend
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ .
COPY internal/assets/dist/index.html ../internal/assets/dist/index.html
RUN bun run build

# ── Stage 2: Go build ───────────────────────────────────────
FROM golang:1.24-alpine AS backend
RUN apk add --no-cache git
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /app/internal/assets/dist/ internal/assets/dist/
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /git-chat ./cmd/git-chat

# ── Stage 3: runtime ────────────────────────────────────────
FROM alpine:3.21
RUN apk add --no-cache ca-certificates git
COPY --from=backend /git-chat /usr/local/bin/git-chat

EXPOSE 8080 2222
VOLUME /data

ENV GITCHAT_DB=/data/state.db

ENTRYPOINT ["git-chat"]
CMD ["serve", "--http", "0.0.0.0:8080", "--ssh", "0.0.0.0:2222", "--db", "/data/state.db"]
