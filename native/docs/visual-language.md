# Compass Visual Language — CHW Design System Reference

> **Audience:** Wave 3 Member-screen redesign agents (T18–T30).
> **Status:** Extracted from CHW screens as of 2026-06-09 (T17).
> Read this doc before touching any Member screen file.

---

## 1. The Two Token Systems — Critical Context

The codebase contains **two** colour/token files. Only one is canonical for new work:

| File | Status | Use it for |
|------|--------|-----------|
| `src/theme/tokens.ts` | **CANONICAL** — dashboard visual language | All new screens, all CHW screens |
| `src/theme/colors.ts` | Legacy warm-cream brand palette | Backward compat only; do NOT use in new screens |

CHW screens import the canonical tokens this way:

```tsx
import { colors as tokens, spacing, radius, shadows } from '../../theme/tokens';
```

Wave 3 Member screens **must** use the same import. Never import from `../../theme/colors` in new screens.

The `theme/index.ts` barrel now re-exports the canonical tokens as `tokens`:

```tsx
// Also valid via the barrel:
import { tokens, spacing, radius, shadows } from '../../theme';
```

---

## 2. Colour Tokens (`src/theme/tokens.ts`)

### Surfaces
| Token | Hex | Use |
|-------|-----|-----|
| `tokens.pageBg` | `#f5f7f6` | Screen/SafeAreaView background |
| `tokens.cardBg` | `#ffffff` | Card background |
| `tokens.cardBorder` | `#f1f5f4` | Card 1px border |

### Brand Green
| Token | Hex | Use |
|-------|-----|-----|
| `tokens.primary` | `#16a34a` (emerald-600) | Primary buttons, links, active states |
| `tokens.primaryHover` | `#15803d` | Pressed state |
| `tokens.emerald500` | `#10b981` | Charts, progress lines |
| `tokens.emerald700` | `#047857` | Delta text (positive), icon colour |
| `tokens.emerald100` | `#d1fae5` | Icon badge bg, delta pill bg |

### Sidebar (CHW web layout only)
| Token | Hex |
|-------|-----|
| `tokens.sidebarBg` | `#134e36` |
| `tokens.sidebarText` | `#a7d4be` |

### Text
| Token | Hex | Use |
|-------|-----|-----|
| `tokens.textPrimary` | `#111827` | Headings, bold values |
| `tokens.textSecondary` | `#6b7280` | Labels, subtitles |
| `tokens.textMuted` | `#9ca3af` | Timestamps, captions |

### Semantic Pill Pairs (100 = bg, 700 = text)
All available via the `Pill` component's `variant` prop:

| Variant | Bg token | Text token | Typical use |
|---------|----------|------------|-------------|
| `emerald` | `emerald100` | `emerald700` | Active, completed, positive |
| `red` | `red100` | `red700` | Error, cancelled, urgent |
| `amber` | `amber100` | `amber700` | Warning, overdue, pending |
| `blue` | `blue100` | `blue700` | Scheduled, informational |
| `purple` | `purple100` | `purple700` | Earnings, premium |
| `gray` | `gray100` | `gray700` | Neutral, muted |

---

## 3. Spacing Scale (`src/theme/tokens.ts` → `spacing`)

```
xs: 4    sm: 8    md: 12    lg: 16    xl: 20    xxl: 24    xxxl: 32
```

Key application rules observed across CHW screens:
- **Card internal padding:** `spacing.xl` (20) — used universally
- **Grid gap between cards:** `spacing.xxl` (24)
- **Gap between screen sections:** `spacing.xxl` (24)
- **Page wrapper padding on web:** `spacing.xxxl` (32)
- **Row gap between items in a list:** `spacing.md` (12)

---

## 4. Border Radii (`src/theme/tokens.ts` → `radius`)

```
sm: 6    md: 10    lg: 12    xl: 16    pill: 999
```

Key application rules:
- **Card outer radius:** `radius.xl` (16) — from `Card` component
- **Icon badge radius:** `radius.lg` (12)
- **Action button radius:** `radius.lg` (12)
- **Status chips/pills:** `radius.pill` (999)
- **Small badge/tag:** `radius.sm` (6)

