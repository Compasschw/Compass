# CompassCHW — Complete Tech Stack & Cost Table

**Last updated:** April 19, 2026
**Currency:** USD unless noted

---

## 1. Infrastructure & Hosting

| Service | What It Does | Current Tier | Monthly (Now) | Monthly at Scale (500 sessions/mo) | Annual Cost Year 1 |
|---------|-------------|--------------|---------------|-----------------------------------|---------------------|
| **AWS EC2** (t3.micro) | Backend API host (Ubuntu 24.04 + Docker) | Free Tier | $0 | $8.50 (post-free-tier) | $0 |
| **AWS RDS** (db.t3.micro, PostgreSQL 16) | Primary database | Free Tier | $0 | $12.50 (post-free-tier) | $0 |
| **AWS S3** | PHI + public file storage | Pay as you go | ~$0.12 | ~$5 | ~$15 |
| **AWS SSM Parameter Store** | Secrets management | Free (default KMS) | $0 | $0 | $0 |
| **AWS CloudWatch** | Logs + metrics | Free Tier (5 GB/mo) | $0 | ~$5 | ~$30 |
| **AWS SES** | Transactional email (magic links, reminders) | Pay as you go | ~$0 | ~$1 (10K emails) | ~$5 |
| **AWS BAA** | HIPAA-covered contract | **Signed (free)** | $0 | $0 | $0 |
| **AWS Elastic IP** | Static backend IP | Free when attached | $0 | $0 | $0 |
| **Let's Encrypt** (via Certbot) | TLS certificates for api.joincompasschw.com | Free | $0 | $0 | $0 |
| **Vercel** | Frontend + landing page hosting (Expo web export) | Hobby (free) | $0 | $0 (until > 100GB bandwidth) | $0 |
| **GoDaddy** | Domain + DNS (joincompasschw.com) | Standard | ~$1.67 | ~$1.67 | **$20/year** |
| **Subtotal Infra** |  |  | **~$2/mo** | **~$33/mo** | **~$70/year** |

**Notes:**
- First 12 months of AWS are essentially free via Free Tier
- After free tier expires (~April 2027), estimated AWS bill: ~$30–50/mo
- Vercel can pay at scale if frontend bandwidth exceeds hobby limits (~$20/mo Pro)

---

## 2. Communication & PHI Services

| Service | What It Does | Current Tier | Monthly (Now) | Monthly at Scale | Notes |
|---------|-------------|--------------|---------------|------------------|-------|
| **Vonage** | Masked calling + SMS between CHW & member | **Not yet active** | $0 | ~$155 | Pending BAA signing |
| — Voice minutes | ~$0.008/min × 10,000 min | | | ~$80 | Per-second billing |
| — SMS | ~$0.0075/msg × 1,000 msgs | | | ~$8 | Per-message |
| — Phone numbers | $1/mo × 50 numbers (proxy pool) | | | ~$50 | Scales with session count |
| — Recording | Included | | | $0 | No extra charge |
| — Built-in transcription | Included (non-medical) | | | $0 | We route medical to AssemblyAI |
| **AssemblyAI** | Medical-grade transcription + PII redaction | **Not yet active** | $0 | ~$50 | Pending BAA |
| — $0.005/min × 10,000 min (base + medical) | | | | ~$50 | HIPAA BAA included |
| **Subtotal Comms** |  |  | **$0/mo** | **~$205/mo** | Activates at launch |

---

## 3. Medi-Cal Billing

| Service | What It Does | Cost Model | Notes |
|---------|-------------|-----------|-------|
| **Pear Suite** | Claims submission + adjudication tracking | **~15% of reimbursement** | Fees deducted from Medi-Cal payouts before CHW payout |
| — Platform fee (Compass side) | ~15% | | Per-claim |
| — BAA | Included | | Healthcare-focused, no separate fee |
| — API access | Free (key-based) | | Awaiting delivery from Pear Suite CTO |

