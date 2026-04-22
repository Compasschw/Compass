/**
 * Phone dialing — wraps the "start a call" action so we can swap in
 * Vonage masked calling (required for HIPAA-compliant CHW ↔ member
 * communication) without touching every button that triggers a dial.
 *
 * Default provider: `Linking.openURL('tel:...')` — opens the native dialer
 * with whichever number you pass. Safe fallback that doesn't mask the
 * recipient's number, so it's a dev/demo-only path until the Vonage BAA
 * is live.
 *
 * Vonage provider: hits the backend `/communication/call-bridge` endpoint
 * which creates a short-lived proxy number on the backend side and returns
 * it. We then `tel:` the proxy number — Vonage records + bridges the call,
 * and neither party sees the other's real number.
 *
 * Activation: set `EXPO_PUBLIC_USE_VONAGE_DIAL=1` once the backend Vonage
 * integration is live (BAA signed + env vars on EC2).
 */

import { Linking } from 'react-native';

import { api } from '../../api/client';

export interface PhoneDialRequest {
  /** The user who is initiating the call (their own id). */
  callerId: string;
  /** The user they want to call. */
  recipientId: string;
  /** Session context — Vonage associates the proxy with this session id. */
  sessionId?: string;
  /** Raw local phone number to fall back to when masking isn't available. */
  fallbackNumber?: string;
}

export interface PhoneProvider {
  dial(req: PhoneDialRequest): Promise<void>;
}

// ─── Direct-dial provider (default / dev) ────────────────────────────────────

class DirectDialProvider implements PhoneProvider {
  async dial(req: PhoneDialRequest): Promise<void> {
    if (!req.fallbackNumber) {
      throw new Error('No fallback number available and masked-dial disabled.');
    }
    const url = `tel:${req.fallbackNumber.replace(/[^+\d]/g, '')}`;
    const supported = await Linking.canOpenURL(url);
    if (!supported) {
      throw new Error('Device does not support telephony.');
    }
    await Linking.openURL(url);
  }
}

// ─── Vonage masked provider (activated by EXPO_PUBLIC_USE_VONAGE_DIAL=1) ────

interface CallBridgeResponse {
  proxyNumber: string;
  expiresAt: string;
}

class VonageMaskedDialProvider implements PhoneProvider {
  async dial(req: PhoneDialRequest): Promise<void> {
    const bridge = await api<CallBridgeResponse>(
      '/communication/call-bridge',
      {
        method: 'POST',
        body: JSON.stringify({
          recipient_id: req.recipientId,
          session_id: req.sessionId,
        }),
      },
    );
    const url = `tel:${bridge.proxyNumber.replace(/[^+\d]/g, '')}`;
    await Linking.openURL(url);
  }
}

// ─── Factory + singleton ─────────────────────────────────────────────────────

function createPhoneProvider(): PhoneProvider {
  if (process.env.EXPO_PUBLIC_USE_VONAGE_DIAL === '1') {
    return new VonageMaskedDialProvider();
  }
  return new DirectDialProvider();
}

export const phone: PhoneProvider = createPhoneProvider();
