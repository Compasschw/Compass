/**
 * Platform password policy — the client-side mirror of the backend's
 * `validate_password_complexity` (app/utils/passwords.py). Applied everywhere
 * a password is SET: self-registration, CHW-created member temp passwords,
 * the first-login set-your-password gate, change-password, and reset-confirm.
 *
 * Rules: at least 8 characters, ≥1 uppercase letter, ≥1 digit, ≥1 special
 * (non-alphanumeric) character. Keep in sync with the backend validator —
 * the server remains authoritative (422 on mismatch); this exists so users
 * get instant, specific feedback instead of a round-trip error.
 */

export const PASSWORD_MIN_LENGTH = 8;

/** One-line hint shown under password inputs. */
export const PASSWORD_RULES_HINT =
  'At least 8 characters, with an uppercase letter, a number, and a special character.';

/**
 * Returns the first user-facing rule violation, or null when the password
 * satisfies the platform policy. Messages name the exact missing pieces so
 * the user never has to guess.
 */
export function validatePasswordComplexity(password: string): string | null {
  const missing: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    missing.push(`at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (!/[A-Z]/.test(password)) {
    missing.push('an uppercase letter');
  }
  if (!/[0-9]/.test(password)) {
    missing.push('a number');
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    missing.push('a special character');
  }
  if (missing.length === 0) return null;
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  return `Password needs ${list}.`;
}
