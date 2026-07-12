/**
 * Pure-logic tests for the alertQueue module-level store backing
 * AppDialogProvider. No react-native import — Tier 1 (see native/TESTING.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAlertQueueForTests,
  dismissFrontAlert,
  enqueueAlert,
  getAlertQueueSnapshot,
  subscribeAlertQueue,
} from './alertQueue';

beforeEach(() => {
  __resetAlertQueueForTests();
});

describe('alertQueue', () => {
  it('starts empty', () => {
    expect(getAlertQueueSnapshot()).toEqual([]);
  });

  it('enqueue appends an alert with title and optional message', () => {
    enqueueAlert('Failed to schedule session', 'Please try again.');

    const snapshot = getAlertQueueSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      title: 'Failed to schedule session',
      message: 'Please try again.',
    });
  });

  it('enqueue supports a title with no message', () => {
    enqueueAlert('Begin a session first');

    expect(getAlertQueueSnapshot()[0]).toMatchObject({
      title: 'Begin a session first',
      message: undefined,
    });
  });

  it('queues a burst of alerts in call order instead of dropping any', () => {
    enqueueAlert('Failed to schedule session');
    enqueueAlert('Could not end session');
    enqueueAlert('Could not save note');

    const snapshot = getAlertQueueSnapshot();
    expect(snapshot.map((a) => a.title)).toEqual([
      'Failed to schedule session',
      'Could not end session',
      'Could not save note',
    ]);
  });

  it('dismissFrontAlert removes only the front item, revealing the next', () => {
    enqueueAlert('First');
    enqueueAlert('Second');

    dismissFrontAlert();

    const snapshot = getAlertQueueSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].title).toBe('Second');
  });

  it('dismissFrontAlert on an empty queue is a no-op', () => {
    expect(() => dismissFrontAlert()).not.toThrow();
    expect(getAlertQueueSnapshot()).toEqual([]);
  });

  it('assigns each alert a unique, stable id', () => {
    enqueueAlert('First');
    enqueueAlert('Second');

    const [first, second] = getAlertQueueSnapshot();
    expect(first.id).not.toBe(second.id);
  });

  it('notifies subscribers on enqueue and on dismiss', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAlertQueue(listener);

    enqueueAlert('Something went wrong');
    expect(listener).toHaveBeenCalledTimes(1);

    dismissFrontAlert();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('stops notifying a listener after it unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAlertQueue(listener);
    unsubscribe();

    enqueueAlert('Something went wrong');

    expect(listener).not.toHaveBeenCalled();
  });

  it('returns the same snapshot reference until the next mutation', () => {
    enqueueAlert('First');
    const snapshotA = getAlertQueueSnapshot();
    const snapshotB = getAlertQueueSnapshot();
    expect(snapshotA).toBe(snapshotB);

    dismissFrontAlert();
    const snapshotC = getAlertQueueSnapshot();
    expect(snapshotC).not.toBe(snapshotA);
  });
});
