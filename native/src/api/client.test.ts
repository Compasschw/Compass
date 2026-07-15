/**
 * Unit tests for the `api()` error parser — specifically the Pydantic
 * list-shaped `detail` branch (QA batch item 2, Part 2 of the auth/signup
 * UX PR).
 *
 * FastAPI/Pydantic validation errors (422s) return `detail` as a list of
 * `{loc, msg, type}` objects. Before this fix that shape fell through to the
 * generic-object branch and `JSON.stringify`'d the whole list into the error
 * banner — a raw Pydantic blob instead of readable text. This suite pins the
 * fix: the first item's `msg` is surfaced, with Pydantic's "Value error, "
 * custom-validator prefix stripped, and existing string/dict `detail` shapes
 * (and the malformed-body fallback) are unchanged.
 *
 * Only the network boundary (`global.fetch`) is mocked — `api()` itself runs
 * for real. `skipAuth: true` sidesteps the token-refresh path entirely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('api() — error detail parsing', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('surfaces the first message from a Pydantic list-shaped detail, stripping the "Value error, " prefix', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(422, {
        detail: [
          {
            loc: ['body', 'password'],
            msg: 'Value error, Password must contain at least one special character',
            type: 'value_error',
          },
        ],
      }),
    );

    await expect(api('/auth/register', { method: 'POST', skipAuth: true })).rejects.toMatchObject(
      {
        status: 422,
        message: 'Password must contain at least one special character',
      },
    );
  });

  it('uses only the first item when the list has multiple validation errors', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(422, {
        detail: [
          { loc: ['body', 'password'], msg: 'Value error, too short', type: 'value_error' },
          { loc: ['body', 'email'], msg: 'field required', type: 'value_error.missing' },
        ],
      }),
    );

    await expect(api('/auth/register', { method: 'POST', skipAuth: true })).rejects.toMatchObject(
      { message: 'too short' },
    );
  });

  it('falls back to JSON.stringify when the first list item has no string msg', async () => {
    const detail = [{ loc: ['body', 'password'], type: 'value_error' }];
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(422, { detail }),
    );

    await expect(api('/auth/register', { method: 'POST', skipAuth: true })).rejects.toMatchObject(
      { message: JSON.stringify(detail) },
    );
  });

  it('still surfaces a plain string detail unchanged', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(409, { detail: 'Email already registered' }),
    );

    await expect(api('/auth/register', { method: 'POST', skipAuth: true })).rejects.toMatchObject(
      { status: 409, message: 'Email already registered' },
    );
  });

  it('still extracts .message from a structured dict detail (e.g. ANOTHER_SESSION_IN_PROGRESS)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(409, {
        detail: { code: 'ANOTHER_SESSION_IN_PROGRESS', message: 'Another session is active.' },
      }),
    );

    const error = await api('/sessions/start', { method: 'POST', skipAuth: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('Another session is active.');
    expect((error as ApiError).rawDetail).toEqual({
      code: 'ANOTHER_SESSION_IN_PROGRESS',
      message: 'Another session is active.',
    });
  });
});
