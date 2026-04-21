# CompassCHW — Operations Runbook

**Owner:** TJ (CDO) · **Maintained by:** Akram (CTO)
**Last updated:** 2026-04-20

This is your command reference for day-to-day operations. Every command here
preserves the HIPAA audit trail — **please do not bypass this tool with raw SQL
queries against the database**, as those do not log to `audit_log` and create
compliance gaps.

If a command doesn't do what you need, ping Akram rather than improvising.

---

## Table of contents

1. [Getting into production](#1-getting-into-production)
2. [Ops CLI — the tool you'll use every day](#2-ops-cli--the-tool-youll-use-every-day)
   - [`ops user`](#ops-user---look-up-a-person)
   - [`ops session`](#ops-session---inspect-one-session)
   - [`ops chw-payout`](#ops-chw-payout---stripe--earnings-status)
   - [`ops requeue-claim`](#ops-requeue-claim---resubmit-a-stuck-claim)
   - [`ops retry-payout`](#ops-retry-payout---re-trigger-stripe-transfer)
3. [Pear Suite test harness — smoke test the billing integration](#3-pear-suite-test-harness)
4. [Common scenarios](#4-common-scenarios)
5. [Troubleshooting](#5-troubleshooting)
6. [Emergency contacts](#6-emergency-contacts)

---

## 1. Getting into production

We use AWS Systems Manager Session Manager — no SSH, no IP whitelisting.

### One-time setup (done once per machine)

You need:

- AWS CLI (`brew install awscli`)
- Session Manager plugin (`brew install --cask session-manager-plugin`)
- AWS access key with SSM permission (ask Akram to provision one for you)

Then run `aws configure` and enter:
- Access Key ID / Secret Access Key (from the access key above)
- Default region: `us-west-2`
- Default output format: `json`

### Starting a production session

```bash
aws ssm start-session --target i-0f3d13da68b0974ee --region us-west-2
```

Once you're in:

```bash
sudo su - ubuntu
cd ~/compass/backend
```

You're now on the backend host. Every command in this runbook runs from here.

**Set your operator email so audit logs can identify you:**

```bash
export OPERATOR_EMAIL=tj@joincompasschw.com
```

Do this at the start of each session. It's what gets stamped on every audit log
entry as a result of your commands.

---

## 2. Ops CLI — the tool you'll use every day

Every `ops` command is:

```bash
docker exec -w /code -e OPERATOR_EMAIL compass-api python -m scripts.ops <command> <args>
```

That's a mouthful. Save this as a shell alias on the EC2 host (one time):

```bash
echo 'alias ops="docker exec -w /code -e OPERATOR_EMAIL compass-api python -m scripts.ops"' >> ~/.bashrc
source ~/.bashrc
```

Now you can just type `ops user …` instead of the whole `docker exec` line.

---

### `ops user` — look up a person

**What it does:** Shows a user's profile (role, status, contact info) and a
summary of their activity (sessions, claims, last audit event).

**When to use:**
- Someone calls complaining they can't log in — check `is_active` and `is_onboarded`
- Debugging a matching issue — verify the CHW/member exists and has the right role
- Answering "when was the last time this person did anything?"

**Syntax:**

```bash
ops user <uuid-or-email>
```

**Examples:**

```bash
ops user maria@communityhealth.com
ops user 3f1b2c4d-5e6f-7890-abcd-1234567890ab
```

**Sample output:**

```
User — maria@communityhealth.com
────────────────────────────────
  ID                      3f1b2c4d-5e6f-7890-abcd-1234567890ab
  Role                    chw
  Name                    Maria Rodriguez
  Phone                   +15551234567
  Active                  True
  Onboarded               True
  Created                 2026-03-14 18:22:03+00:00
  Last audit activity     2026-04-19 22:14:51+00:00

Activity
────────
  Sessions (any role)        14
  Billing claims (any role)  11
```

---

### `ops session` — inspect one session

**What it does:** Shows lifecycle (scheduled → started → ended), the associated
billing claim (if any), and Stripe payout state.

**When to use:**
- A member says "the CHW never showed up" — check `status` and `started_at`
- Checking why a claim hasn't been submitted yet
- Debugging a missing payout

**Syntax:**

```bash
ops session <session-uuid>
```

**Example:**

```bash
ops session 7a8b9c10-1d2e-3f40-5a6b-7c8d9e0f1a2b
```

**Sample output (abridged):**

```
Session — 7a8b9c10-…
  Status                  completed
  Mode                    in_person
  CHW                     3f1b2c4d-…
  Member                  9c8d7e6f-…
  Scheduled at            2026-04-18 14:00:00+00:00
  Started at              2026-04-18 14:03:12+00:00
  Ended at                2026-04-18 14:52:04+00:00
  Duration (min)          48
  Units billed            3
  Gross amount            79.98

Billing claim
  Claim ID                0e1f2a3b-…
  Status                  paid
  Pear Suite claim ID     PS-ADJ-99421
  Stripe transfer ID      tr_1O1abc…
  Paid to CHW at          2026-04-20 03:15:02+00:00
```

---

### `ops chw-payout` — Stripe + earnings status

**What it does:** Shows whether a CHW is fully onboarded to Stripe, their
lifetime paid earnings, pending claims, and their last 5 payouts.

**When to use:**
- A CHW asks "why haven't I been paid for last week's sessions?"
- Verifying onboarding completed (they clicked through the Stripe link)
- Earnings reconciliation for the CHW's own records

**Syntax:**

```bash
ops chw-payout <uuid-or-email>
```

**Example:**

```bash
ops chw-payout maria@communityhealth.com
```

**Sample output:**

```
CHW payout status — maria@communityhealth.com
  CHW user ID             3f1b2c4d-…
  Stripe account ID       acct_1Nxyz…
  Payouts enabled         yes
  Details submitted       True

Earnings
  Paid claims             8
  Lifetime paid ($)       1947.52
  Pending claims          3

Last 5 payouts
  · 2026-04-20 03:15:02+00:00  $197.49  claim=0e1f… transfer=tr_1O1abc…
  · 2026-04-13 03:04:22+00:00  $296.24  claim=bc4e… transfer=tr_1Nzyx…
  ...
```

If you see **Payouts enabled: no**, the CHW hasn't finished Stripe onboarding yet.
Send them back to the in-app "Set up payouts" flow.

---

### `ops requeue-claim` — resubmit a stuck claim

**What it does:** Re-submits a billing claim to Pear Suite. Useful when a claim
got rejected for a transient reason (e.g., rate limit, API outage) or when
we've corrected the underlying data.

**When to use:**
- Pear Suite rejected a claim with a transient error
- Claim is in `pending` status for more than 24 hours
- **Do not use** to force through a claim that was rightfully rejected

**⚠️ Dry-run by default.** First invocation shows what would happen without
actually submitting. Add `--yes` to commit.

**Syntax:**

```bash
ops requeue-claim <claim-uuid>           # dry-run
ops requeue-claim <claim-uuid> --yes     # actually submit
```

**Example:**

```bash
ops requeue-claim 0e1f2a3b-4c5d-6e7f-8a9b-0c1d2e3f4a5b
# Review the output. If it looks right:
ops requeue-claim 0e1f2a3b-4c5d-6e7f-8a9b-0c1d2e3f4a5b --yes
```

**Guardrails:** The command refuses to re-submit a claim whose status is
already `paid` (prevents double-billing).

---

### `ops retry-payout` — re-trigger Stripe transfer

**What it does:** Manually triggers the Stripe Connect transfer that moves the
CHW's net share from our platform balance to their bank. Normally the
background scheduler does this automatically after a claim is paid.

**When to use:**
- The automated payout scheduler is stuck or has failed
- A CHW's Stripe account got re-enabled after a KYC issue and we need to
  push a previously-queued transfer

**⚠️ Dry-run by default.** Add `--yes` to actually transfer money.

**Syntax:**

```bash
ops retry-payout <claim-uuid>             # dry-run
ops retry-payout <claim-uuid> --yes       # actually transfer
```

**Example:**

```bash
ops retry-payout 0e1f2a3b-4c5d-6e7f-8a9b-0c1d2e3f4a5b
# Review. If it looks right:
ops retry-payout 0e1f2a3b-4c5d-6e7f-8a9b-0c1d2e3f4a5b --yes
```

**Guardrails:**
- Refuses to run unless `claim.status == "paid"` (no payouts before Medi-Cal
  pays us)
- Refuses to run if a `stripe_transfer_id` already exists on the claim
  (prevents double-paying the CHW)

---

## 3. Pear Suite test harness

This is a smoke test tool — useful when you want to verify the Pear Suite
integration itself is healthy (their API is up, our auth is valid) rather
than troubleshoot a specific user or claim.

**When to use:**
- Pear Suite announced an API outage — verify recovery by running `golden-path`
- Suspect our API key has expired
- Periodic health check (e.g., every Monday morning)

**Syntax:**

```bash
docker exec -w /code compass-api python -m scripts.test_pear_suite <subcommand>
```

Subcommands:

| Subcommand | What it does |
|---|---|
| `eligibility <medi-cal-id>` | Verify a single member's Medi-Cal eligibility |
| `submit-claim` | Submit a synthetic test claim (does **not** touch the DB) |
| `status <pear-suite-claim-id>` | Poll the status of a previously submitted claim |
| `void <pear-suite-claim-id>` | Void an un-adjudicated claim |
| `golden-path [--medi-cal-id <CIN>]` | Run eligibility → submit → status end-to-end |

**Example — full health check:**

```bash
docker exec -w /code compass-api python -m scripts.test_pear_suite golden-path --medi-cal-id 9876543210
```

The harness prints each step and a final PASS / FAIL summary.

---

## 4. Common scenarios

### "CHW says they haven't been paid"

1. `ops user <chw-email>` — confirm they exist, are active, and CHW role
2. `ops chw-payout <chw-email>` — check Stripe onboarding + recent payouts
3. If `Payouts enabled: no` — ask them to finish onboarding in the app
4. If a specific claim hasn't been paid — get the session ID and run
   `ops session <session-id>` to see its billing claim + transfer status
5. If `claim.status == paid` but no `stripe_transfer_id` — `ops retry-payout <claim-id>`

### "Pear Suite rejected a claim"

1. `ops session <session-id>` — find the claim's rejection_reason
2. Decide whether it's a transient issue (retry) or a data issue (fix first, then retry)
3. If transient: `ops requeue-claim <claim-id> --yes`

### "Someone can't log in"

1. `ops user <email>` — verify `Active: True` and `Onboarded: True`
2. Check the email shows up (case-insensitive match)
3. If `Active: False`, ask Akram to reactivate (no CLI for this yet)

### "Member says a CHW never showed up"

1. Get the session ID from the member's app screen or ask the member
2. `ops session <session-id>` — see `status`, `started_at`, `ended_at`
3. If `status: scheduled` long after the scheduled time, the CHW no-showed —
   talk to the CHW and decide on refund / rebook

### "Weekly health check"

Every Monday:
1. `docker exec -w /code compass-api python -m scripts.test_pear_suite golden-path`
2. Check Sentry dashboard: https://compasschw.sentry.io → any new P1 issues?
3. Spot-check one recent paid claim with `ops session <id>` to see the full pipeline ran

---

## 5. Troubleshooting

### "permission denied" or "command not found: ops"

You forgot to set up the alias, or you're outside the EC2 host. Verify:

```bash
whoami          # should be 'ubuntu'
hostname        # should be 'ip-172-31-39-245'
type ops        # should show the alias
```

If the alias is missing, redo the `echo 'alias ops=…' >> ~/.bashrc; source ~/.bashrc` step.

### "No such file or directory: /code/scripts"

The container was rebuilt from an older image that didn't include the scripts.
Ping Akram — the fix is a rebuild + recreate.

### "Error: connection refused" when running `ops`

The API container is down. Check:

```bash
docker ps
```

If you don't see `compass-api` in the list, restart it:

```bash
docker start compass-api
```

If that doesn't help, ping Akram.

### "ModuleNotFoundError: No module named 'app'"

The container isn't running from `/code`. Make sure your alias includes
`-w /code` (it does in the setup above). If you're typing the full docker exec
line, include `-w /code`.

### "Stripe transfer failed"

Stripe transfers can fail for:
- CHW's bank rejecting (closed account, wrong routing)
- KYC issue on the CHW's Stripe account (Stripe suspended payouts)
- Platform balance too low (we owe more than we have on hand)

Check the Stripe dashboard: https://dashboard.stripe.com/connect/accounts
for the specific CHW. Ping Akram before retrying.

---

## 6. Emergency contacts

| Situation | Contact |
|-----------|---------|
| Platform down / API unreachable | Akram (text first) |
| Suspected data breach or unauthorized access | Akram → we follow the incident response playbook |
| Stripe payout issue you can't resolve | Akram + Stripe support (dashboard live chat) |
| Pear Suite API outage | Akram + their CTO (contact in phone) |
| Member / CHW threatening legal action | Jemal, escalate to counsel |

**Sentry issues:** https://compasschw.sentry.io
**AWS console:** https://console.aws.amazon.com → us-west-2
**Stripe dashboard:** https://dashboard.stripe.com

---

## Appendix — commands quick reference

```text
# Look something up (non-destructive)
ops user <id-or-email>
ops session <session-id>
ops chw-payout <id-or-email>

# Intervene (destructive — dry-run by default)
ops requeue-claim <claim-id>           # preview
ops requeue-claim <claim-id> --yes     # commit

ops retry-payout <claim-id>            # preview
ops retry-payout <claim-id> --yes      # commit

# Pear Suite smoke tests (not a daily tool)
docker exec -w /code compass-api python -m scripts.test_pear_suite eligibility <CIN>
docker exec -w /code compass-api python -m scripts.test_pear_suite submit-claim
docker exec -w /code compass-api python -m scripts.test_pear_suite status <claim-id>
docker exec -w /code compass-api python -m scripts.test_pear_suite void <claim-id>
docker exec -w /code compass-api python -m scripts.test_pear_suite golden-path
```
