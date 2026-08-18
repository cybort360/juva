import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';
// Type-only: erased at compile time, so it never triggers the native module lookup
// that a value import would.
import type { OneSignal as OneSignalType } from 'react-native-onesignal';

import { env } from '@/config/runtimeEnv';
import {
  DEFAULT_QUIET_HOURS,
  decideJourney,
  journeyBody,
  pruneHistory,
  type JourneyCandidate,
  type JourneyDecision,
  type SentMessage,
} from '@/domain/journeys';
import { reportHandled } from '@/services/monitoring';

/**
 * Lifecycle messaging through OneSignal.
 *
 * The decision to send lives in `domain/journeys.ts` — pure, tested, and enforced
 * here rather than in dashboard configuration. That split matters: caps and quiet
 * hours configured only in a web console are a promise nobody can verify from the
 * code, and they stop applying the moment someone builds a campaign by hand.
 *
 * What this module sends to OneSignal is a *tag*, never a message body. Juva's own
 * server does not exist, so the actual delivery is OneSignal's, driven by tags. Which
 * means the tag values are the payload — and none of them may carry a product, a
 * store, a location or an amount.
 */

/**
 * Whether this binary could contain the OneSignal native module at all.
 *
 * Expo Go ships a fixed set of native modules and OneSignal is not among them. Requiring
 * the package there throws a `TurboModuleRegistry.getEnforcing` invariant — and while a
 * try/catch does keep the app alive, React Native reports that invariant to the global
 * handler anyway, so a dev build shows a full-screen red error on every launch that looks
 * exactly like a crash. Checking the execution environment first avoids the throw
 * entirely rather than catching it after the fact.
 */
function nativeModulePossible(): boolean {
  return Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
}

export function pushSupported(): boolean {
  return (
    (Platform.OS === 'ios' || Platform.OS === 'android') &&
    env.oneSignalAppId !== undefined &&
    nativeModulePossible()
  );
}

/** Why push is unavailable, so diagnostics can say rather than just show a `no`. */
export function pushUnavailableReason(): string | undefined {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return 'Push needs iOS or Android.';
  if (env.oneSignalAppId === undefined) return 'No EXPO_PUBLIC_ONESIGNAL_APP_ID configured.';
  if (!nativeModulePossible()) {
    return 'Expo Go has no OneSignal native module. Needs a development build.';
  }
  return undefined;
}

type OneSignalSdk = typeof OneSignalType;

let sdk: OneSignalSdk | undefined;
let started = false;

/**
 * Loads the native SDK, lazily and defensively.
 *
 * This is deliberately not a top-level import. `react-native-onesignal` resolves its
 * native module with `TurboModuleRegistry.getEnforcing` at *import* time, which throws
 * where the native binary has no OneSignal in it — Expo Go, most obviously. A static
 * import therefore crashes the whole app on launch before any guard can run, which is
 * exactly what happened the first time this shipped.
 *
 * So the require happens only once push is both configured and plausibly supported, and
 * a failure leaves `sdk` undefined and every function below a no-op.
 */
function loadSdk(): OneSignalSdk | undefined {
  if (sdk !== undefined) return sdk;
  if (!pushSupported()) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('react-native-onesignal') as { OneSignal: OneSignalSdk };
    sdk = module.OneSignal;
    return sdk;
  } catch {
    // No native OneSignal in this binary. Push is simply unavailable — reported once so
    // a build that *should* have it does not fail silently.
    reportHandled('onesignal.registration_failed', { platform: Platform.OS });
    return undefined;
  }
}

export interface PushState {
  configured: boolean;
  started: boolean;
  supported: boolean;
  optedIn: boolean;
  /** Present when `supported` is false. */
  reason?: string | undefined;
}

