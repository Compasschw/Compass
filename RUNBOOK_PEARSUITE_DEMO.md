# Runbook — PearSuite First Live Claim Demo

Single-page copy-pastable runbook for tomorrow's Pear tech meeting. Pair it with [PEARSUITE_MEETING_PREP.md](./PEARSUITE_MEETING_PREP.md) which has the rationale, ask list, and post-meeting follow-ups.

---

## 0. Pre-flight (run 10 min before joining)

Open four windows:

| Window | What to have |
|---|---|
| **Terminal A** | SSH'd to EC2, tailing API logs |
| **Terminal B** | Local shell with the curl ready and admin token captured |
| **Browser tab 1** | Pear Suite dashboard → Activities + Claims views |
| **Browser tab 2** | Stripe Express dashboard → CHW transfers view |

### Terminal A — tail API logs on EC2

```bash
ssh -i /Users/akrammahmoud/Downloads/compass-prod-key.pem ubuntu@35.82.234.140
cd ~/compass/backend
sudo docker compose logs -f api | grep -E "pear_suite|demo_claim|pear_webhook|pear_claim_status_poll"
```

Keep this open the whole call.

### Terminal B — fetch admin 2FA token + capture session UUID

```bash
# 1) Grab a 2FA token (paste your TOTP code when prompted)
export ADMIN_KEY="<paste the admin key from prod .env>"
export TOTP="<paste 6-digit TOTP from your authenticator>"

TOKEN=$(curl -s -X POST https://api.joincompasschw.com/api/v1/admin/2fa/verify \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"code\": \"$TOTP\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
echo "TOKEN=$TOKEN"

# 2) Pick the session we'll demo. The session must be Jemal-as-CHW with any
#    member; status doesn't matter (the demo endpoint will run regardless).
#    Easiest way to get one:
#      - Sign in to /chw as Jemal
#      - From /chw/calendar pick any session and copy its UUID from the URL
#    Or query directly:
SESSION_ID=$(curl -s -H "Authorization: Bearer <jemal_jwt>" \
  https://api.joincompasschw.com/api/v1/sessions/ | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
echo "SESSION_ID=$SESSION_ID"
```

---

## 1. When Pear hands over Jemal's userId on the call

In Terminal A on EC2:

```bash
# Connect to the prod DB (Postgres is in the same docker-compose stack)
sudo docker compose exec -T db psql -U compass -d compass <<'SQL'
UPDATE chw_profiles
SET pear_suite_user_id = '<PASTE_JEMAL_PEAR_USERID_HERE>'
WHERE user_id = (SELECT id FROM users WHERE email = 'jemal@joincompasschw.com');

-- Confirm
SELECT user_id, pear_suite_user_id FROM chw_profiles
WHERE user_id = (SELECT id FROM users WHERE email = 'jemal@joincompasschw.com');
SQL
```

Output should show the userId on the row.

(No env-var change, no container restart — the field is read from the DB each request.)

---

## 2. Fire the claim

Back in **Terminal B** (the one with $TOKEN and $SESSION_ID set):

```bash
curl -X POST https://api.joincompasschw.com/api/v1/admin/pear-suite/demo-claim \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "X-Admin-2FA-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\": \"$SESSION_ID\"}"
```

Expected happy-path response:

```json
{
  "pear_member_id": "mbr_xxx",
  "pear_activity_id": "act_xxx",
  "pear_claim_id": "clm_xxx",
  "claim_status": "submitted",
  "view_url_hint": "Open Pear dashboard → Claims to verify."
}
```

In Terminal A, the API logs will scroll:
```
demo_claim.start: session_id=...
demo_claim.session_loaded: ...
demo_claim.member_loaded: ... already_synced=False
demo_claim.chw_validated: ... pear_user_id=<from-Pear>
demo_claim.template_validated: ... template_id=cb5875f0...
demo_claim.member_sync: ...
pear_suite.create_member: POST /api/beta/members ...
demo_claim.activity_scheduled: pear_activity_id=...
pear_suite.complete_activity: PUT /api/beta/activities/... status=Complete
demo_claim.activity_completed: ...
pear_suite.generate_claim: POST /api/beta/claims ...
demo_claim.claim_generated: pear_claim_id=...
demo_claim.claim_status: status=submitted
demo_claim.success: ...
```

In Pear's dashboard, refresh **Activities** → new row with Jemal's name + today's date. Refresh **Claims** → new row with that activity attached and status `Submitted` (or whatever their initial state is).

---

## 3. Known failure modes + fixes

