# Blockers & Action Plan — April 18, 2026

**Context corrections from founding team:**

1. **Expo React Native is the official codebase.** Not a migration to be re-evaluated. The `web-legacy/` and `web/` directories should be removed to eliminate confusion.

2. **Partner logos are legitimate** — Kaiser, Molina, Health Net, and Anthem are accessible through the Pear Suite billing integration layer. Post-CTO meeting, API docs inbound. The logos need clarifying text on the landing page (e.g., "Integrated billing via Pear Suite → Kaiser, Molina, Health Net, Anthem, and more") so VCs immediately understand the relationship rather than assuming direct partnerships.

With those corrections, here's the refined problem set.

---

## BLOCKERS (Ordered by Severity)

### Tier 1 — Ship-Stoppers (Fix This Week)

| # | Blocker | Location | Impact | Est. |
|---|---------|----------|--------|------|
| B1 | **Duplicate Alembic migrations** | `a3f1b2c4d5e6` + `a3f1bc209e44` | Next `alembic upgrade head` on fresh DB will fail | 5 min |
| B2 | **Hardcoded admin key in source** | `backend/app/routers/admin.py:21` | Anyone with git access reads waitlist PII | 30 min |
| B3 | **Admin key in query string** | `GET /admin/waitlist?key=...` | Key leaks to Nginx/CDN/browser history logs | 15 min |
| B4 | **Admin page has no server-side auth** | JS-only protection | Disabled JS or curl reveals SPA shell | 30 min |
| B5 | **`loginMock` reachable in production** | `native/src/context/AuthContext.tsx` | Network blip = demo access with no server validation | 15 min |
| B6 | **ErrorBoundary not wired at root** | `native/App.tsx` | Any render error = blank white screen | 5 min |
| B7 | **CI failing on every commit** | All 5 recent runs red (ruff I001) | Team shipping through red builds | 15 min |
| B8 | **Frontend CI targets dead `web/` directory** | `.github/workflows/ci.yml` | `native/` has zero CI coverage | 10 min |

**Total Tier 1 work: ~2 hours**

### Tier 2 — HIPAA Blockers (Before Real PHI)

| # | Blocker | Requirement | Est. |
|---|---------|-------------|------|
| B9 | **AuditLog model never written to DB** | 45 CFR 164.312(b) — audit controls | 2 hrs |
| B10 | **CHW requests endpoint leaks member descriptions** | 164.514(d) — minimum necessary | 1 hr |
| B11 | **`medi_cal_id` stored in plaintext** | 164.312(a)(2)(iv) — PHI encryption at rest | 2 hrs |
| B12 | **No data deletion endpoint** | 164.526 — right of access | 2 hrs |
| B13 | **No upload MIME/size validation** | Security hardening + PHI upload safety | 30 min |
| B14 | **Vonage BAA unsigned** | Required before call recording goes live | — |

**Total Tier 2 work: ~7.5 hours (+ BAA coordination)**

### Tier 3 — Business Logic & Data Integrity

| # | Blocker | Impact | Est. |
|---|---------|--------|------|
| B15 | **Billing cap check uses `created_at` not `service_date`** | Session near midnight hits wrong day's cap → Medi-Cal non-compliance | 1 hr |
| B16 | **Phone numbers not wired into communication layer** | Vonage integration can't route real calls even once credentials added | 2 hrs |
| B17 | **Rate limiting is in-memory** (per-worker) | Under 2 Uvicorn workers, effective limit 10/min not 5/min | 1 hr |
| B18 | **Waitlist GET accessible to any auth user** | Any CHW/member can read all PII (TODO in code) | 5 min |

**Total Tier 3 work: ~4 hours**

### Tier 4 — Repo Hygiene (Reduce Confusion)

| # | Blocker | Action | Est. |
|---|---------|--------|------|
| B19 | **Dead frontend directories** | Delete `web/`, `web-legacy/`, `landing-new/` (or move to `.archive/`) | 15 min |
| B20 | **`mock.ts` conflates mocks + constants** | Split into `types/domain.ts` + `data/constants.ts` + `data/mock.ts` | 1 hr |
| B21 | **Footer links are decorative** | Wire onPress to real pages or remove | 30 min |
| B22 | **`loginMock` still in production AuthContext** | Delete or guard behind `__DEV__` (overlaps B5) | 15 min |

