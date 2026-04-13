# Security Audit: internal/auth Package

**Date:** 2026-04-14  
**Scope:** Authentication, authorization, session management, SSH pairing  
**Coverage:** 45.3% (target: 80%+ for security-critical code)

---

## 1. Executive Summary

| Component | Risk Level | Coverage | Status |
|-----------|------------|----------|--------|
| Session Management | Low | 54.5% | ✅ Good cookie security |
| SSH Pairing | Medium | 65-83% | ⚠️ Race conditions possible |
| AllowedSigners | **High** | **0%** | ❌ Critical gap - no tests |
| Auth Interceptor | **High** | **0%** | ❌ Critical gap - no tests |
| SSH Server | **High** | **0%** | ❌ Critical gap - no tests |

**Overall Risk: MEDIUM-HIGH** due to lack of testing for security-critical paths.

---

## 2. Detailed Findings

### 2.1 Session Management (sessions.go)

**Strengths:**
- ✅ HttpOnly cookies prevent XSS theft
- ✅ SameSite=Strict prevents CSRF
- ✅ Secure flag configurable (disabled for HTTP/local mode)
- ✅ 32-byte random tokens (256 bits entropy)
- ✅ Lazy expiry cleanup on lookup
- ✅ Session TTL configurable via GITCHAT_SESSION_TTL

**Concerns:**
- ⚠️ **In-memory only** - sessions lost on restart (documented, but impacts availability)
- ⚠️ **No session rotation** - same token for entire TTL (7 days default)
- ⚠️ **No absolute session timeout** - sliding window only

**Code Quality:**
```go
// Lines 71-88: Get() has race condition between RUnlock and Lock
if time.Now().After(sess.ExpiresAt) {
    s.mu.Lock()  // Re-acquire lock after releasing RLock
    delete(s.byToken, token)
    s.mu.Unlock()
    return nil
}
```
This is correctly handled (double-check after re-lock would be safer but not strictly necessary due to single-writer).

### 2.2 SSH Pairing (pairing.go)

**Strengths:**
- ✅ 16-word dictionary + 4-digit = ~40 bits entropy per code
- ✅ 60-second TTL on pairing attempts
- ✅ 30-second claim window after completion
- ✅ Single-use claim tokens (24 bytes = 192 bits)
- ✅ crypto/rand used (not math/rand)

**Concerns:**
- ⚠️ **Race condition in Complete()**: Lines 121-166 - Lock held during channel send
- ⚠️ **Race condition in expire()**: Line 185 - Lock held during channel operations
- ⚠️ **Panic on rand failure**: Line 214 - randIndex panics (should return error)
- ⚠️ **No rate limiting**: 100 attempts to generate unique code, then fails
- ⚠️ **Code reuse**: After failed pairing, code could be guessed and reused

**Security Risk: MEDIUM**
The pairing code is single-use but there's a window between Complete and Claim where a man-in-the-browser could steal the claim token.

### 2.3 AllowedSigners (allowed_signers.go)

**Status: CRITICAL GAP - 0% Test Coverage**

**Functionality:**
- Parses OpenSSH allowed_signers format
- Maps SSH public keys to principals
- Thread-safe with RWMutex

**Security Concerns:**
- ⚠️ **No key normalization** - Different key formats for same key not handled
- ⚠️ **No key expiration** - Once added, keys are valid forever
- ⚠️ **No key revocation audit log**
- ⚠️ **File permissions not validated** on load (expected 0o600)

**Testing Gap:**
- File parsing with various edge cases
- Concurrent Lookup during Append
- Error handling for malformed entries

### 2.4 Auth Interceptor (interceptor.go)

**Status: CRITICAL GAP - 0% Test Coverage**

**Functionality:**
- Rejects requests without principal in context
- Applied to all services except AuthService

**Security Concerns:**
- ⚠️ **Error message disclosure**: "authentication required" is fine, but could be more generic
- ✅ Correctly handles both unary and streaming RPCs
- ✅ Uses connect.CodeUnauthenticated (correct gRPC status)

### 2.5 SSH Server (ssh.go)

**Status: CRITICAL GAP - 0% Test Coverage**

**Security Model:**
- Only accepts `pair <CODE>` command
- All other commands, shell, PTY requests rejected
- Host key at ~/.config/git-chat/host_ed25519

**Security Concerns:**
- ⚠️ **Host key permissions not validated** (should be 0o600)
- ⚠️ **SSH banner reveals software**: "wish" middleware adds version info
- ⚠️ **No connection rate limiting**
- ⚠️ **No failed authentication logging**
- ✅ Command parsing is strict (exactly 2 args required)

### 2.6 Local Tokens (local.go)

**Security Model:**
- Single token, 60-second TTL
- Single-use (consumed on claim)
- 32-byte random (256 bits entropy)

**Concerns:**
- ⚠️ **Mint replaces token without warning** - Old token invalidated immediately
- ✅ Correctly rejects expired tokens
- ✅ Thread-safe with mutex

---

## 3. Test Coverage Plan

### Priority 1: Security Critical (0% coverage)

| File | Functions | Lines | Test Strategy |
|------|-----------|-------|---------------|
| allowed_signers.go | All | 114 | Unit tests with temp files |
| interceptor.go | All | 45 | Mock context tests |
| ssh.go | pairExecMiddleware | 70 | Middleware unit tests |

### Priority 2: Important for Correctness

| File | Functions | Lines | Test Strategy |
|------|-----------|-------|---------------|
| pairing.go | expire | 25 | Mock time.AfterFunc |
| sessions.go | Delete, SetCookie, ClearCookie | 30 | Cookie validation tests |
| service.go | Logout | 15 | Full flow test |

---

## 4. Recommendations

### Immediate (High Priority)

1. **Add tests for allowed_signers.go** - Security-critical file parsing
2. **Add tests for interceptor.go** - Gatekeeper for all authenticated RPCs
3. **Add tests for SSH middleware** - Entry point for multi-user auth
4. **Fix race conditions in pairing.go** - Move channel ops outside locks

### Short-term (Medium Priority)

5. **Add session rotation** - Issue new token periodically
6. **Add absolute session timeout** - Force re-auth after 24h regardless of activity
7. **Add key revocation** - Support removing keys from allowed_signers
8. **Add audit logging** - Log all authentication events

### Long-term (Low Priority)

9. **Persistent sessions** - Store sessions in SQLite (not just in-memory)
10. **MFA support** - TOTP or WebAuthn for additional verification
11. **Rate limiting** - Per-IP and per-principal attempt limits

---

## 5. Security Test Cases to Add

### allowed_signers_test.go
- Parse valid and invalid entries
- Concurrent read during write
- File permission validation
- Key lookup by different formats

### interceptor_test.go
- Request with valid principal passes
- Request without principal rejected
- Request with wrong context type handled

### pairing_security_test.go
- TTL expiry works correctly
- Single-use enforcement
- Race condition test (concurrent Complete/Claim)
- Code collision handling

### ssh_middleware_test.go
- pair command accepted
- shell rejected
- PTY rejected
- invalid commands rejected
- missing principal handled

---

**Next Steps:**
1. Implement test coverage for Priority 1 items
2. Address race conditions in pairing.go
3. Add integration tests for full auth flows
