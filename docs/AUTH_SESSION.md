# Auth session & refresh (login idle)

Feature docs for WorkBench **username/password session**: access + refresh tokens, idle tab, and when the UI may force logout.

Related: [NOTES.md](./NOTES.md) (API table) · [DEPLOY.md](./DEPLOY.md) (TTL on deploy).

---

## Goal / expected behavior

| Situation | Expected |
|-----------|----------|
| Access token expired, **refresh still valid** | Silent `POST /api/auth/refresh` → new access; **stay signed in** (no `/login`) |
| Tab idle hours / overnight (within refresh TTL) | Wake / next API / SSE reconnect → refresh; **do not** kick to login |
| Both access **and** refresh invalid/expired, or refresh returns hard **401** | Clear session → `/login` |
| User signs in again after kick | Navigate to app home; **must not** stay stuck on login after “success” toast |
| Transient network / 5xx during refresh | **Do not** logout; keep refresh token; retry later |

**Product rule (from QA):** logout **only** when refresh cannot renew the session (expired/revoked/invalid). Expiry of access alone is normal and must not equal “logged out”.

---

## Scope

**In**

- Web session bootstrap after reload / long idle
- HTTP 401 → single-flight refresh → retry
- SSE reconnect auth
- Login success vs race with stale refresh/`clearAuth`
- Server refresh session store (Mongo)

**Out (this doc)**

- GitLab PAT for BA Create issue (separate credential)
- Cursor API key
- Changing TTL values unless implement plan says so

---

## Current vs reported bug

**Reported (still open after prior race fix):**

1. Leave the app open a long time → UI dumps to **login**.
2. Click login again → success message but **stuck on login** (or session immediately cleared).

**Prior mitigation already in tree (context):**

- Clear session only if failed refresh matches the **current** refresh token (ignore stale clear after re-login).
- Cancel / invalidate in-flight refresh on login / clear.
- Bootstrap: logout on hard auth failure / missing refresh — **not** on transient network alone.
- Toast “Signed in” after navigate off `/login`.

**Gap to close:** idle still kicks to login too early, or re-login still races — behavior must match the table above.

---

## Token model

| Token | Typical TTL (code) | Storage |
|-------|--------------------|---------|
| Access | `ACCESS_TTL_SEC` in `apps/api/src/auth/tokens.ts` (**2h** as of docs write; older NOTES said ~10m — treat code as source of truth) | Memory only (web) |
| Refresh | `REFRESH_TTL_SEC` = **30 days** | Persisted client + Mongo `auth_refresh_sessions` |

API:

| Method | Path | Role |
|--------|------|------|
| POST | `/api/auth/login` | Issue access + refresh |
| POST | `/api/auth/refresh` | Exchange refresh → new access (reuse refresh session; avoid rotate races) |
| POST | `/api/auth/logout` | Revoke refresh |

---

## Code map

| Area | Path | Notes |
|------|------|--------|
| TTL / JWT pair | `apps/api/src/auth/tokens.ts` | `ACCESS_TTL_SEC`, `REFRESH_TTL_SEC` |
| Refresh sessions Mongo | `apps/api/src/auth/sessions.ts` | Collection `auth_refresh_sessions` |
| Auth module | `apps/api/src/modules/auth/index.ts` | `login`, `refreshAuthTokens`, `logout` |
| Token storage (web) | `apps/web/src/api/tokenStorage.ts` | Persist refresh; access in memory |
| HTTP refresh / clear | `apps/web/src/api/http.ts` | Single-flight refresh; `clearAuthAndNotify` token-guard |
| Auth store | `apps/web/src/stores/auth.ts` | `refresh()`, `clearLocal()`, login apply |
| Bootstrap / session | `apps/web/src/stores/session.ts` | `bootstrap()` — refresh then `/api/me` |
| Login UI / navigate | Login view + router guards (web) | Must not toast success before leave `/login` |

---

## Risks & assumptions

- **Assumption:** “Để lâu” = browser tab idle hours (not necessarily refresh TTL 30d elapsed).
- **Assumption:** Kick is from client `logout` / `clearAuth` / router, not server wiping all sessions.
- Access TTL in older docs (~10m) may disagree with code (2h) — align docs + product copy when implementing.
- SSE + many parallel 401s still need single-flight refresh; regressions here reintroduce race after login.
- Hardening must **not** keep a dead refresh forever: true 401 from `/api/auth/refresh` still clears session.

---

## Implement plan (next code phase — do not implement in docs phase)

1. **Reproduce:** idle tab past access TTL (and optionally throttle network); confirm whether kick is bootstrap, HTTP interceptor, or SSE.
2. **Audit logout call sites:** `session.bootstrap`, `http.clearAuthAndNotify`, `auth.refresh` 401 path, router — ensure each only clears when refresh is gone or server 401 on refresh.
3. **Re-login stuck:** verify in-flight refresh / SSE cannot clear tokens issued by the new login; ensure post-login navigation runs before any global “session expired” handler.
4. **Tests:** unit/integration for (a) access expired + valid refresh → stay in; (b) refresh 401 → login; (c) login during failing refresh → new session wins.
5. **Docs sync:** update NOTES/DEPLOY TTL lines to match `tokens.ts` after any change.

---

## Acceptance (QA)

- [ ] Idle within refresh TTL → no forced `/login`; next action works after silent refresh.
- [ ] Refresh expired/revoked → `/login` once; login succeeds and leaves login screen.
- [ ] Access-only expiry never shows as “logged out” while refresh remains valid.
- [ ] No success toast while still on `/login` with empty session.