> **Divergence note:** `theme/spacing.ts` defines its own `radii` object with
> values sm:8, md:12, lg:16, xl:20. The CHW screens exclusively use the `radius`
> object from `tokens.ts`. Pick `tokens.ts` as canonical; the `spacing.ts` radii
> are legacy.

---

## 5. Shadows (`src/theme/tokens.ts` → `shadows`)

```ts
shadows.card     // iOS: 0/1/0.04/3 — matches Tailwind shadow-sm
                 // Android: elevation 1
                 // Web: boxShadow '0 1px 3px rgba(0,0,0,.04), 0 1px 2px rgba(0,0,0,.03)'
```

> Note: `theme/shadows.ts` (legacy) defines a green-tinted `card`, `elevated`, and `glow`.
> CHW screens use `tokens.shadows.card` exclusively. Use that.

---

## 6. Typography Scale (`src/theme/typography.ts`)

Font families:
- **Display:** `DMSans_700Bold` / `DMSans_600SemiBold` / `DMSans_500Medium`
- **Body:** `PlusJakartaSans_400Regular` through `PlusJakartaSans_700Bold`

Scale:

| Token | Size | Weight | Use |
|-------|------|--------|-----|
| `displayXl` | 48 | 700 | Hero numbers |
| `displayLg` | 36 | 700 | Page-level hero |
| `displayMd` | 28 | 700 | Section hero |
| `displaySm` | 24 | 600 | PageHeader title |
| `bodyLg` | 18 | 400 | Lead body |
| `bodyMd` | 16 | 400 | Body text |
| `bodySm` | 14 | 400 | Secondary body |
| `label` | 12 | 600 | Table headers, caps labels |

CHW screens mostly use **inline** fontSize/fontWeight rather than the typography scale. Wave 3 agents should prefer the typography tokens where possible to reduce drift.

---

## 7. Shared Component Library

All primitives live in `src/components/ui/` and are barrel-exported from `src/components/ui/index.ts`.

Import pattern:
```tsx
import { Card, StatTile, PageHeader, SectionHeader, Pill } from '../../components/ui';
```

### Card

**File:** `src/components/ui/Card.tsx`

White rounded-corner container. The base surface for all content regions.

```tsx
export interface CardProps {
  style?: StyleProp<ViewStyle>; // merged onto outer View
  children?: React.ReactNode;
}
```

Visual spec:
- Background: `tokens.cardBg` (`#ffffff`)
- Border: 1px `tokens.cardBorder` (`#f1f5f4`)
- Radius: `radius.xl` (16px)
- Shadow: `shadows.card`
- **No padding** by default — callers add `style={{ padding: spacing.xl }}` explicitly

```tsx
// CHW Dashboard usage:
<Card style={{ padding: spacing.xl }}>
  <SectionHeader title="Today's Schedule" right={<ViewAllLink />} />
  {/* content */}
</Card>
```

### StatTile

**File:** `src/components/ui/StatTile.tsx`

KPI metric tile. Composes `Card`. Icon badge top-left, value large center, label below, delta pill top-right.

```tsx
export interface StatTileProps {
  icon: React.ReactNode;        // lucide icon, pre-colored
  iconBg?: string;              // badge circle bg; default emerald100
  label: string;                // descriptor e.g. "Sessions today"
  value: string | number;       // primary metric e.g. 12 or "$4,820"
  delta?: string;               // change text e.g. "+8 this week"
  deltaColor?: string;          // default emerald700
  deltaBg?: string;             // default #ecfdf5
  style?: StyleProp<ViewStyle>; // forwarded to Card
  onPress?: () => void;         // makes tile a Pressable
  accessibilityLabel?: string;
}
```

```tsx
// Standard usage — CHW Dashboard KPI row:
<StatTile
  icon={<CalendarCheck size={18} color={tokens.emerald700} />}
  iconBg={tokens.emerald100}
  label="Sessions today"
  value={sessionsTodayCount}
  delta={`+${sessionsTodayCount} today`}
  deltaColor={tokens.emerald700}
  deltaBg="#ecfdf5"
  style={styles.kpiTile}
  onPress={() => navigation.navigate('Calendar')}
/>
```

