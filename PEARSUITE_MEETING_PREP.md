# PearSuite Tech Meeting — First Live Claim

Goal: leave the call with a single billable claim accepted into the Pear pipeline for a Compass session, and a clear path to repeat it from inside the app.

## Live integration test — 2026-05-13

Pre-meeting smoke test against `https://api.pearsuite.com` using the prod API key.

**What worked end-to-end:**

| Step | Endpoint | Result |
|---|---|---|
| List users | `GET /api/beta/users` | 200 — Jemal (`3f205159-f1b3-43c0-a875-dec3ecc97025`) and Akram (`a0f12270-3e30-424d-8adb-2fe8e9402ca9`) returned. Both real. |
| List members | `GET /api/beta/members` | 200 — `Test Tester` (`d25bcbc0-6d66-4d71-9bc7-8f3a58ccb169`) is the test member. |
| Schedule activity | `POST /api/beta/activities` with `{ activityTemplateId, memberIds, userId, date, scheduledStartAt, scheduledEndAt, notes }` | **201 — Activity created.** ID `42471496-8968-4b8c-b15a-3ecdd46a60f6`. Title: "Compass CHW Self-Management Education (98960)". `billable: true`. Status `Scheduled`. **Procedure 98960 confirmed in template.** |

**Stuck on one thing — `costId is required` on `PUT /activities/:id`:**

Each `billingDetails` entry needs a `costId` Pear assigns. We tried `GET /api/beta/{costs|activityCosts|billing-codes|prices|fees|procedures|activityTemplates|insuranceCompanies}` — all 404. The cost item must come from somewhere in their data model we haven't found.

→ **Direct ask for tomorrow:** "How do we get the `costId` we need to put in `billingDetails[*].costId` when completing an activity? Is it on the activity template, the insurance company, or a separate `/costs`-style endpoint?"

**Payload-shape findings to bake into our provider:**

- `POST /members` — `gender` and `language` are arrays, not strings (`["Female"]`, `["English"]`). Our code currently sends them as strings; needs fix.
- `POST /members` — "Female" is rejected as a Gender value. Need their list of accepted values.
- `POST /activities` — required keys are `userId` (singular, not `ownerUserId`), `date` (calendar date, not `scheduledDate`), `scheduledStartAt`, `scheduledEndAt`. `notes` and `memberIds` work as expected.
- Activity response shape — `{ "success": true, "data": { "_id": "<uuid>", ... } }`. Our code reads `data.id` / `data.activityId` first; just patched to fall back to `data.data._id`.

**What this means for the meeting:**
- We don't need the rep to give us Jemal's userId — we already have it (above).
- We don't need to ask "do payouts work, does the API take our key" — confirmed.
- The single tactical question is the `costId` resolution path.
- Everything else is confirmation: BAA in writing (already verbally confirmed by Akram), webhook contract for status pushes, and adjudication SLA.

---

## TL;DR

Everything on our side is wired. BAA is signed (confirmed 2026-05-12), so we're clear to send real PHI through their API. We're blocked on **one** thing from Pear:

1. **Jemal's userId in Pear** — the rep wouldn't expose it to us; their tech team must hand it over.

We also want them to validate our `complete_activity` payload shape before the first claim, but that's a question we ask live, not a blocker.

After the call, we run **one** curl against `/api/v1/admin/pear-suite/demo-claim`, see the claim land in their dashboard, and we're done.

---

## What's wired on our side (done)

### Backend client
`backend/app/services/billing/pear_suite_provider.py` (782 lines, 13 passing tests)

| Method | Pear endpoint | Purpose |
|---|---|---|
| `create_member` | `POST /api/beta/members` | Sync Compass member into Pear's roster |
| `schedule_activity` | `POST /api/beta/activities` | Create the activity with templateId + chwUserId + memberId + serviceDate |
| `complete_activity` | `PUT /api/beta/activities/:id` | Flip `status=Complete` and attach `billingDetails` (units, modifiers, place of service, DX pointers) |
| `generate_claim` | `POST /api/beta/claims` | Tries `{ memberId }` first; falls back to `{ memberId, billId }` if Pear requires it |
| `get_claim_status` | `GET /api/beta/claims?memberId=…` | Query for our claim; falls back to `GET /api/beta/claims/:id` |
| `void_claim` | `DELETE /api/beta/claims/:id` | Undo if needed |

Every mutation sends `X-Idempotency-Key` (call-id-scoped) so retries don't double-bill.
Rate-limit headers (`X-Rate-Limit-Remaining` / `Limit` / `Reset`) are logged on every response.
PHI is never logged: `medi_cal_id`, full DX codes, member names are redacted from log lines.

