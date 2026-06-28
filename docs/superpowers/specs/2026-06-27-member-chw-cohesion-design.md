# Member ↔ CHW Cohesion — Design Spec

**Date:** 2026-06-27
**Author:** Akram (via Claude Code)
**Scope:** `native/src/screens/member/`, `native/src/components/`, `native/src/navigation/`
**Backend:** No backend changes. All endpoints already exist and are role-scoped.

## Goal

Make the member side of Compass feel like one cohesive platform with the CHW side
(the design source of truth), and remove the functional gaps the user reported. The
member side already shares the design system (`theme/tokens`, `components/ui/AppShell`,
`PageHeader`, `Card`, `Pill`, `StatTile`) and 13/15 screens already render real,
role-scoped API data. This spec closes the remaining concrete gaps — it is functional
cleanup + targeted UI alignment, not a ground-up reskin.

## Context: what the investigation established

- **Appointments** (`MemberCalendarScreen`) already uses real data via `useSessions()`
  → `GET /sessions/` (backend auto-scopes: members see only their own sessions). Gap is
  purely UI structure vs `CHWCalendarScreen`.
- **Messages** (`MemberMessagesScreen`) real CHW conversations work via `useConversations`
  / `useConversationMessages` / `useConversationSendMessage`. The reported "can't select
  other threads" bug is caused by 4 hardcoded mock items (`SYNTHETIC_ITEMS`).
- **Journeys** (`MemberJourneyScreen`, `MemberRoadmapScreen`) already render real
  CHW-authored data via `useMemberJourneys(memberId)` → `GET /members/{id}/journeys`
  (member-auth-gated; CHW authoring + step-update endpoints wired). No data work needed.
- **Mock data** across the member side is minimal: only `SYNTHETIC_ITEMS` (messages) and
  `redemptionCatalog` (MemberProfileScreen) are real offenders.
- **Resources** (`MemberResourcesScreen`) is a placeholder empty-state screen with no
  backend endpoint.

## Work items

### 1. Remove the member Resources page

Delete the member-facing Resources feature only (CHW resources untouched — there is no
CHW resources sidebar entry currently, so nothing CHW-side is affected).

Touchpoints (exact):
- `src/components/ui/sidebarItems.ts:51` — delete the `resources` member sidebar item.
- `src/screens/member/MemberResourcesScreen.tsx` — delete the file.
- `src/navigation/MemberTabNavigator.tsx` — delete import (line 50), `MemberResources`
  entry in `MemberTabParamList` (line 105), and the `SCREENS` array entry (line 180).
- `src/navigation/AppNavigator.tsx:259` — delete the `MemberResources: 'resources'`
  deep-link entry.
- Grep-verify no other imports/links reference `MemberResources` or the route before
  finishing.

**Acceptance:** member sidebar has no Resources item; `/member/resources` no longer
resolves; `tsc` clean; no dangling imports.

### 2. Appointments → full CHW calendar layout, read-only

Rebuild `MemberCalendarScreen` to mirror `CHWCalendarScreen`'s structure, minus the
CHW-only scheduling affordances. Members do not schedule sessions (they request via
Find a CHW), so the member calendar is read-only.

Match:
- **View-mode toggle** (Week / Day / Month) in the `PageHeader` right slot, same control
  as CHW (`CHWCalendarScreen` view-toggle).
- **Full-width grid** — drop the member-specific right rail ("Upcoming Sessions");
  CHW calendar is full-width.
- **Absolute-positioned session blocks** using the CHW time math
  (`computeTopOffset` / `computeBlockHeight`, `SLOT_HEIGHT = 60`) instead of the current
  relative inline layout. Week hours align to CHW's `8–17`.
- **Status badges** on session blocks (Confirmed / Pending / Completed / Missed) via the
  CHW badge logic, driven by `SessionData.status` / `schedulingStatus`.
