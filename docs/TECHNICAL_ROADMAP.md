# CompassCHW — Technical Roadmap

**Last updated:** April 20, 2026
**Author:** Akram Mahmoud, CTO
**Audience:** Founders (Jemal, TJ), Pear Suite partners, prospective investors

---

## Executive summary

CompassCHW is a HIPAA-regulated digital health platform that connects California
Medi-Cal Community Health Workers (CHWs) with members eligible for **CalAIM
Community Supports**. The platform bills Medi-Cal Managed Care Plans (MCPs) via
our billing partner **Pear Suite** and pays CHWs through **Stripe Connect**.

We are executing in three phases:

| Phase | Goal | Timeline | Status |
|-------|------|----------|--------|
| **Phase 1 — Pilot** | First paid billing claim through Pear Suite, 3-5 CHWs onboarded, 10-20 members served | April → June 2026 | **~80% infrastructure complete** |
| **Phase 2 — Scale** | Multi-MCP expansion (Health Net list outreach), voice AI, incentive layer, ops dashboard | July → December 2026 | Scoped |
| **Phase 3 — Growth** | B2B2C integrations, predictive outreach, CHW certification tracking, multi-state | 2027+ | Directional |

---

## Current state (April 20, 2026)

### Shipped and live in production

- **Backend** (FastAPI + Python 3.12 + Postgres 16 on AWS, dockerized)
  - Auth, RBAC (member / CHW / admin), magic-link passwordless sign-in
  - Session lifecycle: request → accept → schedule → conduct → bill
  - Messaging + document uploads with S3 presigned URLs
  - Audit logging, AES-256-GCM field-level PHI encryption, request redaction
  - Background scheduler (session reminders, claim retries, Stripe payouts)
  - Cursor-based pagination on all list endpoints
  - Admin endpoints for ops visibility
- **Mobile apps** (Expo React Native 0.81, iOS / Android / Web from one codebase)
  - Member app: onboarding, request CHW, sessions, roadmap, calendar, messaging, documents, profile
  - CHW app: dashboard, requests, sessions, calendar, earnings (+ Stripe payout onboarding), profile
- **Integrations**
  - AWS SES email (BAA covered) — **live**
  - Expo push notifications (APNs / FCM) — **live**
  - Sentry crash reporting + tracing — **live**
  - AWS Systems Manager Session Manager — replaces SSH for prod access
- **Integrations scaffolded** (architected provider-agnostic; awaiting external unlocks)
  - Pear Suite billing — awaiting API key
  - Stripe Connect Express — awaiting EIN → Stripe account
  - Vonage masked calling — awaiting signed BAA
  - AssemblyAI medical-grade transcription — awaiting signed BAA

### Security & compliance posture

- HIPAA Tier 1 blockers resolved (secret management, admin auth, migrations, CI)
- HIPAA Tier 2 controls implemented (audit log on PHI access, account deletion, upload validation, PHI encryption at rest + in transit)
- Privacy Policy, Terms of Service, and BAA templates drafted (awaiting legal review)
- SSH replaced by AWS SSM Session Manager (reduces attack surface)
- Self-administered HIPAA training path scoped ($30-50 per workforce member)

---

## Phase 1 — Pilot launch (target: June 15, 2026)

**Thesis:** Prove the revenue path works end-to-end with one MCP and one Hub
partner. Ship the smallest surface that clears a billing claim and pays a CHW.

### In scope

| Category | Deliverable | Status |
|----------|-------------|--------|
| Billing | First claim submitted + paid via Pear Suite | Blocked on API key |
| Payouts | CHW onboarded to Stripe Connect + receives first payout | Blocked on EIN |
| Distribution | Member + CHW apps live on TestFlight | Blocked on Apple Dev org account |
| Compliance | Signed BAAs with all PHI vendors + completed HIPAA training | Outreach pending |
| Legal | Privacy Policy, ToS, BAA reviewed by counsel | Pending engagement |
| Operations | TJ manually reconciles sessions + claims | Spreadsheet-grade OK |
| Pilot partners | 1 MCP signed, 1 Hub / community org signed, 3-5 CHWs recruited | Jemal owns |

### Explicitly out of scope for Phase 1

