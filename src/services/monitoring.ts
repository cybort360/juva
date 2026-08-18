import * as Sentry from '@sentry/react-native';

import { env } from '@/config/runtimeEnv';

import { scrubBreadcrumb, scrubEvent, type ScrubbableEvent } from './privacyScrub';

/**
 * Crash and performance monitoring.
 *
 * Optional in exactly the way RevenueCat is: no DSN means no monitoring and a fully
 * working app. Nothing in Juva may depend on this being initialised.
 *
 * Every event passes through `privacyScrub` before it leaves. That module is pure and
 * tested; this one is the wiring, and it is deliberately thin so there is no second
 * place where a decision about what to upload could be made.
 */

let started = false;

export interface MonitoringState {
  configured: boolean;
  started: boolean;
  environment: string;
  /** Performance sample rate actually in use, for the diagnostics screen. */
  tracesSampleRate: number;
}

/**
 * Trace sampling.
 *
 * Full sampling in development, where the traces are the point; sparse in production,
 * where the value is aggregate latency rather than any individual trip.
 */
function tracesSampleRate(): number {
  return env.environment === 'production' ? 0.1 : 1;
}

export function monitoringState(): MonitoringState {
  return {
    configured: env.sentryDsn !== undefined,
    started,
    environment: env.environment,
    tracesSampleRate: tracesSampleRate(),
  };
}

export function initMonitoring(): void {
  const dsn = env.sentryDsn;
  if (started || dsn === undefined) return;

  Sentry.init({
    dsn,
    environment: env.environment,
    tracesSampleRate: tracesSampleRate(),

    /**
     * Everything below is a deliberate refusal.
     *
     * These defaults are what make a crash reporter leak: PII attachment, request
     * bodies, screenshots, view hierarchies and console breadcrumbs all capture user
     * content by design. A receipt photograph or a basket has no business in a stack
     * trace, so they are switched off at the source as well as scrubbed on the way out.
     */
    sendDefaultPii: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    attachStacktrace: true,
    enableCaptureFailedRequests: false,

    /**
     * The cast is at the boundary on purpose.
     *
     * `scrubEvent` is generic over a structural shape so it can be tested without
     * importing Sentry's types; Sentry's `ErrorEvent` is nominally stricter. Casting
     * here keeps the scrubber pure and testable, and the returned object is the same
     * event with fields removed — never a different shape.
     */
    beforeSend(event) {
      return scrubEvent(event as unknown as ScrubbableEvent) as unknown as typeof event;
    },

    beforeBreadcrumb(crumb) {
      // Console and tap breadcrumbs are dropped outright rather than scrubbed: console
      // output carries whatever a developer was debugging, and the text of a tap on the
      // plan screen is a price.
      if (crumb.category === 'ui.click' || crumb.category === 'console') return null;
      return scrubBreadcrumb(crumb) as typeof crumb;
    },
  });

  /**
   * Non-identifying context only.
   *
   * There is no `setUser` call anywhere in Juva. The stable RevenueCat id is the only
   * handle on a person and it does not belong here — a crash report tied to an
   * identity turns a debugging tool into a tracking one.
   */
  Sentry.setTag('environment', env.environment);
  Sentry.setTag('marketMode', env.marketMode);

  started = true;
}

/**
 * Records a handled failure.
 *
 * Takes a short stable code rather than a message, because a caller passing
 * `error.message` is how a product name ends up in a crash report. The `extra` payload
 * is scrubbed by `beforeSend` regardless, but keeping the shape narrow means callers
 * are not tempted in the first place.
 */
export function reportHandled(
  code: string,
  extra?: Record<string, string | number | boolean>,
): void {
  if (!started) return;
  Sentry.captureMessage(code, {
    level: 'warning',
    ...(extra === undefined ? {} : { extra }),
  });
}

/** Wraps the root component for navigation and startup performance traces. */
export function wrapRoot<T>(component: T): T {
  return started ? (Sentry.wrap(component as never) as T) : component;
}
