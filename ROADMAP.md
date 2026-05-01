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

## Step 1 — Investor Identity Layer ✅

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

---

## Step 2 — Profile, Designees, and Pre-fill ✅

Investor entities carry data forward between firms and across questionnaires.

**2A — Persistent profile:**
- [x] `investor_profiles` table (1:1 with `investor_accounts`): entity_type, state, address fields, postal_code, phone, tax_id_last4, updated_at, updated_by
- [x] `GET /api/investor/profile` — any account member
- [x] `PUT /api/investor/profile` — admin-only; can also rename the account
- [x] `public/investor-profile.html` — admin can edit, designees read-only

**2B — Designee management:**
- [x] `GET /api/investor/team` — any account member
- [x] `POST /api/investor/team` — admin invites a designee; sends a welcome email with credentials (`buildDesigneeWelcomeEmail`)
- [x] `PUT /api/investor/team/:id` — admin renames a designee
- [x] `DELETE /api/investor/team/:id` — admin removes a designee; cannot remove themselves; cannot remove an admin
- [x] `public/investor-team.html` — admin sees add-designee form; designees see read-only list

**2C — Pre-fill the questionnaire from profile:**
- [x] `questionnaire_submissions.investor_account_id` and `.investor_user_id` columns
- [x] When `/q/:token` is opened by a logged-in investor whose account contains the invitation's contact email, link the submission to that account and pre-fill `general_info` (legal_name, state, street, city, zip, phone, email) from the profile
- [x] If a designee on the same account opens an admin-addressed invite, they auto-link too (any team member can act)
- [x] Existing submissions get their account/user backfilled when an unauth'd guest later logs in
- [x] Unrelated investors who open a link not addressed to their account fall through to the anonymous-guest flow unchanged

**Out of scope for Step 2:** the questionnaire HTML itself does not yet *reload* prefilled values when an investor logs in mid-flow (the prefill only takes effect at submission-creation time). Will revisit if it surfaces as a real pain point.

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

## Open Questions

- Should designees have a separate role beyond a binary `admin | designee`? (e.g. `viewer` who can only read)
- When an investor email matches an existing `investor_contacts` row at one or more firms, do we auto-link **historical** invitations? Step 2's auto-link only fires when the investor opens a fresh `/q/:token` link while logged in. Backfilling old invitations would let a newly-registered investor pull their existing certifications onto the platform retroactively — appealing but requires UX design (which firms? do they have to consent?).
- Cross-account designation (one user → many accounts) is deferred. If demand surfaces, replace the `investor_users.investor_account_id` FK with a `investor_account_members` join table.
- Inactivity auto-logout (`public/inactivity.js`) currently calls `/api/logout` and so doesn't work for investor sessions. Adding an investor variant or making the script auth-aware is a small follow-up.