### Member sync helper
`backend/app/services/pear_suite_member_sync.py` — `ensure_member_synced(db, profile, user)`:
- Idempotent: if `members.pear_suite_member_id` is set, returns it without an API call
- Otherwise POSTs to `/members`, persists the returned ID on the row, returns it

### Demo orchestrator
`POST /api/v1/admin/pear-suite/demo-claim`  (`backend/app/routers/admin_demo.py`)

Auth: `Bearer <ADMIN_KEY>` + `X-Admin-2FA-Token`
Body: `{ "session_id": "<uuid>" }`
10-step flow: load session → load member user+profile → load CHW user+profile → validate `chw_profile.pear_suite_user_id` → validate `PEAR_SUITE_DEMO_TEMPLATE_ID` → resolve service date → resolve DX codes → ensure member synced → schedule activity → complete activity → generate claim → poll claim status → return JSON with `pear_member_id`, `pear_activity_id`, `pear_claim_id`, `claim_status`.

Returns clear HTTP 400s with prescriptive fix instructions when CHW userId or template ID is missing — so a 400 on the call tells us exactly what to set.

### DB schema
Migration `aa1b2c3d4e5f` (PearSuite IDs) is applied in prod. Adds:
- `members.pear_suite_member_id` — cached after first sync
- `chw_profiles.pear_suite_user_id` — Jemal's userId once Pear gives it
- `pear_suite_template_map` table — vertical → templateId mapping (seeded with 98960 row)

### Stripe Connect transfer chain
After Pear webhooks `claim.paid`, `app/services/payments_service.py` fires a Stripe Connect Transfer to the CHW's account. Wired and tested earlier.

### What we just fixed (2026-05-12 night, pre-meeting)

- **Env var name mismatch.** Code was reading `PEAR_SUITE_T1016_TEMPLATE_ID` while DEPLOY.md said to set `PEAR_SUITE_DEMO_TEMPLATE_ID`. The two never connected and the demo endpoint always 400'd at the template-validation step. Code now reads `PEAR_SUITE_DEMO_TEMPLATE_ID`. Both names will not work — only the new one.
- **T1016 references in comments/docstrings.** Pear's CHW billing path uses 98960/98961/98962; T1016 is rejected. Updated all comments and validation messages so the next reader doesn't get misled.

---

## Required prod env vars

Set these in `/home/ubuntu/compass/backend/.env` on EC2 (most are already there). Anything missing → demo endpoint returns 400 with the exact fix.

| Var | Value | Status |
|---|---|---|
| `PEAR_SUITE_API_KEY` | live key from Pear dashboard | ✅ set |
| `PEAR_SUITE_BASE_URL` | `https://api.pearsuite.com` | default |
| `PEAR_SUITE_DEMO_TEMPLATE_ID` | `cb5875f0-444d-448f-9700-996c2ab65817` (Jemal's template) | ✅ set in DEPLOY.md, now also matches code |
| `PEAR_SUITE_DEMO_CHW_USER_ID` | Jemal's userId in Pear | ❌ **blocked on Pear** |
| `PEAR_SUITE_DEFAULT_DX_CODES` | `["Z55.9"]` (literacy) per DEPLOY.md, OR `["Z71.89"]` (counseling) per code default — confirm with Pear | ⚠️ need confirmation |

To plug Jemal's userId once Pear gives it during the call:

```sql
UPDATE chw_profiles
SET pear_suite_user_id = '<paste from Pear>'
WHERE user_id = (SELECT id FROM users WHERE email = 'jemal@joincompasschw.com');
```

(Faster than redeploying — no env change required, the value lives on the row.)

---

## Asks for the Pear tech team

These are the things only they can answer or hand over.

### Hard blockers
1. **Jemal's userId.** They wouldn't show it in the rep dashboard. We need it pasted into the SQL above.
2. ~~BAA confirmation~~ — **signed 2026-05-12**, no longer blocking. Safe to send real PHI through `https://api.pearsuite.com`.

### API behavior questions
3. **Activity template payload validation.** We built `complete_activity` to send `billingDetails` with `procedure`, `modifiers`, `placeOfService`, `units`, and a `diagnosisPointers` array referring to a top-level `diagnosisCodes` list. Confirm this is the shape they expect — or give us the canonical example payload.
4. **Is `billId` required for `POST /claims`?** Our code tries `{ memberId }` first and falls back to `{ memberId, billId }`. Where does `billId` come from — the response of `complete_activity`, or a separate `GET /bills?memberId=…` call? If always required, we can simplify.
5. **Eligibility check.** Our provider stubs eligibility because the Beta docs don't expose an endpoint. Is there a real one, or do we always submit and trust their clearinghouse to bounce ineligible claims?
6. **Adjudication timing.** From `claim.submitted` → `claim.paid` (or `denied`), what's the normal SLA on prod? Hours? Days? Drives whether we poll or wait for a webhook.
7. **Webhooks.** Do they push us status changes (paid / denied / appealed) or do we have to poll `GET /claims`? If they push, what's the URL we register and what's the payload + signature?

### Operational
8. **Test path on prod.** They told the rep they don't have a sandbox. So our "demo" runs against live API with a synthetic member. Confirm Pear's expectation is that we do this against live — and that they'll mark the test claim as void on their side after we verify it landed (so their adjudication queue isn't polluted).
9. **Procedure code defaults.** We default DX to `Z55.9` in DEPLOY.md and `Z71.89` in code (we just unified — `Z55.9`). Procedure is whatever's baked into template `cb5875f0…`. Confirm the template procedure is a CHW-billable code (98960/98961/98962) and not T1016 (which Pear bounces).
10. **Adjudication failure messages.** When a claim is denied, where do we read the reason — a `denial_reason` field on the claim, or only via the dashboard?

