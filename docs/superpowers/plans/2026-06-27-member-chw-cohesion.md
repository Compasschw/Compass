# Member ↔ CHW Cohesion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Compass member side cohesive with the CHW side (the design source of truth) and remove the reported functional gaps: delete the Resources page, rebuild Appointments to the CHW calendar layout, fix the Messages thread-selection bug by deleting mock items, consolidate the two journey screens into one CHW-styled page, and remove remaining mock data.

**Architecture:** Pure frontend work in the Expo React Native app (`native/`). All data already comes from existing, role-scoped backend endpoints — no backend changes. Changes are surgical deletions/rewires plus two screen rebuilds (Appointments, Journey) that port the CHW visual patterns into the member screens.

**Tech Stack:** Expo / React Native / TypeScript, React Navigation, React Query (`src/hooks/useApiQueries.ts`), shared design system (`src/theme/tokens.ts`, `src/components/ui/*`), lucide-react-native icons.

## Global Constraints

- **No backend changes.** Every endpoint used already exists and is role-scoped (members see only their own data).
- **No frontend unit-test runner exists** (no jest, no `test` script). Verification per task = `npm run typecheck` clean (run in `native/`) + manual/visual check in the running local app (`http://localhost:8081`, logged in as a member). Do NOT add a test framework — out of scope.
- **No mock/hardcoded data** may remain on the member side. No `data/mock` imports; no hardcoded names, dates, points, or catalogs in active member screens.
- **CHW side must not change** (behavior or visuals). The member work ports CHW patterns; it does not edit CHW screens. (Optional shared-component extraction is explicitly out of scope for this plan.)
- **Design tokens only:** import `colors as tokens` (or existing alias) from `src/theme/tokens`, plus `spacing`, `radius`, `numerals` — never `src/theme/colors` (legacy).
- **Commit style:** Conventional commits (`feat|fix|refactor|chore(scope): message`), one concern per commit, on branch `feat/member-chw-cohesion`.
- Run all commands from `native/` unless stated. Typecheck: `npm run typecheck`.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/components/ui/sidebarItems.ts` | Member/CHW nav config | Modify (remove `resources`) |
| `src/screens/member/MemberResourcesScreen.tsx` | Resources placeholder | Delete |
| `src/navigation/MemberTabNavigator.tsx` | Member routes/param list | Modify (remove Resources + Roadmap) |
| `src/navigation/AppNavigator.tsx` | Deep-link map | Modify (remove resources + roadmap) |
| `src/screens/member/MemberMessagesScreen.tsx` | Member inbox + conversation | Modify (delete synthetic items) |
| `src/screens/member/MemberProfileScreen.tsx` | Member profile | Modify (redemption catalog → real hook) |
| `src/screens/member/MemberCalendarScreen.tsx` | Member appointments | Rebuild to CHW calendar layout |
| `src/screens/member/MemberJourneyScreen.tsx` | Canonical member journey | Rebuild as consolidated journey page |
| `src/screens/member/MemberRoadmapScreen.tsx` | Duplicate journey view | Delete (folded into MemberJourneyScreen) |
| `src/screens/member/MemberHomeScreen.tsx` | Member home | Modify (repoint Roadmap CTA) |

Reference (read-only, do NOT edit): `src/screens/chw/CHWCalendarScreen.tsx`, `src/screens/chw/CHWJourneysScreen.tsx`, `src/screens/chw/CHWMemberProfileScreen.tsx`.

---

## Task 1: Remove the member Resources page

**Files:**
- Modify: `src/components/ui/sidebarItems.ts`
- Delete: `src/screens/member/MemberResourcesScreen.tsx`
- Modify: `src/navigation/MemberTabNavigator.tsx`
- Modify: `src/navigation/AppNavigator.tsx`

**Interfaces:**
- Produces: member nav with no Resources item/route; `/member/resources` no longer resolves.

- [ ] **Step 1: Remove the sidebar item.** In `src/components/ui/sidebarItems.ts`, find the member item:

```ts
{ key: 'resources',    label: 'Resources',     icon: 'folder-open',    route: 'MemberResources'    },
```

Delete that entire line from `memberSidebarItems`.

- [ ] **Step 2: Remove route registration.** In `src/navigation/MemberTabNavigator.tsx`:
  - Delete the import line: `import { MemberResourcesScreen } from '../screens/member/MemberResourcesScreen';`
  - Delete `MemberResources: undefined;` from the `MemberTabParamList` type.
  - Delete the `SCREENS` array entry: `{ name: 'MemberResources', title: 'Resources', component: MemberResourcesScreen, icon: FolderOpen },`
  - If `FolderOpen` is now an unused import, remove it from the lucide import.

- [ ] **Step 3: Remove the deep link.** In `src/navigation/AppNavigator.tsx`, delete the member screens line: `MemberResources: 'resources',`

- [ ] **Step 4: Delete the screen file.**

```bash
git rm native/src/screens/member/MemberResourcesScreen.tsx
```

- [ ] **Step 5: Grep-verify no dangling references.**

```bash
cd native && grep -rn "MemberResources\|MemberResourcesScreen" src
```

Expected: no matches.

- [ ] **Step 6: Typecheck.**

Run: `cd native && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit.**