export function pushState(): PushState {
  const reason = pushUnavailableReason();
  return {
    configured: env.oneSignalAppId !== undefined,
    started,
    supported: pushSupported(),
    optedIn: started && sdk !== undefined ? sdk.User.pushSubscription.getOptedIn() : false,
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * Initialises OneSignal without asking for anything.
 *
 * Permission is deliberately *not* requested here. A push prompt on launch, before
 * the shopper has seen Juva do anything, is how an app trains someone to say no
 * forever — so the prompt belongs behind an explicit opt-in.
 */
export function initPush(): void {
  const appId = env.oneSignalAppId;
  if (started || appId === undefined) return;
  const client = loadSdk();
  if (!client) return;
  client.initialize(appId);
  started = true;
}

/** Requests permission. Only ever called from an explicit control. */
export async function requestPushPermission(): Promise<boolean> {
  if (!started || !sdk) return false;
  return sdk.Notifications.requestPermission(true);
}

export function optOutOfPush(): void {
  if (!started || !sdk) return;
  sdk.User.pushSubscription.optOut();
}

/**
 * Links the device to Juva's stable anonymous id.
 *
 * The same id RevenueCat uses, so a subscription and a device are the same person
 * without either service learning anything about them. It is a random UUID and is
 * never derived from a device identifier or an email.
 */
export function identifyForPush(appUserId: string): void {
  if (!started || !sdk) return;
  sdk.login(appUserId);
}

/**
 * Tags that may be sent to OneSignal.
 *
 * A closed vocabulary of booleans, counts and coarse states. Adding a tag here is the
 * moment to ask whether it describes the shopper's *situation* or their *shopping* —
 * the first is fine, the second is not.
 */
export interface JourneyTags {
  tier: 'free' | 'plus';
  /** Whether a plan is waiting to be shopped. */
  tripPending: boolean;
  /** Whether a finished trip is still missing its receipt. */
  receiptPending: boolean;
  savedListCount: number;
  verifiedTripCount: number;
}

/**
 * Sends the tag set.
 *
 * Values are coerced to strings because OneSignal tags are strings, and coerced here
 * rather than by the caller so there is one place to audit what leaves.
 */
export function syncJourneyTags(tags: JourneyTags): void {
  if (!started || !sdk) return;
  sdk.User.addTags({
    tier: tags.tier,
    trip_pending: String(tags.tripPending),
    receipt_pending: String(tags.receiptPending),
    saved_lists: String(tags.savedListCount),
    verified_trips: String(tags.verifiedTripCount),
  });
}

/**
 * Runs a candidate through the deterministic rules and records the outcome.
 *
 * Returns the decision either way so a diagnostics screen can show *why* nothing was
 * sent — a silent notification system is impossible to debug and impossible to trust.
 *
 * Sending is expressed as a tag change rather than a message: Juva has no server that
 * could compose one, and a journey configured against these tags in OneSignal is
 * still bound by the caps above, because the tag only flips when the rules allow it.
 */
export function evaluateJourney(
  candidate: JourneyCandidate,
  history: readonly SentMessage[],
  now: Date = new Date(),
): { decision: JourneyDecision; history: SentMessage[]; delivered: boolean } {
  /**
   * Refuse before deciding when nothing can be delivered.
   *
   * Previously this ran the decision, then set the tag only `if (started && sdk)` — but
   * recorded the message in history either way. On a build without OneSignal that burned a
   * slot against the weekly cap for a message that was never sent, and because the cap is
   * one-message-per-subject-ever, the shopper would then never hear about that basket at
   * all. A cap must only be spent on something that actually happened.
   */
  if (!started || !sdk) {
    return {
      decision: { send: false, reason: 'Push is not available in this build.' },
      history: [...history],
      delivered: false,
    };
  }

  const decision = decideJourney(candidate, history, now, DEFAULT_QUIET_HOURS);
  if (!decision.send) return { decision, history: [...history], delivered: false };

  sdk.User.addTag(`journey_${candidate.kind}`, String(Math.floor(now.getTime() / 1000)));

  return {
    decision,
    history: pruneHistory(
      [...history, { kind: candidate.kind, subjectId: candidate.subjectId, sentAt: now.getTime() }],
      now,
    ),
    delivered: true,
  };
}

/** The copy a journey would use, for the diagnostics screen to preview honestly. */
export { journeyBody };
