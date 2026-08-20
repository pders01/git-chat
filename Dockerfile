FROM golang:1.25-alpine AS build
RUN apk add --no-cache git
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /git-chat ./cmd/git-chat

FROM alpine:3.21
RUN apk add --no-cache ca-certificates git
COPY --from=build /git-chat /usr/local/bin/git-chat

EXPOSE 8080 2222
VOLUME /data
ENV GITCHAT_DB=/data/state.db
ENTRYPOINT ["git-chat"]
CMD ["serve", "--http", "0.0.0.0:8080", "--ssh", "0.0.0.0:2222", "--db", "/data/state.db"]