```bash
git add -A && git commit -m "feat(member): remove Resources page (placeholder, no backend)"
```

---

## Task 2: Fix Messages — delete synthetic mock items

Root cause of the reported "can't select other threads" bug: tapping a synthetic item sets `selectedConversation = null`; the auto-select `useEffect` depends on `selectedConversation`, re-fires, and snaps selection back to the first CHW conversation. The synthetic items are also hardcoded mock. Deleting them fixes the bug and removes the mock.

**Files:**
- Modify: `src/screens/member/MemberMessagesScreen.tsx`

**Interfaces:**
- Produces: inbox renders only real CHW conversation rows; every row selects and opens its thread; empty-inbox state preserved.

- [ ] **Step 1: Locate all synthetic-item code.**

```bash
cd native && grep -n "Synthetic\|synthetic\|AltPane\|selectedSyntheticId\|SYNTHETIC_ITEMS" src/screens/member/MemberMessagesScreen.tsx
```

Record every line/range. Expect: `SyntheticItem` type (~1030), `SYNTHETIC_ITEMS` const (~1039–1068), `SyntheticItemRow` component + its styles, `AltPane` component + its styles, `selectedSyntheticId` state (~2395), `handleSelectSynthetic` (~2479–2486), `filteredSynthetic` (~2439–2447), `hasAnyItems` (~2449), inbox render branch (~2643–2651), center-pane synthetic branch (~2695–2728).

- [ ] **Step 2: Remove the data + components.** Delete the `SyntheticItem` type, the `SYNTHETIC_ITEMS` array, the `SyntheticItemRow` component (and its style entries in the `StyleSheet`), and the `AltPane` component (and its style entries). Remove now-unused imports they referenced (e.g. `Settings` icon) only if not used elsewhere — grep each before removing.

- [ ] **Step 3: Remove the state + handlers.** Delete the `selectedSyntheticId` state declaration, `setSelectedSyntheticId` usages, `handleSelectSynthetic`, and `filteredSynthetic` memo. In `handleSelectConversation`, remove the `setSelectedSyntheticId(null)` call. In the auto-select `useEffect`, remove `setSelectedSyntheticId(null)` calls.

- [ ] **Step 4: Simplify derived values.** Change:

```ts
const hasAnyItems = filteredConversations.length > 0 || filteredSynthetic.length > 0;
```
to:
```ts
const hasAnyItems = filteredConversations.length > 0;
```

In the `InboxThreadRow` `isActive` prop, simplify `selectedConversation?.id === conversation.id && selectedSyntheticId === null` to `selectedConversation?.id === conversation.id`.

