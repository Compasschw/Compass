/**
 * alertQueue — module-level pub/sub store backing the in-app AppDialog.
 *
 * `showAlert` (src/utils/showAlert.ts) is a plain function called from
 * anywhere, including OUTSIDE React (e.g. a React Query mutation's
 * `onError`, which runs in a callback with no component instance in scope).
 * It can't call a hook or reach a Context directly. So this module holds the
 * alert queue as external, framework-free state: `enqueueAlert` mutates it
 * and notifies subscribers; `AppDialogProvider` (src/components/shared/
 * AppDialogProvider.tsx) is the sole subscriber, rendering whatever is at the
 * front of the queue via `React.useSyncExternalStore`.
 *
 * Kept queue-based (not single-alert) so a burst of errors — e.g. several
 * mutations failing in quick succession — queues up and shows one dialog at
 * a time instead of the second call silently clobbering the first.
 *
 * No `react` / `react-native` imports — pure logic, covered by
 * `alertQueue.test.ts` (Tier 1, see native/TESTING.md).
 */

export interface AlertQueueItem {
  /** Monotonically increasing — stable React `key` for the rendered dialog. */
  id: number;
  title: string;
  message?: string;
}

type Listener = () => void;

let queue: AlertQueueItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Enqueue a new alert to be shown by `AppDialogProvider`. Safe to call from
 * anywhere — a component, a mutation's `onError`, a plain module function.
 * If a dialog is already showing, this one waits its turn behind it.
 */
export function enqueueAlert(title: string, message?: string): void {
  queue = [...queue, { id: nextId++, title, message }];
  emitChange();
}

/**
 * Dismiss the alert currently at the front of the queue (the one visible to
 * the user), revealing the next one if any. No-op if the queue is empty.
 */
export function dismissFrontAlert(): void {
  if (queue.length === 0) return;
  queue = queue.slice(1);
  emitChange();
}

/** Subscribe to queue changes. Returns an unsubscribe function. */
export function subscribeAlertQueue(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current queue snapshot — same reference until the next mutation. */
export function getAlertQueueSnapshot(): readonly AlertQueueItem[] {
  return queue;
}

/**
 * Test-only: resets all module state (queue, id counter, listeners) so test
 * files don't leak alerts or subscriptions into one another. Not imported by
 * any production code path.
 */
export function __resetAlertQueueForTests(): void {
  queue = [];
  nextId = 1;
  listeners.clear();
}