---

## Live demo plan (during the call)

1. **Pre-flight (us, ~2 min before joining):**
   - SSH into EC2: `ssh -i ~/Downloads/compass-prod-key.pem ubuntu@35.82.234.140`
   - `cd ~/compass/backend && sudo docker compose logs -f api &` — tail the API logs in a side window
   - Open Pear Suite dashboard in a tab — Activities + Claims views
   - Open Stripe Express dashboard in a tab — Payouts view
   - Have a fresh admin 2FA token from `/api/v1/admin/2fa/verify`
   - Have a real session UUID ready (created via the app earlier)

2. **The moment Pear hands over Jemal's userId:**
   ```sql
   UPDATE chw_profiles SET pear_suite_user_id = '<paste>'
   WHERE user_id = (SELECT id FROM users WHERE email = 'jemal@joincompasschw.com');
   ```

3. **Fire the demo claim:**
   ```bash
   curl -X POST https://api.joincompasschw.com/api/v1/admin/pear-suite/demo-claim \
     -H "Authorization: Bearer $ADMIN_KEY" \
     -H "X-Admin-2FA-Token: $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"session_id": "'$SESSION_ID'"}'
   ```

4. **What we watch in real time:**
   - API logs scroll the 10-step flow
   - Pear dashboard: new Activity appears under Jemal's user → flips to Complete → new Claim row appears
   - JSON response includes `pear_member_id`, `pear_activity_id`, `pear_claim_id`, `claim_status`
   - Confirm in Pear UI that the claim shows as `submitted` (or whatever their initial state is)

5. **Failure modes we're prepared for:**
   - 400 "CHW does not have pear_suite_user_id" → SQL update wasn't run / wrong user
   - 400 "PEAR_SUITE_DEMO_TEMPLATE_ID is not configured" → env var didn't reload (restart container)
   - 502 from `complete_activity` → payload shape wrong → ask Pear to look at the request live in their logs
   - 401 from Pear → API key wrong env or rotated
   - Rate limit → unlikely on a single call

---

## After the meeting

Whether or not the demo lands cleanly, the next steps are:

- [ ] Save Jemal's `pear_suite_user_id` to the DB **and** to the `.env` (`PEAR_SUITE_DEMO_CHW_USER_ID`) so the auto-claim pipeline can read it without DB access
- [ ] Document the validated activity payload shape in a comment block in `pear_suite_provider.py:complete_activity` so future agents/devs don't guess
- [ ] If Pear pushes webhooks: register our endpoint at `https://api.joincompasschw.com/api/v1/webhooks/pear-suite` (need to scaffold the route + signature verify)
- [ ] If they don't: schedule a poller job for claims in `submitted` status, transition them when status flips
- [ ] Wire the in-app "Submit claim" button on `CHWSessionsScreen` to fire the same orchestrator (currently only the admin endpoint can fire it)
- [ ] Add a Pear status badge to `CHWEarningsScreen` per claim (already partly there — uses session/claim data)
- [x] BAA signed (2026-05-12). Store the countersigned PDF in `docs/baa/pearsuite_baa_2026.pdf` for audit. No env-gate to flip — Pear isn't behind a `*_baa_confirmed` startup gate the way Vonage / AssemblyAI / Anthropic are. Worth adding one for symmetry next time we touch the config.

---

## Files to point them at if they want to read code

- `backend/app/services/billing/pear_suite_provider.py` — the API client
- `backend/app/routers/admin_demo.py` — the orchestrator
- `backend/app/services/pear_suite_member_sync.py` — member sync helper
- `backend/tests/test_pear_suite_demo_flow.py` — how we exercised it (13 passing tests)
- `backend/alembic/versions/20260509_add_pearsuite_ids.py` — schema changes