**Total Tier 4 work: ~2 hours**

### Tier 5 — Landing Page Clarification

| # | Blocker | Action | Est. |
|---|---------|--------|------|
| B23 | **Partner logos lack context** | Add "Integrated billing via Pear Suite → Kaiser, Molina, Health Net, Anthem, and more" qualifier below logo slider | 15 min |
| B24 | **Zero social proof / real CHW quotes** | Blocked on customer discovery (non-code) | — |
| B25 | **Business model not on public landing** | Add "How CHWs earn" section with unit economics ($26.66/unit × X = $Y/day) | 45 min |
| B26 | **"First gig marketplace for CHWs" wedge missing** | Add differentiation headline/tagline | 15 min |

**Total Tier 5 work: ~75 min**

### Tier 6 — Non-Code (Unblocks Investor Readiness)

| # | Blocker | Owner | Why |
|---|---------|-------|-----|
| N1 | **0 CHW conversations documented** | Jemal | The single most important signal for VCs — zero movement in 9 days |
| N2 | **No LOIs** | Jemal | Letters of intent from willing CHWs are the bridge from waitlist to traction |
| N3 | **No pitch deck in repo** | JT | Not visible; needed before VC meetings |
| N4 | **Pear Suite API docs not yet integrated** | Akram | User mentioned these are inbound |
| N5 | **HIPAA workforce training** | All founders | Required before accessing real PHI |
| N6 | **Cost model (CAC, burn, raise size)** | Akram + Jemal | VCs ask this in first 5 minutes |

---

## ACTION PLAN — Sequenced by Dependency

### Day 1 (This Session) — Kill the Critical Issues (~2 hrs)

**Parallel Track A: Security & Infra Quick Fixes**
- [ ] B1: Delete `a3f1bc209e44_add_suggested_units_to_sessions.py`
- [ ] B2: Move `ADMIN_KEY` to `config.py` with startup validation (min length check)
- [ ] B3 + B4: Rewrite admin auth — require `Authorization: Bearer <token>` header, return 401 at API level
- [ ] B7: Run `ruff check backend/app --fix` and commit
- [ ] B8: Update `.github/workflows/ci.yml` — change `working-directory: web` to `working-directory: native`

**Parallel Track B: Frontend Critical Fixes**
- [ ] B5 + B22: Delete `loginMock` or guard behind `if (__DEV__)`
- [ ] B6: Wrap `<AppNavigator />` with `<ErrorBoundary />` in `App.tsx`
- [ ] B23: Add Pear Suite integration context below partner logo slider

**Verify:**
- [ ] Push, confirm CI goes green
- [ ] Deploy backend to EC2
- [ ] Confirm `curl -s https://api.joincompasschw.com/api/v1/health` still OK
- [ ] Test admin page with new auth flow

### Day 2 — HIPAA Readiness Wave 1 (~4 hrs)

- [ ] B9: Wire `AuditMiddleware` to insert rows into `AuditLog` table (action, resource, user_id, IP)
- [ ] B10: Split `ServiceRequestResponse` — remove `description` from list view, keep in detail view post-accept
- [ ] B13: Add MIME allowlist + size cap to `upload.py` schema
- [ ] B18: Change waitlist GET from `get_current_user` to `require_role("admin")` (create admin role if needed)
- [ ] B15: Add `service_date: Date` column to `BillingClaim`, update `check_unit_caps` query

### Day 3 — HIPAA Readiness Wave 2 (~4 hrs)

- [ ] B11: Create `EncryptedString` TypeDecorator for `medi_cal_id` (AES-256 with key from SSM)
- [ ] B12: Add `DELETE /api/v1/member/account` with cascade rules (soft delete with 30-day retention)
- [ ] B16: Add `phone` field to User model, wire into communication layer
- [ ] B17: Add Redis dependency for slowapi backend (or defer until scaling past 1 instance)