| Response | Meaning | Fix |
|---|---|---|
| `400 Session not found` | Bad `session_id` in body | Re-fetch with the curl in step 0 |
| `400 CHW … does not have a pear_suite_user_id` | Step 1 SQL didn't run / hit the wrong user | Run step 1 again; double-check Jemal's email matches your prod DB |
| `400 PEAR_SUITE_DEMO_TEMPLATE_ID is not configured` | Env var didn't load | On EC2: `cat ~/compass/backend/.env | grep PEAR_SUITE_DEMO_TEMPLATE_ID` — should be `cb5875f0-444d-448f-9700-996c2ab65817`. Restart container: `sudo docker compose restart api` |
| `502 Bad Gateway` with Pear in the log | Pear API rejected the payload (likely template / billingDetails shape) | Show the request body to the Pear engineer on the call — they can read it in their server logs |
| `401 Unauthorized` from Pear | API key wrong / rotated | `cat ~/compass/backend/.env | grep PEAR_SUITE_API_KEY`, verify against Pear's dashboard |
| `429 Too Many Requests` from Pear | Rate-limited (very unlikely on a single call) | Wait, retry |

---

## 4. End-to-end pipeline status (what happens after step 2)

Once the claim is `submitted` in Pear, the rest of the pipeline runs without us. Here's what's wired vs stubbed so you know what to watch for.

```
[ CHW finishes session ]
       │
       │ POST /sessions/{id}/documentation        ✅ wired (sessions.py:308)
       ▼
[ BillingClaim row created locally, status='pending' ]
       │
       │ Inline submit_claim → Pear (3-step)      ✅ wired
       │   • member sync ⇒ POST /api/beta/members
       │   • schedule activity ⇒ POST /api/beta/activities
       │   • complete + billing ⇒ PUT /api/beta/activities/:id
       │   • generate claim ⇒ POST /api/beta/claims
       ▼
[ BillingClaim.status='submitted', pear_suite_claim_id set ]
       │
       │ Pear processes through clearinghouse     ⚪ Pear's responsibility
       │ Pear marks claim 'paid' on their side    ⚪ Pear's responsibility
       │
       ▼
[ Status update reaches us ]                       ⚠️ TWO PATHS
       │
       ├─► Push (preferred, awaiting Pear)         ⚠️ STUB
       │   POST /api/v1/webhooks/pear-suite       (pear_webhook.py — accepts any body, returns 200,
       │                                            logs payload. Real handler is TODO blocks
       │                                            until Pear publishes contract.)
       │
       └─► Pull (works today, no Pear dependency)  ✅ wired
           scheduler.poll_pear_claim_status        runs every 30 minutes,
                                                    calls provider.get_claim_status for each
                                                    submitted/accepted claim,
                                                    flips BillingClaim.status on change.
       │
       ▼
[ BillingClaim.status='paid', paid_at set ]
       │
       │ scheduler.trigger_pending_payouts         ✅ wired (every 10 min)
       │   finds claims where status='paid' AND
       │   stripe_transfer_id IS NULL
       ▼
[ Stripe Connect transfer fires → CHW account ]   ✅ wired (payments_service.py)
       │
       │ Stripe webhook transfer.paid             ✅ wired (/payments/webhooks/stripe)
       ▼
[ BillingClaim.paid_to_chw_at set, money in CHW bank ] ✅
```

Bottom line: the only piece that's stubbed is the **inbound Pear webhook**. The polling job fills the gap until Pear publishes their webhook contract — once we have it, you swap the TODO blocks in `pear_webhook.py` with real signature verification + body parsing, and you can drop the poll frequency (or remove the job entirely).

---

## 5. After the demo lands

Same checklist as in PEARSUITE_MEETING_PREP.md, plus:

- [ ] Set `PEAR_SUITE_DEMO_CHW_USER_ID` in `.env` so the env-var path is also populated (currently only the DB has it). Restart the container.
- [ ] Confirm Pear marks the test claim as VOID on their side after we verify (so adjudication queue isn't polluted)
- [ ] Capture the validated `complete_activity` payload shape into a comment block at the top of `pear_suite_provider.py`
- [ ] Once Pear publishes the webhook contract, fill in the TODO blocks in `backend/app/routers/pear_webhook.py`
- [ ] Wire the in-app "Submit claim" button on `CHWSessionsScreen` to hit `/api/v1/admin/pear-suite/demo-claim` (currently admin-only) — or expose a dedicated CHW endpoint
- [ ] Flip `pear_suite_baa_confirmed=true` in prod `.env` once Pear's BAA is signed in writing
