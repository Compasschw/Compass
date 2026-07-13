/**
 * Shared responsive breakpoints for mobile-web (react-native-web) layouts.
 *
 * Individual screens have long owned their own multi-pane collapse
 * breakpoints (e.g. CHWMessagesScreen's `BP_HIDE_RAIL` / `BP_HIDE_LIST`,
 * MemberMessagesScreen's `BP_HIDE_RAIL` / `BP_HIDE_INBOX`) — those stay
 * local to each screen since their values are tuned per-layout. This file
 * adds the one breakpoint that's genuinely cross-cutting: the point below
 * which a screen is being viewed on a phone-width web browser (not just a
 * narrowed desktop window) and should collapse to a single column /
 * single-pane presentation.
 *
 * Epic K (mobile web polish) — grep `BP_PHONE` for every call site.
 */

/**
 * Phone-width web breakpoint (px). Below this, treat the viewport as a
 * phone browser: collapse multi-pane screens to one pane, stack forms,
 * and prefer card layouts over fixed-column tables.
 *
 * 520 sits comfortably above the widest common phone viewport (~430px,
 * e.g. iPhone Pro Max) with headroom, while staying well below small
 * tablets (~768px), so it doesn't accidentally trigger phone layouts on
 * larger devices.
 */
export const BP_PHONE = 520;