**Not a fixed subscription** — Pear Suite's fee is proportional to revenue:
- At $26.66/unit Medi-Cal rate:
  - Pear Suite takes ~15% = ~$4/unit
  - CompassCHW takes ~10% = ~$2.67/unit
  - CHW net: ~$20/unit
- At 500 sessions/month × 2 units avg × $26.66 = **$26,660 gross revenue**
- Pear Suite fees: **~$4,000/mo**
- Compass fees: **~$2,667/mo**
- CHW payouts: **~$20,000/mo**

---

## 4. Payments & CHW Payouts (Stripe Connect)

CompassCHW is the merchant of record. Money flows:

```
Medi-Cal MCO → Pear Suite → CompassCHW (Stripe business account)
    → Compass retains 10-15% platform fee
    → Transfers net amount to CHW's Stripe Connect account
    → CHW withdraws to their personal bank via ACH
```

**Architecture:** Stripe Connect Express — CHWs onboard through a Stripe-hosted flow that collects SSN/EIN, bank info, and verifies identity (KYC). We never touch bank details. Stripe files 1099-NEC at year-end automatically for any CHW earning > $600.

| Service | What It Does | Cost Model | At 500 sessions/mo |
|---------|-------------|-----------|-------------------|
| **Stripe Connect Express** | CHW onboarding + payout rails | **No platform monthly fee** | $0 |
| — Connected account | Per-CHW (platform pays) | $0/mo per account | $0 |
| — ACH payout (standard, 2-day) | Per payout | **$0.25 / payout** | ~$5/mo (20 CHWs × weekly) |
| — Instant payout (optional, CHW-paid) | When CHW wants same-day | 1% of amount (CHW pays) | $0 (pass-through to CHW) |
| — 1099-NEC filing | Year-end tax reporting | **$2 / filing** (once/year) | ~$40/year |
| — Identity verification (KYC) | During onboarding | Included | $0 |
| — Fraud monitoring (Radar) | Included baseline | Included | $0 |
| **Receiving funds from Pear Suite** | Incoming ACH to Compass | 0.8% per transaction, capped at $5 | ~$5/mo (1-2 incoming/mo) |
| **Subtotal Payments** |  |  | **~$10-15/mo** |

**Notes:**
- Stripe Connect Express has **no per-account monthly fee** as of 2024 pricing (was $2/mo historically — removed)
- Biweekly payouts cut the transfer fee in half (~$2.50/mo at our scale)
- Instant payouts are optional — we can offer them as a perk but the CHW pays the 1% fee, not Compass
- Stripe requires our platform to provide Terms of Service and Privacy Policy URLs (we have both) and a support contact email
- Stripe doesn't sign HIPAA BAAs, but **payment info isn't PHI under HIPAA** — 45 CFR §164.501 carves out payment routing. So Stripe is safe to use without BAA. We still need to keep session details out of payment metadata (we already do).

### CHW Earnings Flow Example (one week)

| Event | Amount |
|-------|--------|
| CHW completes 5 sessions × 2 units | 10 units × $26.66 = $266.60 |
| Pear Suite fee (-15%) | -$40 |
| Compass platform fee (-10%) | -$26.66 |
| Stripe ACH payout fee (-$0.25 flat) | -$0.25 |
| **CHW receives in bank** | **~$199.69** (2 business days) |

### Year-End

At $20k/mo CHW payouts × 12 = **$240k paid out annually across ~20 CHWs**. Total Stripe platform fees: **~$200-300/year**. Every CHW earning > $600 gets a 1099-NEC auto-filed by Stripe ($2 each).

---

## 5. Mobile App Distribution