- **Session-detail modal** on block tap — read-only member version (no "Open Member
  Profile"; show CHW name, vertical, time, modality, status). No "Schedule Session" CTA.

Drop / omit (CHW-only): "Schedule Session" button, schedule modal, `useChwMembers()`,
member-roster picker, "Open Member Profile".

Data: keep `useSessions()` and `deriveSessionEvents()`. No new endpoints. Native layout
keeps the simple Upcoming/Past list (matches CHW native).

**Implementation approach — shared presentational components (recommended):** Extract the
pure-presentational calendar pieces both screens need into a shared module
(`src/components/sessions/`): `SessionBlock` (card), `WeekViewGrid`, `DayViewGrid`,
`MonthViewGrid`, and the time/badge helpers. Each takes props for the role-specific bits
(block label source, `onPress`, whether to render the schedule CTA). Both
`CHWCalendarScreen` and `MemberCalendarScreen` consume them. This enforces cohesion at the
component level (the platform's explicit goal) and prevents future drift.

> **Trade-off:** extraction touches the working `CHWCalendarScreen`. To contain risk, CHW
> behavior must remain byte-for-byte identical — verified by before/after screenshots of
> the CHW calendar (Week/Day/Month + a session-detail modal). If extraction proves too
> invasive under review, fall back to copying the CHW patterns into the member screen
> (isolated, no CHW risk) — the visual/functional outcome is the same.

**Acceptance:** member Appointments shows Week/Day/Month toggle, full-width grid,
status-badged session blocks from real `useSessions()` data, read-only detail modal, no
scheduling UI; CHW calendar visually unchanged; `tsc` clean.

### 3. Messages → delete synthetic mock items (fixes selection bug)

The 4 `SYNTHETIC_ITEMS` (Compass System, Appointment Reminder, Document Request, Reward)
are hardcoded mock and are the root cause of the reported bug:

> Root cause (`MemberMessagesScreen.tsx:2452–2468`): selecting a synthetic item sets
> `selectedConversation = null`; the auto-select `useEffect` (which depends on
> `selectedConversation`) immediately re-fires and snaps selection back to the first CHW
> conversation. Result: synthetic threads appear un-selectable.

Deleting the synthetic items removes the mock data, eliminates the second selection state,
and makes the inbox conversations-only — matching the CHW inbox.

Remove:
- `SYNTHETIC_ITEMS` constant (lines ~1039–1068) and the `SyntheticItem` type (~1030).
- `SyntheticItemRow` component and `AltPane` component + their styles.
- `selectedSyntheticId` state, `handleSelectSynthetic`, `filteredSynthetic`, and the
  synthetic render branches in the inbox list and center pane (~2643–2728).
- Simplify `hasAnyItems` to depend only on `filteredConversations`.
- After removal, the auto-select `useEffect` only ever runs for real conversations, so
  switching between multiple real CHW threads (a member with >1 CHW) works correctly.

**Acceptance:** member inbox shows only real CHW conversation rows; every conversation row
selects and opens its thread; no mock items; empty-inbox state still renders when there are
no conversations; `tsc` clean.

### 4. Journeys → consolidate into one canonical screen, styled like CHW

Both member journey screens render the same real CHW-authored journey data
(`useMemberJourneys`) but present it twice with overlapping content. Consolidate them into
a single canonical member journey page, styled to match the CHW journey visual language —
no overlap, no data-flow changes.

- **Canonical screen:** keep `MemberJourneyScreen` as the single "My Journey" page (it is
  the sidebar entry). Fold in the useful pieces from `MemberRoadmapScreen` so nothing of
  value is lost — the progress `StatTile` grid (% complete + wellness points), the stepped
  roadmap with node/connector visuals, and the session follow-ups grouped by vertical —
  arranged to match CHW journey views (step nodes, status pills, progress, cards) using
  `theme/tokens`, shared `ui/` primitives, and `components/journey/` where reusable.
- **Delete `MemberRoadmapScreen`** and remove its route + all references:
  - `src/navigation/MemberTabNavigator.tsx` — import (line 46) and `SCREENS` entry
    (line 183); remove `Roadmap` from `MemberTabParamList`.
  - `src/navigation/AppNavigator.tsx:262` — delete the `Roadmap: 'roadmap'` deep link.
  - `src/screens/member/MemberHomeScreen.tsx:444` — repoint `navigation.navigate('Roadmap')`
    to `'MemberJourney'`.
  - Grep-verify no other references to `Roadmap` / `MemberRoadmapScreen` remain.
- Reconcile the two data hooks: `MemberJourneyScreen` uses `useMemberJourneys`;
  `MemberRoadmapScreen` additionally used `useMemberRoadmap()` for session follow-ups. Pull
  whichever hooks the folded-in sections need into the canonical screen; keep data behavior
  identical.

**Acceptance:** exactly one member journey screen remains; "My Journey" (sidebar), the Home
CTA, and any deep link all resolve to it; no `Roadmap` route or `MemberRoadmapScreen` file
remains; the page is visually consistent with CHW journey views; data behavior unchanged;
`tsc` clean.

### 5. Mock-data cleanup

- `MemberProfileScreen` — remove the hardcoded `redemptionCatalog` import from
  `../../data/mock` (line 61) and the section that loops it (~2523–2541); wire to the real
  `useRewardsCatalog()` hook (already used by `MemberRewardsScreen`). Handle loading/empty
  states.
- Confirm (grep) no remaining `data/mock` imports or hardcoded names/dates/points remain in
  any active member screen after items 1–4.

**Acceptance:** no member screen imports `data/mock`; redemption options come from the real
catalog endpoint; `tsc` clean.

## Out of scope

- Backend changes (none needed).
- A real notifications feed to replace the deleted synthetic items (separate effort if
  desired later).
- CHW-side functional changes (CHW calendar may be touched only for the optional shared
  extraction, and must remain visually/behaviorally identical).

## Risks & mitigations

- **Shared calendar extraction touches working CHW screen** → verify CHW calendar
  unchanged via before/after screenshots; fall back to copy-into-member if review flags it.
- **Prod vs `main` drift** — user observed issues on production, which may lag `main`.
  Fixes target `main`; the messages mock bug reproduces on `main` (matches the screenshot),
  so at least that is consistent. Verify each item in the running local app before shipping.
- **Member with multiple CHWs** — removing the synthetic selection path must not regress
  multi-conversation switching (covered by item 3 acceptance).

## Verification

- `npm run typecheck` (tsc) clean after each item.
- Run the app locally (Expo web, `localhost:8081`) and visually verify each screen against
  the CHW counterpart; capture before/after screenshots for Appointments, Messages, and
  Journeys.
- Manual flows: select every message thread; toggle calendar Week/Day/Month and open a
  session detail; load a member journey; open redemption catalog.
