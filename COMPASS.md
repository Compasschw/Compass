# Compass

> **The first gig-economy marketplace for Community Health Workers.**
> Founded by Akram Mahmoud, Jemal Hussein, and John Thomas.
> Last updated: 2026-04-04

---

## Table of Contents

1. [Mission & Vision](#mission--vision)
2. [The Problem](#the-problem)
3. [The Solution](#the-solution)
4. [Competitive Landscape](#competitive-landscape)
5. [Platform Architecture](#platform-architecture)
6. [Service Verticals](#service-verticals)
7. [CHW Experience](#chw-experience)
8. [Community Member Experience](#community-member-experience)
9. [Billing & Revenue](#billing--revenue)
10. [Technology Roadmap](#technology-roadmap)
11. [Team](#team)
12. [Key Metrics](#key-metrics)

---

## Mission & Vision

### Mission

CompassCHW is a two-sided marketplace that connects certified Community Health Workers with community members who need help navigating housing, food, addiction recovery, mental health, and healthcare systems through a flexible work model that makes community health work accessible, scalable, and financially sustainable for workers.

### Vision

A world where every community member has affordable, on-demand access to a trusted health navigator and every Community Health Worker can build a sustainable livelihood through flexible, dignified work.

---

## The Problem

### 1. Community members cannot navigate fragmented systems

Social determinants of health — housing, food, addiction, mental health — are addressed by thousands of disconnected community-based organizations (CBOs) and government programs. Community members, especially Medicaid-eligible populations, lack a single point of entry.

CityBlock Health proves the demand exists: they achieve an industry-leading 81% engagement rate by assigning dedicated human navigators (Community Health Partners) to each member. But their W-2 employment model costs $63K-$102K per navigator and currently serves only 10 states. The relationship works. The economics don't scale.

### 2. No gig-economy platform exists for CHWs

The gig economy has transformed rideshare (Uber), food delivery (DoorDash), and clinical staffing (CareRev, ShiftKey) — but Community Health Workers have been left out entirely.

| Platform | What it does | CHW gig model? |
|----------|-------------|-----------------|
| CareRev / ShiftKey | Gig shifts for nurses and CNAs | No — wrong worker segment |
| CityBlock Health | Employs Community Health Partners | No — traditional W-2 employment |
| Pear Suite | CHW enablement and billing | No — enables billing for existing org-employed CHWs; no worker-facing marketplace or matching |
| UniteUs | Referral network connecting CBOs | No — organization-level, not worker-level |

**The gap is wide open.** No platform lets a certified CHW log in, see community demand, and accept work on their own terms.

### 3. Billing infrastructure exists but isn't worker-centric

California Medi-Cal reimburses CHW services at **$26.66/unit** (1 unit = 30 min, triggerable at 15 min), up to 4 units per member per day and 10 units per member per year. This creates a **$266.60/year billing ceiling per member-relationship**, which means a W-2 employment model is structurally inefficient. CHWs need member volume, not time depth. CompassCHW's matching engine is the direct structural answer to this billing reality.

The billing rails are being built:

- **UniteUs** has a Payments product for CBO-level reimbursement (EDI 837 claims)
- **Pear Suite** enables Medicaid billing for CHW services and takes 15% through its provider network

But nobody has built worker-facing gig tooling on top of these rails. The money is flowing to organizations, not directly empowering individual CHWs.

---

## The Solution

Compass combines the best elements of three proven models into something none of them offer alone:

| Capability | Inspiration | Compass Adaptation |
|-----------|------------|-------------------|
| **Network infrastructure & referral coordination** | UniteUs (1,600+ orgs, 44 states, $1.6B valuation) | Compass routes community members to CHWs who know their local CBO networks — rather than building a competing CBO directory |
| **Deep community engagement via human navigators** | CityBlock Health (81% engagement, $5.7B valuation) | Compass delivers the trusted Community Health Partner relationship through gig workers, not W-2 employees — reducing cost from $63K-$102K/year to per-session economics |
| **Behavioral incentives for sustained engagement** | Wellth (90-95% adherence rates, $79.5M raised) | Compass applies Wellth-style behavioral incentive design to BOTH sides: CHWs earn through availability streaks and quality bonuses; community members earn follow-through rewards |

**Compass is the first platform to combine gig-economy labor dynamics, Medicaid-reimbursable CHW services, and behavioral incentive mechanics into a single two-sided marketplace.**

Phase 1 billing proxies through Pear Suite for immediate California Medi-Cal reimbursement at $26.66/unit. Phase 2 builds proprietary EDI 837 infrastructure to capture the full margin. ECM-tier services ($386 PMPM) are a Phase 2+ unlock, contingent on TENA completing ECM provider enrollment with LA Care, Molina, Health Net, and ILS/Kaiser.

---

## Competitive Landscape

| Company | Model | CHW Focus | Gig Model | Billing | Gap Compass Fills |
|---------|-------|-----------|-----------|---------|-------------------|
| **UniteUs** | B2B SaaS referral network | No — org-level | No | CBO reimbursement (EDI 837) | No CHW mobile tools, no credentialing, no direct CHW billing |
| **CityBlock** | Full-risk capitation, W-2 | Yes — "Community Health Partners" | No — W-2 employment | Health plan contracts | Delivers the same trusted navigator relationship at gig-worker economics, scalable to all 50 states |
| **Wellth** | Patient incentives | No — patient-facing only | No | SaaS fees to health plans | No workforce component at all |
| **Pear Suite** | CHW enablement/billing | Yes — 2,500+ workers | No — serves existing orgs | 15% of Medicaid reimbursements | No marketplace, no demand-side matching |
| **CareRev/ShiftKey** | Clinical gig platform | No — nurses/CNAs only | Yes | Facility billing | Wrong worker segment entirely |
| **CompassCHW** | **Two-sided CHW marketplace** | **Yes — gig CHWs** | **Yes — first mover** | **Phase 1: Pear Suite API. Phase 2: proprietary EDI 837** | **First CHW gig marketplace with bilateral matching** |

### Defensibility

- **Network effects**: More CHWs attract more community members and vice versa — classic two-sided marketplace moat
- **Data moat**: Session outcomes, engagement patterns, and CHW performance ratings create proprietary intelligence
- **Regulatory positioning**: Early mover in states with CHW Medicaid billing; built-in compliance from day one

---

## Platform Architecture

```
Community Member (Web/iOS)  <-->  Compass Platform  <-->  CHW (Web/iOS)
         |                              |                       |
   [Onboarding]                 [Matching Engine]        [Availability]
   [Need Configuration]        [Session Management]     [Credentialing]
   [Feedback & Ratings]        [Billing Engine]         [Earnings/Payouts]
   [Engagement Rewards]        [Incentive Engine]       [Performance Dash]
                                [Analytics Dashboard]
                                     |         |
                              [Pear Suite API]  [Medicaid State APIs]
```

### Core Components

1. **Matching Engine** — Pairs community members with CHWs based on need type, language, location, availability, and member-configured preferences
2. **Session Management** — Tracks the full session lifecycle: request → accept → in-progress → completed → follow-up
3. **Billing Engine** — Phase 1: proxies through Pear Suite for Medicaid claims. Phase 2: direct EDI 837 submission
4. **CHW Credentialing Service** — Verifies certifications, background checks, and ongoing compliance
5. **Incentive Engine** — Manages behavioral incentive mechanics for both CHWs and community members
6. **Analytics Dashboard** — Tracks engagement rates, session outcomes, CHW performance, and platform health

### Technical Stack

- **Web app** (ships first): TypeScript/React, strict mode, Zod validation, responsive mobile-first design
- **iOS app** (parallel development): Swift/SwiftUI, async/await, SPM dependencies
- **Backend**: Python/FastAPI, pydantic data models, async architecture
- **Shared API layer** ensures feature parity — web and iOS stay in sync through a single backend
- **Infrastructure**: Cloud-native, event-driven matching, HIPAA-compliant hosting

---

## Service Verticals

Compass launches with five core service areas — the most urgent social determinants of health:

### 1. Housing Assistance
Emergency shelter navigation, transitional housing, rental assistance programs, eviction prevention. CHW activities: identify available programs, assist with applications, accompany to appointments, follow up on status.

### 2. Rehab & Addiction Recovery
Substance use disorder navigation, treatment facility connections, recovery support networks. CHW activities: connect to treatment programs, provide peer support, arrange transportation to intake, ongoing recovery check-ins.

### 3. Food & Pantry Navigation
Food bank connections, SNAP/WIC enrollment assistance, community nutrition programs. CHW activities: locate pantries, assist with benefit applications, arrange food delivery or transportation.

### 4. Mental Health Support
Counseling referrals, crisis navigation, support group connections, therapy access. CHW activities: screen for needs, connect to providers, warm handoffs to behavioral health specialists, follow-up engagement.

### 5. Healthcare Navigation
Insurance enrollment, primary care matching, appointment scheduling, health literacy education. CHW activities: explain benefits, help with enrollment paperwork, accompany to appointments, translate medical information.

CHWs self-select their specializations during onboarding. Community members filter by need. Many members have overlapping needs — the platform supports multi-vertical sessions and referral chains.

---

## CHW Experience

### Onboarding & Credentialing
- Upload CHW certification documentation (state-specific)
- Complete background check (integrated third-party provider)
- Build profile: specializations (from 5 verticals), languages spoken, geographic coverage, availability windows
- Enroll through Pear Suite for Medicaid billing eligibility

### The Gig Model (How Matching Works)
- CHW opens the app and toggles status to **"Available"**
- Incoming requests appear filtered by: geographic proximity, vertical match, language match, member preferences, CHW rating
- CHW reviews anonymized request details: need description, estimated session length, session mode (in-person / virtual / phone)
- CHW **accepts or passes** — passed requests route to next-best match
- Unlike pure Uber-style transactional matching, Compass allows CHWs to maintain **ongoing relationships** with specific community members (recurring sessions)

### Session Execution
- In-app session tracking: start time, session notes, resource referrals logged, end time
- Structured documentation that maps directly to Medicaid billing requirements (service type, duration, outcome codes)
- Real-time local resource directory lookup during sessions

### Earnings & Payouts

Medi-Cal reimburses CHW services at **$26.66/unit** (1 unit = 30 min, triggerable at 15 min), up to 4 units per member per day and 10 units per member per year. To grow earnings, a CHW must grow their member panel — this is the core economic driver the matching engine enables.

| Scenario | Units/day | Gross/day | Net/day P1 | Net/day P2 |
|----------|-----------|-----------|------------|------------|
| Light (2 members × 1 unit) | 2 | $53.32 | $38.54 | $43.98 |
| Moderate (4 members × 2 units) | 8 | $213.28 | $154.16 | $175.94 |
| Full (6 members × 3 units) | 18 | $479.88 | $346.86 | $395.91 |
| Max daily (5 members × 4 units) | 20 | $533.20 | $385.40 | $439.89 |

> P1 = Phase 1 (Pear Suite, midpoint fee). P2 = Phase 2 (direct billing, midpoint fee). Annual billing cap per member: $266.60 gross (10 units × $26.66).

- Transparent per-session earnings displayed before accepting a request
- Weekly direct deposit (initially via Pear Suite disbursement, later direct)
- Earnings dashboard: session history, pending claims, projected income

### Incentives (Wellth Model, Adapted for Workers)
- **Availability streaks**: Bonuses for consistent weekly availability
- **Quality bonuses**: Higher ratings and positive outcomes unlock priority matching
- **Specialization incentives**: Bonus pay for underserved verticals or geographies with high demand
- **Milestone rewards**: Recognition and bonuses at session count thresholds
- Design principle: incentivize **consistency and quality**, not just volume

---

## Community Member Experience

### Onboarding
- Minimal friction: name, zip code, primary need (from 5 verticals), preferred language
- No insurance information required upfront — billing is on the CHW side through Pear Suite
- Optional: insurance details for enhanced matching, demographic info
- Privacy-first, HIPAA-compliant data handling from day one

### Need Configuration & Filtering
- Select primary need vertical(s)
- Preference filters: CHW gender preference, language, in-person vs. virtual, availability windows
- Urgency indicator: routine / soon (within 48 hours) / urgent (same-day)
- Brief description of what they need help with (free text, optional)

### Matching & Sessions
- Platform presents a matched CHW with profile summary: name, photo, specializations, rating, languages
- Member confirms or requests another match
- Session modes: in-person (CHW comes to the member), virtual (video/audio), phone
- Post-session: brief outcome survey (3-5 questions), option to schedule follow-up

### Engagement Incentives (Wellth Model, Adapted for Members)
- **Follow-through rewards**: Earn credits for completing referral actions (attending a scheduled appointment, submitting a benefit application)
- **Loss-aversion mechanic**: Small monthly engagement credit that decreases with missed follow-ups (modeled on Wellth's $30/month with $2 daily deductions)
- Credits redeemable for: transportation vouchers, grocery gift cards, phone minutes — things that address immediate needs

---

## Cost

_Cost analysis to be developed._

---

## Billing & Revenue

### Phase 1: Pear Suite Integration (Launch)
- CompassCHW routes completed session documentation to Pear Suite's billing platform
- Pear Suite submits Medicaid claims through its Pear Cares Provider Network
- Revenue split at $26.66/unit (Medi-Cal CA rate):
  - Medicaid pays: **$26.66**
  - Pear Suite takes 15%: **–$4.00**
  - CompassCHW takes 10–15%: **–$2.67–$4.00**
  - **CHW receives: $18.66–$20.00/unit**
- Advantage: immediate billing capability without building claims infrastructure
- Tradeoff: margin compression from double intermediary fees

### Phase 2: Proprietary Billing (Month 12+)
- Revenue split at $26.66/unit (Phase 2 — direct billing):
  - Medicaid pays: **$26.66**
  - Pear Suite: **$0.00**
  - CompassCHW takes 15–20%: **–$4.00–$5.33**
  - **CHW receives: $21.33–$22.66/unit**
- This is the primary margin expansion lever. CHW take-home improves by ~$4.00/unit — a meaningful recruiting advantage.

### Phase 2+: ECM Services
- Enhanced Care Management (ECM) contracts at **$386 PMPM** represent a step-change in revenue per member
- Phase 2+ unlock, contingent on TENA completing ECM provider enrollment with LA Care, Molina, Health Net, and ILS/Kaiser
- TENA's existing ECM infrastructure and MCP relationships serve as the anchor contract pathway
- Transforms economics from per-unit billing to per-member-per-month recurring revenue

### Future Revenue Streams
- **Health plan contracts**: Sell outcomes data and engagement analytics to Medicaid MCOs (modeled on UniteUs B2B SaaS)
- **Employer-sponsored plans**: Companies purchase Compass access for employees (EAP-adjacent)
- **Training & certification**: Compass-branded CHW training programs (revenue + supply-side growth)

---

## Technology Roadmap

### Phase 0: Foundation (Months 1-3)
- Repository and project structure established
- HIPAA compliance framework selected and implemented
- Design system and wireframes (JT/CDO leads)
- Pear Suite API integration scoped and prototyped
- Web app scaffolding: React frontend + FastAPI backend
- CHW onboarding and community member request flows designed

### Phase 1: Los Angeles Pilot (Months 3-6)
- **Medi-Cal market** — California has established CHW Medicaid billing provisions
- Responsive web app for both CHWs and community members
- Basic matching engine (geographic + vertical + language)
- Session tracking and structured documentation
- Pear Suite billing integration live
- iOS development begins in parallel
- **Target**: 20-50 CHWs, 100-500 completed sessions

### Phase 2: Product-Market Fit (Months 6-12)
- iOS app launch
- Advanced matching: preference filtering, rating-weighted ranking, availability optimization
- Incentive engines for CHWs (streaks, bonuses) and community members (follow-through rewards)
- Analytics dashboard for founders and operations
- Expand to 2-3 additional cities

### Phase 3: Scale (Months 12-24)
- Proprietary Medicaid billing infrastructure (replace Pear Suite dependency)
- EHR integration exploration (Epic SMART on FHIR, following UniteUs's pattern)
- Health plan partnership pipeline (B2B revenue stream)
- Multi-state expansion targeting states with established CHW Medicaid billing

### Phase 4: Platform (Month 24+)
- Open API for CBO and partner integrations
- Employer-sponsored plans
- Outcomes-based contracting with health plans
- National scale

---

## Team

| Name | Role | Focus Areas |
|------|------|-------------|
| **Akram Mahmoud** | Co-Founder & CTO | Product, Engineering, Platform Architecture |
| **Jemal Hussein** | Co-Founder & CEO | Strategy, Operations, Partnerships |
| **John Thomas (JT)** | Co-Founder & CDO | Design, User Experience, Brand |

---

## Key Metrics

### Supply Side (CHW)
- CHW sign-up and credentialing completion rate
- Weekly active CHWs (available at least once per week)
- Average sessions per CHW per week
- CHW retention at 30 / 60 / 90 days
- Average CHW earnings per week
- CHW Net Promoter Score

### Demand Side (Community Members)
- Registration rate
- Request-to-match rate (% of requests resulting in a matched CHW)
- Match-to-session rate (% of matches where session occurs)
- Session completion rate
- Follow-through rate (% of referrals acted upon)
- Engagement rate (target: CityBlock's 81%)
- Community member NPS

### Business
- Total sessions per week/month
- Gross Marketplace Value (total Medicaid billing through platform)
- Platform take rate (effective %)
- Revenue per session
- Billing claim success rate
- Time from session completion to CHW payout
- Unit economics: CAC and LTV for both CHWs and community members

### Pilot Success Thresholds (Phase 1 — LA)
- 20+ active CHWs
- 50+ completed sessions per month
- 80%+ billing claim success rate
- 60%+ CHW 30-day retention
- 70%+ match-to-session rate

---

> Compass is a living document. Quarterly review recommended as the platform evolves.