### Day 4 — Repo Cleanup + Landing Polish (~3 hrs)

- [ ] B19: Delete `web/`, `web-legacy/`, `landing-new/` (or move to `.archive/` if anything's worth keeping)
- [ ] B20: Split `data/mock.ts` into `types/domain.ts`, `data/constants.ts`, `data/mock.ts` (clearly labeled)
- [ ] B21: Wire footer links to real destinations (or create placeholder pages)
- [ ] B25: Add "How CHWs earn" section to landing with real unit economics
- [ ] B26: Add wedge statement to hero copy

### Day 5 — Pear Suite Integration Layer (~1 day, once API docs arrive)

- [ ] Design `BillingProvider` abstraction (mirror the Communication provider pattern)
- [ ] Implement `PearSuiteProvider` adapter
- [ ] Claims submission flow: session documentation → Pear Suite API
- [ ] Eligibility verification: member check → Pear Suite API
- [ ] Update landing page stats with real billing coverage

### Days 6-14 — Non-Code Push (Parallel, Non-Engineering)

- [ ] **N1:** Jemal schedules 10 CHW conversations this week
- [ ] **N2:** Get 3 verbal commitments → convert to written LOIs
- [ ] **N3:** JT drafts pitch deck v1
- [ ] **N5:** All founders complete HIPAA training
- [ ] **N6:** Akram + Jemal draft cost model (CAC, burn, $500K raise justification)

---

## Priority Heatmap

```
IMPACT →
  HIGH                                                 LOW
 ┌─────────────────────────────────────────────────────────┐
U│ N1 CHW conversations       │ B23 Partner logo label    │
R│ B1 Duplicate migration     │ B19 Delete dead dirs      │
G│ B2 Hardcoded admin key     │ B21 Footer links          │
E│ B9 Audit logging to DB     │                           │
N│ B10 Requests leak          │                           │
C│────────────────────────────┼───────────────────────────│
Y│ B11 medi_cal_id encrypt    │ B20 Split mock.ts         │
 │ B15 Billing cap date       │ B25 Unit economics copy   │
L│ N4 Pear Suite API docs     │                           │
O│                            │                           │
W│                            │                           │
 └─────────────────────────────────────────────────────────┘
```

**Top-left quadrant is where the next sprint lives. Tier 1 (ship-stoppers) + Tier 2 (HIPAA blockers) + N1 (CHW conversations).**

---

## Success Criteria

**End of Day 1:**
- Zero CI failures
- No hardcoded secrets in source
- Alembic chain linear
- Admin page server-auth'd
- `loginMock` not reachable in production

**End of Day 3:**
- AuditLog actively writing to DB
- `medi_cal_id` encrypted at rest
- Billing cap uses correct date
- All HIPAA technical safeguards in place
- System is ready to accept real member data (once BAAs are signed + workforce training complete)

**End of Week 2:**
- 10+ documented CHW conversations
- 3 LOIs in hand
- Pear Suite billing integration wired
- Pitch deck v1 drafted
- Waitlist at 50+ real signups (from current 7)

**Goal:** Move investor readiness from 4.5/10 to 7.0/10 in 2 weeks. Technical foundation is solid — the gap is customer evidence.

---

## What We're NOT Going to Do

Based on the agents' suggestions that don't apply given the corrected context:

- ❌ **Reconsider the Expo migration** — decision is final, it's the official codebase
- ❌ **Split the landing page into a separate Vite/Next.js site** — one codebase intentional for iOS/Android/web
- ❌ **Replace partner logos** — they're legitimate via Pear Suite integration
- ❌ **Add tablet breakpoint (768px)** — mobile-first design is intentional for the CHW use case
- ❌ **Pursue Twilio** — Vonage remains the recommendation; architecture is provider-agnostic for future flexibility

---

*Action items reference IDs match those in `COMPASS_AUDIT_REPORT_2026-04-18.md`. Revisit this plan after Day 3 to measure progress.*
