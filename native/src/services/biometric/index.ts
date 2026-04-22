/**
 * Biometric unlock — FaceID / TouchID / Android biometric at app launch.
 * Wraps `expo-local-authentication` so AppNavigator can gate the
 * authenticated tabs behind a fresh biometric challenge when
 * `EXPO_PUBLIC_REQUIRE_BIOMETRIC=1`.
 *
 * Default behavior: off (requireUnlock always resolves true, no prompt).
 * This is the safe default — we don't want to lock out users during
 * development and we don't want to require biometrics for members who
 * prefer not to use them.
 *
 * Install to activate:
 *   npx expo install expo-local-authentication
 *   // add "NSFaceIDUsageDescription" to app.json ios.infoPlist
 *   # then set EXPO_PUBLIC_REQUIRE_BIOMETRIC=1
 */

export interface BiometricProvider {
  /** Returns true if the device has biometric hardware AND the user has enrolled a credential. */
  isAvailable(): Promise<boolean>;
  /**
   * Present the biometric prompt. Resolves true on success, false on
   * cancel/fallback/failure. When biometrics are disabled (default) or
   * unavailable, resolves true without prompting.
   */
  requireUnlock(reason?: string): Promise<boolean>;
}

// ─── Module-detection helper ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedModule: any | null | undefined;

function loadLocalAuth(): unknown | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    cachedModule = require('expo-local-authentication');
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

// ─── Real provider (expo-local-authentication) ──────────────────────────────

class ExpoBiometricProvider implements BiometricProvider {
  async isAvailable(): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = loadLocalAuth();
    if (!mod) return false;
    const [hasHardware, isEnrolled] = await Promise.all([
      mod.hasHardwareAsync(),
      mod.isEnrolledAsync(),
    ]);
    return Boolean(hasHardware && isEnrolled);
  }

  async requireUnlock(reason?: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = loadLocalAuth();
    if (!mod) return true; // Fail open if the module isn't installed.

    if (!(await this.isAvailable())) return true;

    const result = await mod.authenticateAsync({
      promptMessage: reason ?? 'Unlock CompassCHW',
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    return Boolean(result?.success);
  }
}

// ─── Bypass provider (default) ──────────────────────────────────────────────

class BypassBiometricProvider implements BiometricProvider {
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async requireUnlock(): Promise<boolean> {
    return true;
  }
}

// ─── Factory + singleton ─────────────────────────────────────────────────────

function createBiometricProvider(): BiometricProvider {
  if (process.env.EXPO_PUBLIC_REQUIRE_BIOMETRIC !== '1') {
    return new BypassBiometricProvider();
  }
  return loadLocalAuth() ? new ExpoBiometricProvider() : new BypassBiometricProvider();
}

export const biometric: BiometricProvider = createBiometricProvider();