KPI grid layout pattern (from CHWDashboardScreen):
```tsx
<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, marginBottom: spacing.xxl }}>
  <StatTile ... style={{ minWidth: '48%', flexBasis: '48%', flexGrow: 1 }} />
  <StatTile ... style={{ minWidth: '48%', flexBasis: '48%', flexGrow: 1 }} />
  <StatTile ... style={{ minWidth: '48%', flexBasis: '48%', flexGrow: 1 }} />
  <StatTile ... style={{ minWidth: '48%', flexBasis: '48%', flexGrow: 1 }} />
</View>
```

### PageHeader

**File:** `src/components/ui/PageHeader.tsx`

Top-of-screen title row. Used on every CHW and Member dashboard page.

```tsx
export interface PageHeaderProps {
  title: string;           // 24px / 700 / textPrimary
  subtitle?: string;       // 14px / 400 / textSecondary
  right?: React.ReactNode; // action buttons, search, CTAs
}
```

```tsx
<PageHeader
  title="Good morning, Maria 👋"
  subtitle="Monday, June 9 · 12 active members · 3 sessions today"
  right={
    <TouchableOpacity style={styles.newSessionBtn} onPress={onNewSession}>
      <Plus size={14} color="#fff" />
      <Text style={styles.newSessionText}>New Session</Text>
    </TouchableOpacity>
  }
/>
```

Visual spec:
- Container: `flexDirection: 'row'`, `alignItems: 'center'`, `marginBottom: spacing.xxl` (24)
- Title: 24px / 700 / `tokens.textPrimary`
- Subtitle: 14px / 400 / `tokens.textSecondary`

### SectionHeader

**File:** `src/components/ui/SectionHeader.tsx` *(new — T17)*

In-card section delimiter. Replaces the inline `cardTitle` + `cardHeaderRow` + `viewAllLink` pattern repeated across all CHW screens.

```tsx
export interface SectionHeaderProps {
  title: string;            // 16px / 600 / textPrimary
  subtitle?: string;        // 12px / 400 / textSecondary
  right?: React.ReactNode;  // "View all →" links, toggles
  marginBottom?: number;    // default spacing.lg (16)
  style?: StyleProp<ViewStyle>;
}
```

```tsx
// Simple section title:
<SectionHeader title="Weekly snapshot" />

// With a "View all" link:
<SectionHeader
  title="Recent activity"
  right={
    <TouchableOpacity onPress={onViewAll} accessibilityRole="link">
      <Text style={{ color: tokens.primary, fontWeight: '600', fontSize: 13 }}>
        Open feed →
      </Text>
    </TouchableOpacity>
  }
/>

// With subtitle:
<SectionHeader
  title="Bank & payout setup"
  subtitle="Connected via Stripe Express"
/>
```

### Pill

**File:** `src/components/ui/Pill.tsx`

Semantic colour-coded status chip.

```tsx
export type PillVariant = 'emerald' | 'red' | 'amber' | 'amber-dark'
                        | 'blue' | 'purple' | 'orange' | 'pink'
                        | 'gray' | 'gray-muted';
export type PillSize = 'sm' | 'md'; // default 'md'

export interface PillProps {
  variant: PillVariant;
  size?: PillSize;
  withDot?: boolean; // renders 8px filled dot before text
  children: React.ReactNode;
}
```

```tsx
<Pill variant="emerald" size="sm">Active</Pill>
<Pill variant="amber" withDot>Overdue</Pill>
<Pill variant="red" size="sm">Cancelled</Pill>
```

### Badge (legacy — use Pill for new screens)

**File:** `src/components/shared/Badge.tsx`

Semantic badge with fixed variant+value mapping (vertical, urgency, session-status, request-status, billing-status). Predates `Pill`. New screens should use `Pill` directly.

---

## 8. Visual Patterns Observed in CHW Screens

These are compositional patterns Wave 3 agents must replicate on Member screens.

### 8.1 Screen Shell Pattern