| Service | What It Does | Cost | Frequency |
|---------|-------------|------|-----------|
| **Apple Developer Program** (Organization) | iOS App Store distribution, push notifications, TestFlight | **$99** | Annual |
| **Google Play Console** (Individual → Org transfer) | Android distribution + Internal Testing | **$25** | One-time |
| **Expo EAS** (Free tier) | Mobile builds (iOS + Android + web) | **$0** | Monthly — up to 30 builds |
| **Expo EAS** (Production tier — if needed) | More builds + priority | **$99** | Monthly (only if we exceed free tier during heavy iteration) |
| **Apple Push Notification Service** | iOS push delivery | Free | Included with Apple Dev |
| **Firebase Cloud Messaging** | Android push delivery | Free | No paid tier needed at MVP scale |
| **D-U-N-S Number** (for Apple org) | Dun & Bradstreet ID required for org accounts | **$0** (free if you request through Apple) | One-time |
| **Subtotal Mobile** |  | **~$124 year 1** |  |

---

## 6. Observability & Ops

| Service | What It Does | Current Tier | Monthly |
|---------|-------------|--------------|---------|
| **Sentry** | Backend error tracking + performance monitoring | Developer (free) | **$0** |
| — Free tier: 5K errors/mo, 1 project, 1 user | | | |
| — Team tier: $26/mo if we exceed (unlikely at MVP) | | | |
| **UptimeRobot** | API uptime monitoring (5-min intervals) | Free | **$0** |
| — 50 monitors on free plan; we only need 2-3 | | | |
| **Subtotal Ops** |  |  | **$0/mo** |

---

## 7. Development & CI/CD

| Service | What It Does | Tier | Monthly |
|---------|-------------|------|---------|
| **GitHub** | Code hosting, PR reviews, Actions CI | Free | **$0** |
| — 2,000 Actions minutes/mo on free tier (we use ~200) | | | |
| **Claude Code** (this session) | AI pair programming | Already subscribed | Existing |
| **Subtotal Dev** |  |  | **$0/mo** |

---

## 8. Compliance & Legal

**Policy: self-managed compliance through scale.** DIY training + template policies + periodic self-audits. Revisit paid compliance services when we cross 50+ real CHWs or pursue enterprise contracts that require SOC 2.

| Service | What It Does | Cost | When |
|---------|-------------|------|------|
| **Paubox Academy / HIPAA Exams** | HIPAA workforce training + certificates | **$30-50/person** | Before first real PHI — one-time per employee |
| **Legal counsel** (one-time review) | Attorney review of the 4 docs in `docs/legal/` + risk assessment | **$300-500** | Before first real PHI |
| **EIN** (IRS) | Federal tax ID for the LLC | **$0** | Applied (pending) |
| **D-U-N-S Number** | Required for Apple Developer Org | **$0** via Apple | After EIN |

**Not planned:**
- ~~Accountable HQ~~ ($249/mo) — deferred indefinitely; DIY compliance sufficient at MVP scale
- ~~Drata / Vanta~~ ($800-2,000/mo) — only if enterprise contracts require SOC 2 later

---

## 9. Business Services (One-Time)

| Item | Cost | Status |
|------|------|--------|
| LLC formation (CompassCHW, LLC) | ~$70 (CA + state fees) | Already formed |
| Registered agent annual fee | ~$100/year | Already engaged |
| Business bank account | Usually free for LLCs | TBD |
| Business insurance (E&O + Cyber — HIPAA helpful) | ~$1,500/year | **Recommended before launch** |
| Accounting software (QuickBooks or Wave) | $0-30/mo | Optional for now |

---

## Total Monthly Cost Summary

### Pre-Launch (today)

| Category | Monthly |
|----------|---------|
| AWS + Vercel + GoDaddy | **~$2** |
| Vonage (not active) | $0 |
| AssemblyAI (not active) | $0 |
| Sentry (free tier) | $0 |
| Expo EAS (free tier) | $0 |
| GitHub (free) | $0 |
| **Total** | **~$2/mo** |

### At Launch (when real users are using it)

