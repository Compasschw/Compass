# SES Go-Live Runbook — Production Email for joincompasschw.com

Transactional email (signup welcome, password reset, password-changed notice,
magic links) is fully built and wired behind `services/email` (SES provider).
All sends are **best-effort**: until this runbook is executed they log and
no-op safely. Executing it turns every email feature on at once — no deploy
needed.

Owner: Akram. Estimated effort: ~20 min of clicking + a 1-2 day AWS review wait.

---

## 1. Verify the domain + DKIM (SES console)

1. AWS Console → **SES** (region `us-west-2` — must match `aws_region` in config) →
   **Verified identities** → `joincompasschw.com`.
2. If the identity doesn't exist: **Create identity** → *Domain* →
   `joincompasschw.com` → Easy DKIM (RSA_2048).
3. SES shows **3 DKIM CNAME records**. Add all three in the DNS provider
   (wherever joincompasschw.com's DNS lives — Vercel DNS or the registrar):
   - `<token1>._domainkey.joincompasschw.com` → `<token1>.dkim.amazonses.com`
   - `<token2>._domainkey.joincompasschw.com` → `<token2>.dkim.amazonses.com`
   - `<token3>._domainkey.joincompasschw.com` → `<token3>.dkim.amazonses.com`
4. Wait for the identity status to flip to **Verified** (minutes to a few
   hours after DNS propagates).
5. Recommended while in DNS: add/confirm an SPF include for SES on the root
   TXT (`v=spf1 include:amazonses.com ~all`) and a basic DMARC record
   (`_dmarc` TXT: `v=DMARC1; p=none; rua=mailto:privacy@joincompasschw.com`).
   Not strictly required by SES, but materially improves inbox placement.

## 2. Request production access (leave the sandbox)

SES console → **Account dashboard** → "Your account is in the sandbox" →
**Request production access**.

Template for the request form:

- **Mail type:** Transactional
- **Website:** https://joincompasschw.com
- **Use-case description:**
  > CompassCHW is a healthcare coordination platform connecting Community
  > Health Workers with members in Los Angeles County. We send only
  > transactional account emails to our registered users: signup
  > confirmations, password-reset links, and security notifications.
  > No marketing email. Volume: well under 1,000/month at launch.
  > Every email includes a clear sender identity and support contact;
  > recipients are exclusively users who created accounts on our platform.
- **Additional contacts / process:** bounces and complaints are monitored via
  the SES console; support@joincompasschw.com is staffed.

Approval usually lands within 24-48h. Until then, sends to unverified
addresses fail (and are swallowed by the best-effort layer).

## 3. Fix the prod sender address

Prod currently has a temporary `EMAIL_FROM=akram@...` in the EC2 `.env`.
Move it to SSM like the other secrets so deploys hydrate it (deploy.yml
Step 1b):

```bash
aws ssm put-parameter --region us-west-2 --type SecureString --overwrite \
  --name /compass/prod/EMAIL_FROM --value "noreply@joincompasschw.com"
```

Then add `EMAIL_FROM` to the `SSM_KEYS` list in `.github/workflows/deploy.yml`
(one-word change) — or set it directly in the EC2 `.env` via SSM session as an
interim step.

Optional: `EMAIL_REPLY_TO=support@joincompasschw.com` (config supports it) so
member replies land in the staffed support group.

## 4. Confirm runtime config

On the prod box (SSM session → `cd /home/ubuntu/compass/backend`):

```bash
grep -E "EMAIL_PROVIDER|EMAIL_FROM|EMAIL_REPLY_TO" .env
```

- `EMAIL_PROVIDER` should be `ses` (it's also the code default — absent is fine).
- `EMAIL_FROM=noreply@joincompasschw.com` after step 3.
- Restart containers (`docker compose up -d`) or just let the next deploy pick
  it up.

## 5. Post-approval smoke test (5 minutes)

1. Register a fresh test account with a real inbox you control →
   **welcome email** arrives (check spam the first time; DKIM pass expected).
2. On the sign-in page → "Forgot password?" → submit that address →
   **reset email** arrives → link opens `/auth/reset-password?token=…` →
   set a new password → old password rejected, new one signs in →
   **password-changed notice** arrives.
3. SES console → account dashboard: confirm both sends registered, zero
   bounces/complaints.

## Notes

- HIPAA: these emails intentionally contain **no PHI** — no health data, no
  CHW/member relationships; just account-level facts. Keep it that way when
  editing copy. (SES is on AWS infrastructure under the AWS BAA.)
- The email layer never blocks or fails a request — a SES outage degrades to
  logged no-ops, identical to today's sandbox behavior.
