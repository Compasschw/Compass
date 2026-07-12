# Frontend testing (Vitest)

Two tiers, one runner. This is where silent regressions have bitten us — a shared
helper or a mutation's cache logic changes, callers break, and `tsc` stays green.

## Run

```bash
bun run test        # once (what CI runs)
bun run test:watch  # watch mode while developing
bun run test:cov    # with a coverage report
```

## Tier 1 — pure logic (`*.test.ts`, node env)

No `react` / `react-native` imports. Data transforms, validation, date/geo math.
Examples: `src/utils/caseTransform.ts` (snake↔camel, runs on every response),
`src/utils/availabilityShading.ts` (calendar math), `src/constants/insurance.ts`
(CIN validation), `src/utils/sessionTimer.ts`, `src/utils/sessionStartOptimistic.ts`.

A `.test.ts` file must **not** import a component — it has no DOM.

## Tier 2 — components & hooks (`*.test.tsx`, jsdom env)

Renders **exactly as production web does**: jsdom + `react-native` aliased to
`react-native-web` (Compass ships web-first). Use `@testing-library/react`
(`render`, `renderHook`, `screen`, `fireEvent`, `waitFor`). This tier tests the
layer where the real risk lives and pure-logic tests can't reach:

- **React Query mutation orchestration** — optimistic `onMutate` writes, `onError`
  rollback, `onSettled` reconciliation. See `src/hooks/useStartSession.test.tsx`
  (asserts the Begin-Session optimistic flip AND the rollback on failure — the
  case a helper test alone would miss).
- **Component state transitions** — e.g. a modal's confirm → submit → success flow.

Notes:
- `src/__tests__/harness.smoke.test.tsx` is the harness's own guard — if it fails,
  fix the harness before trusting other `.test.tsx` files.
- Expo native modules (`expo-secure-store`, `expo-file-system`, `expo-sharing`)
  and the `__DEV__` global are stubbed in `vitest.setup.ts`. If a new component
  test drags in another native-only module, stub it there.
- Mock only the network boundary (`vi.mock('../api/client', …)`), not the logic
  under test.

## The rule (see also the repo-wide test-discipline directive)

Test the layer where the risk is — pure logic → Tier 1; mutation cache
orchestration / component state → Tier 2. Don't stop at the easy layer, and don't
call a mutation/component "tested" when only its extracted helper is. New logic
ships with a test in the same PR. CI runs `bun run test` on every PR.