| Category | Monthly |
|----------|---------|
| AWS (post free tier) | ~$30 |
| Vercel (hobby) | $0 |
| GoDaddy | ~$2 |
| Vonage (500 sessions/mo) | ~$155 |
| AssemblyAI (10K min/mo) | ~$50 |
| Stripe Connect payout fees | ~$10-15 |
| Sentry | $0 |
| Expo EAS | $0 |
| **Total** | **~$250/mo** |

### Annual Costs (Year 1)

| Item | Cost |
|------|------|
| Apple Developer Program | $99 |
| Google Play Console (one-time) | $25 |
| Domain renewal | $20 |
| HIPAA training (3 founders × $50) | $150 |
| Legal review | $500 |
| Business insurance | $1,500 |
| **Total one-time + annual** | **~$2,294 year 1** |

---

## Total Year 1 Cost Projection

| Scenario | Infra (12 mo) | One-time | **Total Year 1** |
|----------|---------------|----------|------------------|
| **Pre-launch only** (no real traffic) | $24 | $2,294 | **~$2,318** |
| **Modest launch** (100 sessions/mo) | ~$300 | $2,294 | **~$2,594** |
| **Target launch** (500 sessions/mo) | $3,000 (avg with ramp) | $2,294 | **~$5,294** |
| **Growth phase** (2,000 sessions/mo) | $7,800+ | $2,294 | **~$10,094+** |

---

## Revenue Offset

At 500 sessions/mo × $26.66/unit × 2 units avg × 10% platform fee:
**~$2,667/mo gross revenue to CompassCHW**

At that volume, platform revenue covers infra cost ~11×. The business is cash-flow positive on infrastructure from day 1 of billable sessions.

---

## Recommended Pre-Launch Spend (~$575 out of pocket)

To go from "still missing pieces" to "actually launch-able":

| Item | Cost | Priority |
|------|------|----------|
| Apple Developer Program | $99 | Blocked on EIN/DUNS |
| Google Play Console | $25 | Can do now |
| HIPAA training × 3 founders | $150 | Do in parallel |
| Legal review of template docs | $300-500 | Before first real PHI |
| **Total** | **~$575-775** |  |

Business insurance ($1,500) is strongly recommended but can wait until first paying member.

---

## Credentials / API Keys We Need (Not Cost-Bearing)

| Vendor | Status | Blocker |
|--------|--------|---------|
| AWS | ✅ Signed BAA, active account |  |
| Vonage | ❌ No account yet | Contact sales + BAA |
| AssemblyAI | ❌ No account yet | Contact sales + BAA |
| Pear Suite | ❌ No API key yet | Follow up with CTO |
| **Stripe** | ❌ No account yet | Can do now — requires EIN for business verification |
| Sentry | 🟡 Account signup pending | 5-min self-serve |
| Apple Developer | ❌ No account | EIN → DUNS → apply |
| Google Play | ❌ No account | Can do now ($25) |
| Expo | ✅ Account + EAS project linked |  |

---

## What This Means

- **Pre-launch burn rate:** ~$2/mo, basically nothing
- **Launch burn rate:** ~$250/mo, very modest
- **Growth burn rate:** ~$800/mo at 2,000 sessions/mo — still capital-efficient
- **Unit economics:** Positive from the first real billable session — infra + payout cost is <1% of gross revenue
- **CHW payouts:** Secured via Stripe Connect Express. CHWs onboard through a Stripe-hosted KYC flow; funds flow to their bank in 2 business days (or same-day for a 1% fee they pay). Stripe files 1099-NEC automatically at year-end.
- **Compliance posture:** DIY HIPAA training + signed template policies. Revisit paid compliance services only if we pursue enterprise contracts requiring SOC 2 Type II.

The tech stack is **intentionally lean**. Every vendor we use has a HIPAA BAA pathway, free tiers that cover MVP usage, and pay-per-use pricing that aligns with revenue. No long-term commitments, no enterprise contracts, no wasted spend.