- Voice AI outreach
- Automated member enrollment from MCP-provided lists
- Incentive fulfillment (Tango / Tremendous)
- Admin dashboard UI (we will use raw Postgres queries + backend admin endpoints)
- Spanish language UI
- Offline mode for CHW app
- Multi-MCP support (single MCP in Phase 1)

### Critical path to pilot

```
EIN issued
  ├─ DUNS number → Apple Developer org → TestFlight → CHW beta
  ├─ Stripe Connect platform account → STRIPE_* env vars → payout testing
  └─ Hub partner signed MSA
          │
          ├─ Pear Suite API key → billing smoke test → live claim
          ├─ Vonage BAA signed → masked calling live
          ├─ AssemblyAI BAA signed → transcription live
          ├─ Legal review complete → Privacy Policy + ToS live
          └─ HIPAA training complete for all workforce members
                  │
                  └─ First paid claim → pilot complete
```

### Phase 1 technical risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Pear Suite integration surprises us (data model mismatch, rate limits) | Medium | Provider-agnostic adapter pattern lets us fall back to direct 837P if needed |
| Apple Developer account delay (DUNS can take weeks) | Medium | Expo web build can serve as demo surface while we wait |
| CHW has compliance issue with Stripe 1099 / KYC | Low | Stripe Connect Express handles 1099 filing + KYC — well-trodden path |
| Webhook reliability (Stripe / Pear Suite / Vonage) | Medium | Idempotency keys + background retry queue already in place |
| RDS single-AZ failure | Low | t3.micro pilot config; migrate to Multi-AZ before first revenue |

### Success metrics

- [ ] 1 paid Medi-Cal billing claim completed end-to-end
- [ ] 1 CHW paid via Stripe Connect
- [ ] 3 CHWs actively using the app (≥5 sessions each)
- [ ] 10 unique members onboarded
- [ ] Zero Sentry-reported P1 bugs in production for 2 weeks
- [ ] All HIPAA workforce training completed + certs on file

---

## Phase 2 — Scale & extend (July → December 2026)

**Thesis:** With a proven revenue unit, multiply. Automate enrollment, expand
coverage, add the outcomes-to-revenue loops that make CalAIM work.

### Workstreams

#### 2a. Voice AI outreach (Q3 2026)

- Input: Health Net or partner MCP provides attributed member lists
- Pipeline: Member list → AI voice agent → warm lead → CHW scheduled
- Platform evaluation: **Bland, Vapi, Retell** (decision required before build)
- Unit economics: target < $5 outreach cost per signed member

#### 2b. Incentive fulfillment layer (Q3 2026)

- Rules engine: outcome → reward mapping (e.g., "completed 3 sessions" → $25 Visa gift)
- Provider: Tango Card or Tremendous (Rewards API)
- Compliance: CalAIM cash equivalency rules — Jemal owns legal confirmation
- Reporting: reward ledger visible to CHW, member, and MCP

#### 2c. Admin / ops dashboard (Q3 2026)

- Web-based (React + shadcn/ui), served from Vercel
- Views: sessions, claims, users, audit log, funnel metrics
- Replaces TJ's manual spreadsheet reconciliation
- Access-controlled via `ADMIN_KEY` header + IP allowlist

#### 2d. Analytics + outcomes pipeline (Q4 2026)

- Event stream: user actions → internal warehouse (DuckDB or TimescaleDB)
- Outcome tracking: ED utilization reduction, PCP connection rate, social-needs resolution
- Feeds MCP quarterly performance reports

#### 2e. Spanish language support (Q4 2026)

- UI translation via next-i18next pattern
- CHW language capability on profile
- Match members to Spanish-speaking CHWs by preference

#### 2f. Offline mode for CHW app (Q3 2026)

- Local queue (AsyncStorage) for session notes taken at community hubs
- Sync reconciliation on reconnect with conflict resolution
- Critical for field use at Hub events where wifi is spotty

### Phase 2 technical investments

| Investment | Why |
|------------|-----|
| RDS Multi-AZ | Once revenue is flowing, single-AZ is not acceptable |
| API rate limits (per-user) | Abuse prevention as the surface expands |
| Feature flag system | Dark-launch Phase 2 features without shipping code paths to all users |
| SOC 2 Type I readiness | Enterprise MCP procurement often asks for this |
| Internal BI / warehouse | Replace ad-hoc Postgres queries for reporting |

### Phase 2 success metrics

