# SPV Tracker Roadmap

Multi-step plan to evolve SPV Tracker from a per-firm questionnaire tool into a portable investor-certification platform where investors own their data and grant access to firms.

## Design Decisions (locked)

- **Investors get their own accounts** in a new `investor_users` table — distinct from firm `users`.
- **Investor entities are first-class.** An `investor_accounts` row represents the entity being certified ("Smith Family Trust", "Acme LLC"). One or more `investor_users` belong to it.
- **Email is the identifier**, but each investor account has one **admin** email (the registrant). Admins can grant access to **designees** (additional `investor_users` scoped to the same account).
- **Certifications attach to the investor account**, not to any individual user — so any team member acting on behalf of the entity sees the same certified status.
- **Defaults for v1 of the designee model:**
  - Designees have their own login email and password (not shared with the admin).
  - Designees can fill out, save, and sign questionnaires on behalf of the account.
  - An `investor_user` belongs to exactly one `investor_account` (FK constraint). Cross-account designation (e.g. an attorney serving multiple investor entities) is deferred to a later iteration.
- **Two cookies coexist:** firm users use the existing `auth_token` cookie; investors use a new `investor_token` cookie. This lets a single browser hold both sessions and avoids touching `requireAuth` for the firm side.

---

## Step 1 — Investor Identity Layer (in progress)

Foundations: investor accounts, investor logins, investor JWTs.

- [x] `investor_accounts` table
- [x] `investor_users` table (role: admin | designee)
- [x] `makeInvestorToken` / `requireInvestorAuth` / `investor_token` cookie helpers
- [x] `POST /api/investor/register` — creates account + admin user, issues JWT
- [x] `POST /api/investor/login`
- [x] `POST /api/investor/logout` (with `jti` denylist)
- [x] `GET /api/investor/me`
- [x] `public/investor.html` — login + register UI
- [x] `public/investor-dashboard.html` — placeholder dashboard

**Out of scope for Step 1:** designee invitations (admin-only management UI comes in Step 2), profile fields beyond `account.name` and `user.full_name`, integration with the existing `/q/:token` guest flow.

---

## Step 2 — Persistent Investor Profile

Investor entities carry data forward between firms and across questionnaires.

- `investor_profiles` table (1:1 with `investor_accounts`): entity_type, state, mailing address, EIN/SSN last-4, phone, etc.
- `/investor/profile.html` — editable profile page (admin-only writes, designees read-only).
- Add `investor_user_id` and `investor_account_id` columns to `questionnaire_submissions`.
- Pre-populate `general_info` of a new submission from the investor's profile when a logged-in investor opens a `/q/:token` link.
- Designee management UI: `/investor/team.html` — admin can invite/remove designees by email.

---

## Step 3 — Cross-Firm Portability (the value prop)

Decouple "is this investor certified?" from "did they fill out our firm's form?"

- `certifications` table: `(id, investor_account_id, submission_id, certified_at, expires_at, status)`. One canonical record per investor entity per certification cycle.
- On `submission.signed`, upsert a `certification` row.
- `certification_access_grants` table: `(certification_id, firm_id, granted_at, revoked_at)`. Investors decide who can see what.
- New invitation type: **access request** instead of full questionnaire. Firm asks → investor approves → firm sees existing certified submission.
- `/investor/certifications.html` — investor sees all certifications, all firms with access, can revoke.
- Firm-side: existing matter detail page learns to show "✓ Certified via portable record (granted 2026-04-12)" badges.

---

## Step 4 — Certification Lifecycle & Expiry

Polish layer: keep certifications fresh.

- `expires_at` defaults to certified_at + 1 year.
- Background job (cron or startup-scheduled) emails investors 30 days before expiry.
- `⚠ Expiring soon` and `⚠ Expired` badges on firm-side matter views.
- Investor-initiated renewal: creates a new submission pre-populated from the most recent signed one.

---

## Open Questions (revisit before Step 2)

- Should designees have a separate role beyond a binary `admin | designee`? (e.g. `viewer` who can only read)
- When an investor email matches an existing `investor_contacts` row at one or more firms, do we auto-link historical invitations to the newly-created investor account? Right now the answer is "no — Step 1 keeps the two worlds separate"; revisit when Step 2 lands.
- Cross-account designation (one user → many accounts) is deferred. If demand surfaces, replace the `investor_users.investor_account_id` FK with a `investor_account_members` join table.