- [ ] **Step 5: Remove render branches.** In the inbox `ScrollView`, delete the `{filteredSynthetic.map(...)}` block (the `SyntheticItemRow` list). In the center pane, delete the `: selectedSyntheticId !== null ? ( ...AltPane... )` branch so the conditional is just `selectedConversation != null ? <ConversationPane/> : <empty/placeholder>`. Verify the remaining ternary is syntactically closed.

- [ ] **Step 6: Grep-verify removal.**

```bash
cd native && grep -n "ynthetic\|AltPane" src/screens/member/MemberMessagesScreen.tsx
```

Expected: no matches.

- [ ] **Step 7: Typecheck.**

Run: `cd native && npm run typecheck`
Expected: no errors (watch for unused-variable / unused-import errors and clean them).

- [ ] **Step 8: Manual verify.** In the running app, open Messages as a member with ≥1 conversation: inbox shows only CHW conversation rows; clicking each row opens that thread; with multiple conversations, switching between them works; empty state shows when there are no conversations.

- [ ] **Step 9: Commit.**

```bash
git add -A && git commit -m "fix(member): remove mock inbox items, fixing thread selection"
```

---

## Task 3: Remove redemption-catalog mock from MemberProfileScreen

The redemption section renders a hardcoded `redemptionCatalog` from `src/data/mock`. Replace with the real `useRewardsCatalog()` hook (already used by `MemberRewardsScreen`).

**Files:**
- Modify: `src/screens/member/MemberProfileScreen.tsx`

**Interfaces:**
- Consumes: `useRewardsCatalog()` from `src/hooks/useApiQueries.ts` (same hook `MemberRewardsScreen` uses).
- Produces: redemption options sourced from the real catalog endpoint; loading/empty states handled.

- [ ] **Step 1: Confirm the real hook + its shape.**

```bash
cd native && grep -n "useRewardsCatalog" src/hooks/useApiQueries.ts src/screens/member/MemberRewardsScreen.tsx
```

Read `MemberRewardsScreen`'s usage to copy the exact field names (e.g. catalog item `id`, `title`/`name`, `pointsCost`) and loading/empty handling.

- [ ] **Step 2: Remove the mock import + usage.** In `MemberProfileScreen.tsx`, delete `import { redemptionCatalog } from '../../data/mock';` (line ~61). Replace the section (~2523–2541) that loops `redemptionCatalog` with a loop over the data from `const rewardsCatalogQuery = useRewardsCatalog();` (`rewardsCatalogQuery.data ?? []`), using the same field names as `MemberRewardsScreen`. Render an empty/loading state when `rewardsCatalogQuery.data` is undefined/empty (mirror `MemberRewardsScreen`).

- [ ] **Step 3: Grep-verify no mock import remains in this file.**

```bash
cd native && grep -n "data/mock\|redemptionCatalog" src/screens/member/MemberProfileScreen.tsx
```

Expected: no matches.