- 5+ MCPs integrated
- 50+ active CHWs
- 500+ members enrolled
- $200K+ monthly GMV through platform
- < 2% month-over-month churn on active CHWs
- 95th-percentile API latency < 300ms

---

## Phase 3 — Growth (2027+)

Directional only — to be refined after Phase 2 data.

- **Multi-state expansion** — infrastructure to support Medicaid programs beyond CalAIM. Texas, Washington, Minnesota are likely candidates based on CHW program maturity.
- **B2B2C MCP integrations** — deeper data pipes with MCPs (HL7 FHIR, ADT feeds), not just claim submission.
- **Predictive outreach** — ML models over claim history to identify members most likely to engage + benefit.
- **CHW continuing education + certification tracking** — built into the app; partnership opportunity with CHW training bodies.
- **Benefits advocacy layer** — expand CHW scope to navigate SNAP, housing, utility assistance. Aligns with CalAIM's "whole person" goal.
- **CHW marketplace liquidity features** — ratings, reviews, specializations, dynamic matching algorithms.

---

## Architectural principles

These hold across all phases.

1. **Provider-agnostic integrations.** Every external service (billing, payments, transcription, email, SMS, notifications) goes through a thin adapter behind an abstract base class. Swapping providers is a config change.
2. **HIPAA by default.** PHI is encrypted at rest and in transit. Every PHI read is audit-logged. BAAs are non-negotiable for any vendor that sees PHI.
3. **Idempotency on all write boundaries.** Webhooks, payout triggers, and claim submissions all carry idempotency keys tied to the domain object.
4. **Server is source of truth.** The mobile apps are thin clients. Business logic lives server-side. Apps survive backend upgrades without forced updates.
5. **Fail-open for non-critical paths.** Notifications, emails, and background jobs never block the primary request flow.
6. **One shared UI codebase for iOS, Android, and web.** Expo + React Native Web. Saves ~60% of frontend engineering cost.
7. **Feature flags over branches.** Dark-launch, not long-lived branches.
8. **Observability is a first-class feature.** Sentry for exceptions, CloudWatch for infra, structured logs for the rest.

---

## Stack decisions (locked for Phase 1)

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Backend language | Python 3.12 | Fast to write, strong HIPAA-friendly tooling, Akram primary language |
| Backend framework | FastAPI | Async-first, automatic OpenAPI, pydantic validation at the boundary |
| Database | Postgres 16 (AWS RDS) | ACID, JSONB for flexible fields, mature |
| Mobile | Expo + React Native 0.81 | iOS + Android + Web from one codebase; no bespoke per-platform team |
| Auth | JWT access + refresh tokens + magic link | No password surface |
| Cloud | AWS (us-west-2) | Signed BAA, strongest compliance story, mature HIPAA playbook |
| Email | AWS SES | In-BAA, cheapest, deliverability solved |
| Push | Expo Notifications | Single SDK covers APNs + FCM |
| Billing | Pear Suite | Partner relationship; we are not in the 837P business |
| Payouts | Stripe Connect Express | Industry standard for 1099 marketplace payouts |
| Transcription | AssemblyAI (medical model) | Only vendor with both HIPAA BAA and medical-vocab model at reasonable cost |
| Masked calling | Vonage | BAA-eligible; ecosystem mature |
| Crash reporting | Sentry | Free tier covers pilot; scales affordably |

---

## Appendix — Open decisions requiring founder alignment

1. **Voice AI platform selection** — Bland vs. Vapi vs. Retell. Target: Q2 2026 decision after Phase 1 feedback.
2. **Whether to build admin dashboard before or after pilot** — my recommendation: after. Raw SQL + admin endpoints serve TJ in Phase 1. Dashboard is Phase 2a deliverable.
3. **Pursuing SOC 2 Type I** — cost ($15-25K) and time (~3 months with a firm like Vanta) significant. Defer unless MCP contract requires it.
4. **Multi-MCP data model** — currently a single-tenant schema. Phase 2 requires clean separation of MCP attribution, claims pools, and payout rails. Design spike needed Q3.
5. **FHIR adoption** — not required for pilot, but MCPs increasingly expect FHIR-compliant data exchange. Consider for Phase 2c analytics pipeline.

---

## Version history

| Date | Change |
|------|--------|
| 2026-04-20 | Initial version (Phase 1/2/3 defined after Stripe + Sentry + SSM deployment) |