```tsx
// Every CHW screen:
<SafeAreaView style={{ flex: 1, backgroundColor: tokens.pageBg }} edges={['top']}>
  <AppShell role="member" activeKey="home" userBlock={...}>
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={Platform.OS === 'web' ? { flexGrow: 1 } : { flexGrow: 1, alignItems: 'center' }}
      showsVerticalScrollIndicator={false}
    >
      <View style={Platform.OS === 'web'
        ? { width: '100%', padding: spacing.xxxl, paddingBottom: 48 }
        : { width: '100%', padding: spacing.xl, paddingBottom: 48 }
      }>
        <PageHeader title="..." subtitle="..." right={...} />
        {/* screen content */}
      </View>
    </ScrollView>
  </AppShell>
</SafeAreaView>
```

### 8.2 KPI Stat Grid

Seen on CHWDashboardScreen and CHWEarningsScreen. 4 tiles, 2-per-row on all sizes:

```tsx
<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, marginBottom: spacing.xxl }}>
  {/* 4 × StatTile with minWidth:'48%', flexBasis:'48%', flexGrow:1 */}
</View>
```

### 8.3 Multi-column Card Row (web-responsive)

```tsx
// 7:5 ratio (like Dashboard mid-row):
<View style={{ flexDirection: Platform.OS === 'web' ? 'row' : 'column', gap: spacing.xxl }}>
  <Card style={{ flex: Platform.OS === 'web' ? 7 : undefined, padding: spacing.xl }}>
    {/* main content */}
  </Card>
  <Card style={{ flex: Platform.OS === 'web' ? 5 : undefined, padding: spacing.xl }}>
    {/* secondary content */}
  </Card>
</View>
```

### 8.4 Card With Section Header

```tsx
<Card style={{ padding: spacing.xl }}>
  <SectionHeader
    title="Recent Activity"
    right={
      <TouchableOpacity onPress={onViewAll}>
        <Text style={{ color: tokens.primary, fontWeight: '600', fontSize: 13 }}>
          View all →
        </Text>
      </TouchableOpacity>
    }
  />
  {/* list items */}
</Card>
```

### 8.5 Status Pill Usage

From CHWDashboardScreen's `AttentionCard` and CHWEarningsScreen table:

```tsx
// Emerald = completed/active/positive
<Pill variant="emerald" size="sm">paid</Pill>

// Amber = in-progress/pending/warning
<Pill variant="amber" size="sm">submitted</Pill>

// Red = error/cancelled/urgent
<Pill variant="red" size="sm">denied</Pill>

// Blue = informational/scheduled
<Pill variant="blue" size="sm">98960</Pill>

// Gray = neutral/muted
<Pill variant="gray" size="sm">awaiting claim</Pill>
```

---

## 9. CHW Screen Annotations

### CHWDashboardScreen (`screens/chw/CHWDashboardScreen.tsx`)

Layout: PageHeader → KPI row (4 StatTiles) → 2-col row (Schedule Card + Attention Card) → 2-col row (Snapshot Card + Activity Card)

Primitives in use:
- `AppShell` role="chw" — provides sidebar nav + page chrome
- `PageHeader` — greeting + today's date + member count + New Session button
- `StatTile` ×4 — sessions/overdue/messages/earnings KPIs
- `Card` — all 4 content cards (padding: spacing.xl = 20)
- `SectionHeader` pattern (inline) — each card uses `cardTitle` + `cardHeaderRow` styles → now covered by the new `SectionHeader` primitive
- `Pill` — schedule row time chips (emerald when starting soon, gray otherwise)
- `PressableMember` — tappable member name links within cards

Inline patterns unique to this screen (not extracted to primitives):
- `ScheduleRow` — time stack + avatar + name/meta + pill + action button
- `AttentionCard` — coloured alert row with icon, title (optional member link), subtitle, action link
- `SnapshotBox` — 2×2 grid cell with label/value/delta

Token decisions observed:
- Safe area bg: `tokens.pageBg` (`#f5f7f6`)
- Card surfaces: `tokens.cardBg` (`#ffffff`) via `Card` component
- All greens: `tokens.emerald100/700`, `tokens.primary` (`#16a34a`)
- Text hierarchy: `tokens.textPrimary` / `tokens.textSecondary` / `tokens.textMuted`

---

### CHWEarningsScreen (`screens/chw/CHWEarningsScreen.tsx`)

