import { describe, it, expect } from 'vitest';

import { transformKeys, toSnakeCase } from './caseTransform';

describe('transformKeys (snake_case → camelCase)', () => {
  it('converts top-level snake_case keys', () => {
    expect(transformKeys({ first_name: 'Ada', last_name: 'Lovelace' })).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  it('recurses into nested objects', () => {
    expect(
      transformKeys({ user_profile: { date_of_birth: '1990-01-01' } }),
    ).toEqual({ userProfile: { dateOfBirth: '1990-01-01' } });
  });

  it('recurses into arrays of objects', () => {
    expect(
      transformKeys([{ member_id: 1 }, { member_id: 2 }]),
    ).toEqual([{ memberId: 1 }, { memberId: 2 }]);
  });

  it('leaves primitives untouched', () => {
    expect(transformKeys(42)).toBe(42);
    expect(transformKeys('unread_count')).toBe('unread_count');
    expect(transformKeys(null)).toBeNull();
  });

  it('preserves Date instances (does not treat them as objects)', () => {
    const d = new Date('2026-07-10T00:00:00Z');
    expect(transformKeys<{ createdAt: Date }>({ created_at: d }).createdAt).toBe(d);
  });

  it('does not mangle already-camel or non-underscore keys', () => {
    expect(transformKeys({ id: 1, alreadyCamel: 2 })).toEqual({
      id: 1,
      alreadyCamel: 2,
    });
  });
});

describe('toSnakeCase (camelCase → snake_case)', () => {
  it('is the inverse of transformKeys for round-trippable shapes', () => {
    const snake = { insurance_company: 'Health Net', medi_cal_id: '91234567A2' };
    expect(toSnakeCase(transformKeys(snake))).toEqual(snake);
  });

  it('recurses through nested arrays + objects', () => {
    expect(
      toSnakeCase({ billingDetails: [{ costId: 'x' }] }),
    ).toEqual({ billing_details: [{ cost_id: 'x' }] });
  });
});
