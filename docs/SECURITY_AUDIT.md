# Security Audit: internal/auth Package

**Date:** 2026-04-14 (initial), updated 2026-04-14  
**Scope:** Authentication, authorization, session management, SSH pairing  

---

## 1. Executive Summary

| Component | Risk Level | Test Coverage | Status |
|-----------|------------|---------------|--------|
| Session Management | Low | Yes (sessions_test.go) | ✅ Cookie security + rotation |
| SSH Pairing | Low | Partial | ✅ Race conditions fixed |
| AllowedSigners | Low | Yes (allowed_signers_test.go) | ✅ Tested |
| Auth Interceptor | Low | Yes (interceptor_test.go) | ✅ Tested |
| SSH Server | Medium | No | ⚠️ No unit tests for SSH middleware |
| Logout | Low | Yes (service_logout_test.go) | ✅ Server-side session invalidated |

**Overall Risk: LOW** — security-critical paths are tested and hardened.

---

## 2. Detailed Findings

### 2.1 Session Management (sessions.go, middleware.go)

**Strengths:**
- ✅ HttpOnly cookies prevent XSS theft
- ✅ SameSite=Strict prevents CSRF
- ✅ Secure flag configurable (disabled for HTTP/local mode)
- ✅ 32-byte random tokens (256 bits entropy)
- ✅ Lazy expiry cleanup on lookup
- ✅ Session TTL configurable via GITCHAT_SESSION_TTL
- ✅ **Session rotation** after 50% of TTL on every request (middleware.go)
- ✅ **Logout invalidates server-side session** via Sessions.Delete()

**Remaining concerns:**
- ⚠️ **In-memory only** — sessions lost on restart (documented, acceptable for local use)
- ⚠️ **No absolute session timeout** — sliding window only

**Note on Get() RLock→Lock upgrade:** The double-delete from a concurrent goroutine observing the same expired session is a no-op in Go maps, so this is benign.

### 2.2 SSH Pairing (pairing.go)

**Strengths:**
- ✅ 16-word dictionary + 4-digit = ~40 bits entropy per code
- ✅ 60-second TTL on pairing attempts
- ✅ 30-second claim window after completion
- ✅ Single-use claim tokens (24 bytes = 192 bits)
- ✅ crypto/rand used (not math/rand)
- ✅ **Lock released before channel send/close** in both Complete() and expire()
- ✅ **randIndex falls back to 0 on crypto/rand failure** (degraded but non-crashing)

**Remaining concerns:**
- ⚠️ **No rate limiting** — 100 attempts to generate unique code, then fails
- ⚠️ **No connection rate limiting** on SSH server

### 2.3 AllowedSigners (allowed_signers.go)

**Test coverage:** allowed_signers_test.go — valid parsing, invalid parsing, missing file, concurrent access, empty input, comments/blanks.

**Remaining concerns:**
- ⚠️ **No key normalization** — different formats for same key not handled
- ⚠️ **No key expiration** — once added, keys are valid forever
- ⚠️ **File permissions not validated** on load

### 2.4 Auth Interceptor (interceptor.go)

**Test coverage:** interceptor_test.go — unauthenticated rejection, authenticated pass-through, streaming handler, client wrapper.

- ✅ Correctly handles both unary and streaming RPCs
- ✅ Uses connect.CodeUnauthenticated

### 2.5 SSH Server (ssh.go)

**Status: No unit tests** (integration-tested only via e2e pairing flow)

- ✅ Only accepts `pair <CODE>` command; rejects shell/PTY
- ✅ Host key at `$XDG_CONFIG_HOME/git-chat/host_ed25519`
- ⚠️ **Host key permissions not validated** (should be 0o600)
- ⚠️ **No connection rate limiting**

### 2.6 Local Tokens (local.go)

- ✅ Single token, 60-second TTL, single-use
- ✅ 32-byte random (256 bits entropy)
- ✅ Thread-safe with mutex

---

## 3. Recommendations

### Short-term

1. **Add unit tests for SSH middleware** (ssh.go) — the only untested security path
2. **Add absolute session timeout** — force re-auth after 24h regardless of activity
3. **Add key revocation** — support removing keys from allowed_signers

### Long-term

4. **Persistent sessions** — store sessions in SQLite (not just in-memory)
5. **Rate limiting** — per-IP and per-principal attempt limits
6. **MFA support** — TOTP or WebAuthn for additional verification