- [ ] **Step 4: Typecheck.** Run: `cd native && npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Manual verify.** Open member Profile → redemption section shows the same catalog as the Rewards screen (real data), not the old hardcoded items.

- [ ] **Step 6: Commit.**

```bash
git add -A && git commit -m "fix(member): source redemption catalog from real rewards endpoint"
```

---

## Task 4: Rebuild Appointments to the CHW calendar layout (read-only)

Rebuild `MemberCalendarScreen` to mirror `CHWCalendarScreen`'s structure, minus CHW-only scheduling. Data stays real (`useSessions()` → `/sessions/`, backend auto-scopes to the member). Port the CHW presentational patterns into the member screen; do NOT edit the CHW screen.

**Files:**
- Modify (rebuild): `src/screens/member/MemberCalendarScreen.tsx`
- Read-only reference: `src/screens/chw/CHWCalendarScreen.tsx`

**Interfaces:**
- Consumes: `useSessions()` (from `src/hooks/useApiQueries.ts`), existing `deriveSessionEvents()` in the member screen, `SessionData` fields (`scheduledAt`, `scheduledEndAt`, `mode`, `status`, `schedulingStatus`, `chwName`, `vertical`).
- Produces: member Appointments with Week/Day/Month toggle, full-width grid, status-badged session blocks, read-only detail modal, no scheduling UI.

**Target structure (from CHWCalendarScreen — port, adapting labels to the member POV):**
- **Header:** `PageHeader` with a Week/Day/Month segmented toggle in the `right` slot (port from CHW header toggle). No "Schedule Session" button.
- **Web:** full-width calendar (remove the current right rail + `MemberRightRail`). Week view = 7 cols × hours `8–17`, `SLOT_HEIGHT = 60`, **absolute-positioned** session blocks via CHW helpers `computeTopOffset` / `computeBlockHeight`. Day view = single column (today). Month view = 7-col grid with per-day session-count badges.
- **Session block:** port the CHW `SessionCard` look (light-green bg, 3px green left border, time in tabular numerals). Member label = **CHW name + vertical** (CHW screen shows member name; swap to `session.chwName`). Show a **status badge** (Confirmed / Pending / Completed / Missed) via the CHW badge mapping from `SessionData.status` / `schedulingStatus`.
- **Detail modal:** on block tap, open a read-only modal (port CHW "Session Details" modal) showing CHW name, vertical, date/time, modality, status. Remove the CHW-only "Open Member Profile" action and any edit/cancel scheduling actions.
- **Native:** keep the existing simple Upcoming/Past list (matches CHW native); restyle to tokens if needed. Pull-to-refresh stays.

> **Porting note:** This task reproduces a large screen. Work section-by-section, copying the corresponding block from `CHWCalendarScreen.tsx` (cited ranges below) and adapting it. Do NOT import from the CHW screen; copy the needed helpers/components into the member file (or a local sub-component). Keep all data via `useSessions()`.

CHW reference ranges (read-only): view toggle in header (~2150–2173), `WEEK_VIEW_HOURS`/`SLOT_HEIGHT` (~81–84), `SessionCard` (~281–319), `computeTopOffset`/`computeBlockHeight` (~221–245), badge mapping (~104–117), `WeekViewGrid` (~392–468), `DayViewGrid` (~557–593), `MonthViewGrid` (~630–688), Session Details modal (~781–914).

- [ ] **Step 1: Re-read both screens to anchor exact line numbers.**

```bash
cd native && grep -n "WEEK_VIEW_HOURS\|SLOT_HEIGHT\|function SessionCard\|computeTopOffset\|computeBlockHeight\|WeekViewGrid\|DayViewGrid\|MonthViewGrid\|Session Details\|viewMode" src/screens/chw/CHWCalendarScreen.tsx
grep -n "MemberRightRail\|RightRail\|WEEK_VIEW_HOURS\|deriveSessionEvents\|useSessions\|WeekViewGrid" src/screens/member/MemberCalendarScreen.tsx
```

- [ ] **Step 2: Add view-mode state + toggle.** Add `const [viewMode, setViewMode] = useState<'week'|'day'|'month'>('week');` and any month-navigation state CHW uses. Add the segmented toggle to the `PageHeader` `right` slot (port CHW markup + styles).

- [ ] **Step 3: Port the grid helpers + constants.** Copy `WEEK_VIEW_HOURS = [8..17]`, `SLOT_HEIGHT = 60`, `computeTopOffset`, `computeBlockHeight`, and the badge-status mapping into the member file (rename to avoid collisions if needed). Ensure `deriveSessionEvents()` output carries the fields the blocks need (`status`, `schedulingStatus`, `mode`, `chwName`, `vertical`, start/end).

- [ ] **Step 4: Port the session block.** Add a member `SessionBlock` (based on CHW `SessionCard`): absolute-positioned, status badge, label = `chwName` + vertical, time in `numerals.tabular`. `onPress` opens the detail modal.

- [ ] **Step 5: Port Week/Day/Month grids.** Add `WeekViewGrid`, `DayViewGrid`, `MonthViewGrid` (ported), rendering `SessionBlock`s from the derived events. Wire `viewMode` to switch between them.

- [ ] **Step 6: Remove the right rail; go full-width.** Delete `MemberRightRail` and its `RightRail` usage + the `webStyles.rail` / rail-gap styles; expand the main column to full width (match CHW web layout).

- [ ] **Step 7: Add the read-only detail modal.** Port the CHW Session Details modal; strip "Open Member Profile" and any scheduling/edit/cancel actions. Show CHW name, vertical, date/time, modality, status.

- [ ] **Step 8: Native layout.** Keep the Upcoming/Past list; ensure it uses tokens and renders the same status badges. Leave pull-to-refresh.

- [ ] **Step 9: Grep-verify no scheduling/roster leakage.**

```bash
cd native && grep -n "useChwMembers\|Schedule Session\|Open Member Profile\|MemberRightRail" src/screens/member/MemberCalendarScreen.tsx
```

Expected: no matches.

- [ ] **Step 10: Typecheck.** Run: `cd native && npm run typecheck` — Expected: no errors.

- [ ] **Step 11: Manual verify (member + CHW unchanged).**
  - Member Appointments: toggle Week/Day/Month; sessions appear as status-badged blocks from real data; tap a block → read-only detail modal; no "Schedule Session" anywhere; full-width (no right rail).
  - Open CHW calendar and confirm it looks/behaves exactly as before (no regressions — you did not edit it).

- [ ] **Step 12: Commit.**

```bash
git add -A && git commit -m "feat(member): rebuild Appointments to CHW calendar layout (read-only)"
```

---

## Task 5: Consolidate the two journey screens into one CHW-styled page

Merge `MemberRoadmapScreen` content into `MemberJourneyScreen` (kept as the canonical "My Journey" route), then delete `MemberRoadmapScreen` and its route. Data behavior unchanged. Replace hardcoded values with real journey data.

**Files:**
- Modify (rebuild): `src/screens/member/MemberJourneyScreen.tsx`
- Delete: `src/screens/member/MemberRoadmapScreen.tsx`
- Modify: `src/navigation/MemberTabNavigator.tsx`, `src/navigation/AppNavigator.tsx`, `src/screens/member/MemberHomeScreen.tsx`

**Interfaces:**
- Consumes: `useMemberProfile()` (→ `userId`), `useMemberJourneys(userId)`, `useMemberRoadmap()` (session follow-ups), `useCompleteRoadmapItem()` (mark follow-up complete) — exact names per `MemberRoadmapScreen`'s current imports.
- Produces: a single member journey route (`MemberJourney`); no `Roadmap` route, no `MemberRoadmapScreen` file.

**Consolidated layout (single column; `PageWrap` 1280px on web; CHW journey visual language):**
1. `PageHeader` — "My Journey" / active journey name + progress% + status `Pill`.
2. `StatTile` row — Progress % tile + Wellness Points tile (from `MemberRoadmapScreen` ~780–811).
3. `SectionHeader` "Journey Steps" + Roadmap `Card`: progress bar (8px), horizontal step roadmap (52×52 nodes with inline status `Pill`s + connectors), encouragement banner (from `MemberRoadmapScreen` ~829–890, node sub-component ~242–297).
4. Step detail `Card` — status pill, points, step name/description, due date, required docs (from `MemberRoadmapScreen` ~342–402 / 894–896).
5. Points reference — **derive from the real journey steps** (`step.stepName` + `step.pointsOnCompletion`), NOT the hardcoded `STEP_POINTS_BY_NAME` map. Drop the hardcoded map.
6. `SectionHeader` "From Your Sessions" — session follow-ups grouped by vertical with mark-complete (from `MemberRoadmapScreen` ~494–569 / 920–962, via `useMemberRoadmap` + `useCompleteRoadmapItem`).
7. Web `RightRail` — "Other Journeys" list (from `MemberJourneyScreen` ~338–400 / 613–643). **Drop** the hardcoded "Journey Rewards" rail (`+50 pts → $25 gift card`) — or replace with generic non-numeric copy; do not hardcode point/dollar values.

- [ ] **Step 1: Inventory the source sections + exact symbols.**

```bash
cd native && grep -n "useMemberRoadmap\|useCompleteRoadmapItem\|STEP_POINTS_BY_NAME\|StatTile\|SessionFollowup\|OtherJourney\|JourneyStepNode\|function " src/screens/member/MemberRoadmapScreen.tsx
grep -n "OtherJourney\|RightRail\|useMemberJourneys\|JourneyReward" src/screens/member/MemberJourneyScreen.tsx
```

- [ ] **Step 2: Rebuild `MemberJourneyScreen.tsx`** to the consolidated layout above. Port the sub-components from `MemberRoadmapScreen` (StatTile row, progress bar, `JourneyStepNode`, step detail card, session-followup rows) and the "Other Journeys" rail from the existing `MemberJourneyScreen`. Keep the route name/exported component name as-is (`MemberJourneyScreen`) so navigation needs no rename.

- [ ] **Step 3: Replace hardcoded data with real data.** Build the points reference from `journey.steps` (`stepName` + `pointsOnCompletion`). Remove `STEP_POINTS_BY_NAME` and the hardcoded rewards-rail values. Keep all hooks identical to the originals.

- [ ] **Step 4: Delete the duplicate screen.**

```bash
git rm native/src/screens/member/MemberRoadmapScreen.tsx
```

- [ ] **Step 5: Remove the Roadmap route.** In `src/navigation/MemberTabNavigator.tsx`: delete the `MemberRoadmapScreen` import (~line 46), the `SCREENS` entry `{ name: 'Roadmap', ... }` (~line 183), and `Roadmap` from `MemberTabParamList`. In `src/navigation/AppNavigator.tsx`: delete `Roadmap: 'roadmap',` (~line 262). If the `Map` icon import is now unused, remove it.

- [ ] **Step 6: Repoint the Home CTA.** In `src/screens/member/MemberHomeScreen.tsx` (~line 444), change `navigation.navigate('Roadmap')` → `navigation.navigate('MemberJourney')`.

- [ ] **Step 7: Grep-verify no references remain.**

```bash
cd native && grep -rn "Roadmap\|MemberRoadmapScreen\|STEP_POINTS_BY_NAME" src
```

Expected: no matches.

- [ ] **Step 8: Typecheck.** Run: `cd native && npm run typecheck` — Expected: no errors.

- [ ] **Step 9: Manual verify.** Sidebar "My Journey", the Home journey CTA, and `/member/journey` all open the one consolidated page; it shows StatTiles, the stepped roadmap, step detail, real points reference, session follow-ups, and (web) the Other Journeys rail; visually consistent with CHW journey views; `/member/roadmap` no longer resolves.

- [ ] **Step 10: Commit.**

```bash
git add -A && git commit -m "feat(member): consolidate journey screens into one CHW-styled page"
```

---

## Final verification (after all tasks)

- [ ] `cd native && npm run typecheck` — clean.
- [ ] `cd native && grep -rn "data/mock" src/screens/member` — no matches (no mock imports left on the member side).
- [ ] Walk the member app in the browser: Home, My CHW, **My Journey** (consolidated), Messages (all threads selectable), **Appointments** (CHW layout), Rewards, My Documents, Settings — no Resources item; everything renders real data and looks cohesive with the CHW side.
- [ ] Spot-check the CHW side (calendar, journeys) is visually unchanged.
- [ ] Optional: capture before/after screenshots of Appointments, Messages, and Journey for the PR.

---

## Self-Review notes

- **Spec coverage:** Resources removal → Task 1. Appointments → Task 4. Messages bug + mock → Task 2. Journeys consolidation → Task 5. Redemption mock → Task 3. Final mock-data sweep → Final verification. All spec items mapped.
- **Toolchain honesty:** no jest exists; verification is tsc + manual. Stated in Global Constraints; no fabricated test framework.
- **CHW safety:** Tasks 4 and 5 port patterns into member files only; no CHW edits. Verified by manual CHW spot-check.
- **No-mock rule:** Tasks 2, 3, and 5 each remove specific hardcoded data and grep-verify removal; final sweep confirms.