Layout: AppShell → PageHeader → custom subtitle row → 4 StatTiles → trend+bank row → sessions table card → recent payouts card

Primitives in use:
- `AppShell`, `PageHeader`, `Card`, `StatTile` ×4, `Pill` (claim status chips)

Inline patterns unique to this screen (not extracted):
- `PeriodSelector` — web native select / native TouchableOpacity cycle
- `BankCheckItem` — CheckCircle2 + label row
- Sessions billed horizontal ScrollView table
- SVG earnings trend chart (web-only)

Token decisions observed:
- Stat tile colours span all 4 semantic pairs: emerald / blue / purple / amber
- Table header bg: `#f9fafb` (gray-50 approximation — close to `tokens.pageBg`)
- Row dividers: `#f3f4f6` (gray-100)

---

### CHWMemberProfileScreen (`screens/chw/CHWMemberProfileScreen.tsx`)

Layout: Full-width identity card → 9:3 mid row (insights + RightRail) → journey section (9:3)

Primitives in use:
- `AppShell`, `PageHeader`, `Card`, `Pill`, `RightRail`, `RightDrawer`

Token split on this screen — **mixed imports**:
```tsx
import { colors } from '../../theme/colors';           // legacy warm-cream
import { fonts } from '../../theme/typography';
import { colors as tokens } from '../../theme/tokens'; // canonical dashboard tokens
```
The screen uses `colors` (legacy) for some avatar/badge fills and `tokens` for card surfaces and text. Wave 3 Member screens should collapse to `tokens` only.

---

### CHWSessionsScreen (`screens/chw/CHWSessionsScreen.tsx`)

Layout: PageHeader → tab bar (Active / Completed) → FlatList of session cards

Primitives in use:
- `AppShell`, `PageHeader`, `Card`, `Pill`, `RightRail`

Token split — **mixed imports** (same pattern as MemberProfile):
```tsx
import { colors } from '../../theme/colors';     // legacy
import { typography } from '../../theme/typography';
// (no import from tokens.ts — uses inline hex literals)
```
This screen has the most inline hex literals (`#16a34a`, `#f3f4f6`, etc.) and does NOT import from `tokens.ts`. Wave 4 CHW cleanup should migrate these. Wave 3 agents: do not copy this pattern.

---

## 10. What to Import — Quick Reference for Wave 3

```tsx
// 1. Token primitives (ALWAYS use tokens.ts, never colors.ts)
import { colors as tokens, spacing, radius, shadows } from '../../theme/tokens';

// 2. UI components (all from the ui/ barrel)
import {
  AppShell,
  Card,
  StatTile,
  PageHeader,
  SectionHeader,
  Pill,
  RightRail,
} from '../../components/ui';

// 3. Shared utilities
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { Badge } from '../../components/shared/Badge'; // only if you need vertical/urgency chips
```

---

## 11. Open Questions Before Wave 3 Dispatches

1. **Member AppShell role:** CHW screens pass `role="chw"`. Member screens should pass `role="member"`. Confirm the `AppShell` renders the correct sidebar items for `role="member"` — check `sidebarItems.ts`.

2. **Member screens max-width:** The cofounders' prior feedback (in MEMORY.md) says "Mobile screens need max-width on web" — wrap Member screen page content in a centered `maxWidth: 560` container on web, unlike CHW screens which go full-width. This is a deliberate difference from CHW screens.

3. **Mixed-import screens:** `CHWMemberProfileScreen` and `CHWSessionsScreen` import from both `theme/colors.ts` and `theme/tokens.ts`. Member screens should use `tokens.ts` only. Flag if you find Member screens that import from `theme/colors` — those will need a targeted update.

4. **`LoadingSkeleton` uses `colors.card` from `theme/colors.ts`** (legacy warm-cream, `#F7F5F1`) rather than `tokens.cardBg` (`#ffffff`). The skeleton tiles will look slightly warm instead of pure white. This is a minor visual divergence. Wave 4 can fix; Wave 3 agents should use `LoadingSkeleton` as-is.

5. **`SectionHeader` margin-bottom default:** Currently `spacing.lg` (16). If a screen needs tighter spacing (e.g. list items immediately below the header), pass `marginBottom={spacing.sm}` explicitly.
