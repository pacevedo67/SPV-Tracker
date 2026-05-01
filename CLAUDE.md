# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — runs the server (`node server.js`). `npm run dev` is identical; there is no separate dev mode, no build step, and no test suite.
- Default port is `3030` (override with `PORT`). The server logs warnings on startup if `JWT_SECRET` or SMTP env vars are missing.
- Health check: `GET /api/health` (used by Render).

## Architecture

Single-process Express 5 server. Backend is `server.js` (~980 lines, all routes inline). Persistence is `better-sqlite3` via `database.js`. Frontend is plain HTML/JS in `public/` (no framework, no bundler) — pages are served as static files with `Cache-Control: no-cache` on HTML and JS so browsers always pull fresh code after a deploy.

### Multi-tenancy

Every domain table (`matters`, `investor_contacts`, `invitations` indirectly, etc.) is scoped by `firm_id`. Users belong to a `firm` and have role `admin` or `user`. **All firm-scoped queries must filter on `firm_id` from the JWT** — `req.user.firmId` for the cookie/JWT path, `req.currentUser.firm_id` after `requireAdmin`. Skipping that filter is a cross-tenant data leak.

The investor side mirrors this pattern: `investor_users` belong to an `investor_account`. Investor-scoped queries should filter on `req.investor.investorAccountId`. The `firms` and `investor_accounts` tables are completely independent — they don't reference each other directly. Cross-firm portability (Step 3 in `ROADMAP.md`) will introduce a `certification_access_grants` join table to connect them.

### Three auth systems coexist

1. **Firm-user JWT** in `auth_token` HttpOnly cookie (7-day expiry, falls back to `Authorization: Bearer`). Tokens carry `jti`; logout inserts the `jti` into `token_denylist` and that table is checked on every verify. Middleware: `requireAuth`, `requireAdmin`, `optionalAuth`.
2. **Investor JWT** in `investor_token` HttpOnly cookie (also 7 days, also denylist-revocable, falls back to `Authorization: Investor <token>`). Carries `type: 'investor'`, `investorUserId`, `investorAccountId`, `role` (`admin` | `designee`). Middleware: `requireInvestorAuth`, `requireInvestorAdmin`. The cookie name is intentionally separate from `auth_token` so a single browser can hold both a firm session and an investor session simultaneously, and so existing `requireAuth` did not need to learn about a second token type.
3. **express-session for anonymous investor guests.** When an investor clicks `/q/:token`, the server creates/loads a `questionnaire_submissions` row, stores `guestToken` / `guestSubId` / `guestContactName` in the session, and redirects to `/questionnaire.html?id=…&guest=1`. The `requireGuestOrAuth` middleware accepts either a firm-user JWT or a session whose `guestSubId` matches the requested submission. The session cookie is short-lived (4h). Investor JWTs are *not* yet integrated into this flow — Step 2 of `ROADMAP.md` will pre-populate signed-in investors' submissions from their profile.

`/api/submissions/:id` and `PUT /api/submissions/:id` use `optionalAuth` and dispatch on whether the caller is a firm user (full access within their firm) or a matching guest (only the one submission they were invited to).

### Cross-app SSO

`POST /api/auth/exchange` accepts a JWT from sister apps (`LB_URL` Leaderboard, `DT_URL` DealTracker), verifies it by calling `${app}/api/auth/me` with the bearer token, and — if valid — auto-creates the user/firm on first sign-in and issues an SPV Tracker JWT. `/api/auth/me` is exposed for the same purpose in the other direction.

### Database

`database.js` creates all tables with `CREATE TABLE IF NOT EXISTS` and runs an idempotent `migrations` array (each `ALTER TABLE` wrapped in try/catch — duplicate-column errors are swallowed). **To add a column, append an `ALTER TABLE` to that array; do not edit the `CREATE TABLE` for an existing table** (existing deployments already have it). WAL mode is on. DB path is `./questionnaire.db` locally, `/data/questionnaire.db` on Render (controlled by `DATABASE_PATH` / `RENDER` env).

Seeding logic at the bottom of `database.js` retroactively gives every user without a `firm_id` their own firm — keep it idempotent.

### Submission lifecycle

`invitations.status` flows: `sent` → `opened` (set by the tracking pixel `/track/open/:invId` or by hitting `/q/:token`) → `in_progress` (when the guest first edits) → `signed`. If a firm user edits an already-`submitted` questionnaire, status flips to `revised` on the invitation and back to `draft` on the submission — see the special-case block in `PUT /api/submissions/:id`. `POST /api/submissions/:id/request-resign` does the same flip explicitly and emails the investor a fresh link.

`questionnaire_submissions` stores each section (`general_info`, `investment_info`, `category_ii..v`) as a JSON string column — the server stringifies on write and the client `JSON.parse`s on read.

### Email

SMTP via nodemailer (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `SMTP_FROM`). If these are unset, `sendEmail()` falls back to logging the message to the console — convenient for local dev, but means missing config is silent in prod beyond a startup warning.

**Stale config alert:** `.env.example` and `render.yaml` still reference `RESEND_API_KEY` / `FROM_EMAIL` / `FROM_NAME` from the previous Resend implementation (see commit `e66f829`). The code no longer reads those — update both files when you next touch them, and use the SMTP_* variables instead.

### Invite tokens

`makeInviteToken(contactName)` produces human-readable tokens like `john-smith-Ak3Xm9` — a slug from the contact's name plus a 6-char random suffix using a confusable-free alphabet. Tokens are unique (DB constraint) and rotated on every invite/resend, so old links stop working.

### Inactivity logout

`public/inactivity.js` is included on authenticated pages. It auto-logs out after 30 minutes of no activity with a 2-minute warning modal. Activity is any of mousemove/mousedown/keydown/touchstart/scroll/click. It hits `POST /api/logout` and redirects to `/`.

## Roadmap

`ROADMAP.md` describes the multi-step evolution from a per-firm questionnaire tool into a portable investor-certification platform. Step 1 (investor identity layer — `investor_accounts`, `investor_users`, `investor_token` cookie, `/api/investor/*` routes, `public/investor.html`, `public/investor-dashboard.html`) is shipped. Subsequent steps add profiles, designee management, cross-firm portability, and certification expiry. Read it before making structural changes to investor-facing code.

## Files to ignore

- `login-code.md` is an outdated snapshot of an earlier session-based auth implementation. Current auth is JWT — read `server.js` directly, not this file.
- `questionnaire.db`, `*.db-shm`, `*.db-wal` are the local SQLite database; never commit them (they're in `.gitignore` but show as modified because WAL files churn).
