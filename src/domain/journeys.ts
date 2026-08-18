import type { RecommendationSnapshot } from './types';

/**
 * Which lifecycle message, if any, is worth sending.
 *
 * Every decision here is pure: given what Juva knows and what it has already sent,
 * decide whether to send now. Keeping it out of the notification SDK means the rules
 * that actually protect the shopper — caps, quiet hours, one message per subject —
 * are testable rather than trusted to dashboard configuration.
 *
 * The bar for a journey is that it carries information the shopper can act on and
 * would want. A streak, a "we miss you", or a nudge to open the app are not that, so
 * there is no code path capable of producing one: `JourneyKind` is the whole
 * vocabulary, and each member names a real change in the shopper's own data.
 */

export type JourneyKind =
  /** A saved recurring basket now costs meaningfully less than when it was saved. */
  | 'basket_cheaper'
  /** A plan was made and never shopped. */
  | 'trip_not_started'
  /** A trip finished but its receipt was never added, so savings stay estimated. */
  | 'receipt_not_verified'
  /** A basket that was over budget now fits inside it. */
  | 'basket_under_budget'
  /**
   * Prices moved enough that Juva would now shop this basket somewhere else.
   *
   * The strictest journey, because it is the easiest to make noisy: a ranking that
   * flips between two near-identical plans is not news, and a shopper who is told to
   * change stores for 3c will not believe the next message either.
   */
  | 'plan_changed';

export interface QuietHours {
  /** Local hour when quiet time starts, 0–23. */
  startHour: number;
  /** Local hour when quiet time ends, 0–23. May be lower than start, i.e. overnight. */
  endHour: number;
}

/**
 * Quiet hours, in the shopper's local time.
 *
 * Grocery messages are never urgent. Nothing Juva has to say is worth a phone
 * lighting up at 3am, so the window is generous rather than minimal.
 */
export const DEFAULT_QUIET_HOURS: QuietHours = { startHour: 21, endHour: 9 };

/** At most this many lifecycle messages in a rolling week, across all journeys. */
export const MAX_PER_WEEK = 2;

/** And never two in the same day, however many things changed. */
export const MIN_GAP_HOURS = 20;

/**
 * A saving must clear this to be worth a notification.
 *
 * Below it, the message costs more attention than the money is worth — and a basket
 * drifting by a few cents would otherwise generate a message every week.
 */
export const MEANINGFUL_SAVING_CENTS = 300;

/**
 * How much better the new recommendation must be before it is worth telling anyone.
 *
 * Higher than `MEANINGFUL_SAVING_CENTS` on purpose. "Your basket is $3 cheaper" asks the
 * shopper to do nothing; "shop somewhere else today" asks them to change their plans, and
 * that has to be worth more than a rounding difference between two similar stores.
 */
export const MEANINGFUL_PLAN_CHANGE_CENTS = 500;

/** Minimum confidence in the new plan before Juva will recommend acting on it. */
export const MIN_PLAN_CHANGE_CONFIDENCE = 0.7;

/** How stale a market may be and still be described as "today". */
export const MAX_PLAN_CHANGE_AGE_HOURS = 24;

/**
 * Everything needed to decide whether a recommendation genuinely changed.
 *
 * All of it comes from two deterministic optimizer runs over the same basket. Nothing is
 * inferred, and a missing field is a reason to stay silent rather than to guess.
 */
export interface PlanChangeEvidence {
  listId: string;
  /** Store ids of the previously recommended plan. */
  previousStoreIds: readonly string[];
  previousCostCents: number;
  /** Store ids of the plan Juva would recommend now. */
  currentStoreIds: readonly string[];
  currentCostCents: number;
  /** Both plans must price the whole basket. */
  bothComplete: boolean;
  /** The new plan's own confidence, 0..1. */
  currentConfidence: number;
  /** When the market behind the new plan was observed. */
  observedAt: string;
}

/**
 * Whether a recommendation change is worth a notification.
 *
 * Six gates, and every one of them is a way this journey could become noise. The
 * ordering is deliberate: the cheapest checks that most often fail come first, so the
 * reason returned is the most useful one rather than merely the first that applied.
 */
export function planChangeQualifies(
  evidence: PlanChangeEvidence,
  now: Date,
): { qualifies: boolean; reason: string; savingsCents: number } {
  const savingsCents = evidence.previousCostCents - evidence.currentCostCents;
  const no = (reason: string) => ({ qualifies: false, reason, savingsCents });

  // A partial basket cannot be compared at all, let alone across two days.
  if (!evidence.bothComplete) {
    return no('One of the baskets was incomplete, so the two are not comparable.');
  }

  // The recommendation must actually be different. A reordering of equal-scoring plans
  // is not a change the shopper would notice or benefit from.
  const previous = [...evidence.previousStoreIds].sort().join(',');
  const current = [...evidence.currentStoreIds].sort().join(',');
  if (previous === current) return no('The same stores are still the right answer.');

  if (savingsCents < MEANINGFUL_PLAN_CHANGE_CENTS) {
    return no(
      `Only ${savingsCents}c better, below the ${MEANINGFUL_PLAN_CHANGE_CENTS}c threshold for asking someone to shop elsewhere.`,
    );
  }

  if (evidence.currentConfidence < MIN_PLAN_CHANGE_CONFIDENCE) {
    return no('Juva is not confident enough in the new plan to recommend acting on it.');
  }

  const observed = Date.parse(evidence.observedAt);
  if (Number.isNaN(observed)) return no('The market behind the new plan has no usable timestamp.');
  const ageHours = (now.getTime() - observed) / (60 * 60 * 1000);
  if (ageHours > MAX_PLAN_CHANGE_AGE_HOURS) {
    return no(`The market is ${Math.floor(ageHours)}h old, too stale to call it "today".`);
  }
  if (ageHours < 0) return no('The market timestamp is in the future, so it cannot be trusted.');

  return {
    qualifies: true,
    reason: `A different set of stores is ${savingsCents}c cheaper on the same basket.`,
    savingsCents,
  };
}

export interface SentMessage {
  kind: JourneyKind;
  /** Epoch milliseconds. */
  sentAt: number;
  /** What the message was about — a list id, a trip id. One message per subject. */
  subjectId: string;
}

export interface JourneyCandidate {
  kind: JourneyKind;
  subjectId: string;
  /** Integer cents. Only used by the money-based journeys. */
  savingsCents?: number | undefined;
}

export interface JourneyDecision {
  send: boolean;
  /** Why, in words. Surfaced in the diagnostics screen rather than guessed at. */
  reason: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Whether a local hour falls inside the quiet window, handling the overnight wrap. */
export function isQuietHour(hour: number, quiet: QuietHours = DEFAULT_QUIET_HOURS): boolean {
  if (quiet.startHour === quiet.endHour) return false;
  if (quiet.startHour < quiet.endHour) {
    return hour >= quiet.startHour && hour < quiet.endHour;
  }
  // Overnight: 21:00–09:00 is quiet at 22, at 3, and at 8.
  return hour >= quiet.startHour || hour < quiet.endHour;
}

/**
 * Decides whether a candidate message may be sent.
 *
 * Checks are ordered cheapest and most absolute first, so the returned reason names
 * the strongest objection rather than an incidental one.
 */
export function decideJourney(
  candidate: JourneyCandidate,
  history: readonly SentMessage[],
  now: Date,
  quiet: QuietHours = DEFAULT_QUIET_HOURS,
): JourneyDecision {
  // 1. A money-based journey needs money behind it, and it must be worth the ping.
  if (candidate.kind === 'basket_cheaper' || candidate.kind === 'basket_under_budget') {
    const savings = candidate.savingsCents ?? 0;
    if (savings <= 0) {
      return { send: false, reason: 'Nothing actually got cheaper.' };
    }
    if (savings < MEANINGFUL_SAVING_CENTS) {
      return {
        send: false,
        reason: `Only ${savings}c cheaper, below the ${MEANINGFUL_SAVING_CENTS}c worth-mentioning threshold.`,
      };
    }
  }

  const nowMs = now.getTime();

  // 2. One message per subject, ever. A basket that keeps fluctuating is not four
  //    separate pieces of news.
  if (
    history.some((sent) => sent.kind === candidate.kind && sent.subjectId === candidate.subjectId)
  ) {
    return { send: false, reason: 'Already sent about this.' };
  }

  // 3. Rolling weekly cap across every journey.
  const recentWeek = history.filter((sent) => nowMs - sent.sentAt < WEEK_MS);
  if (recentWeek.length >= MAX_PER_WEEK) {
    return { send: false, reason: `Already sent ${recentWeek.length} messages this week.` };
  }

  // 4. Never two close together.
  const lastSentAt = history.reduce((latest, sent) => Math.max(latest, sent.sentAt), 0);
  if (lastSentAt > 0 && nowMs - lastSentAt < MIN_GAP_HOURS * HOUR_MS) {
    return { send: false, reason: 'Sent one too recently.' };
  }

  // 5. Quiet hours last: it is the only reason that will stop being true on its own,
  //    so a caller can retry later rather than dropping the message.
  if (isQuietHour(now.getHours(), quiet)) {
    return { send: false, reason: 'Inside quiet hours.' };
  }

  return { send: true, reason: 'Worth sending.' };
}

/**
 * The message body for a journey.
 *
 * Money is passed in already computed, as integer cents, and formatted by the caller.
 * Nothing here derives a figure, and no body contains a product name, a store name or
 * a location — a lock screen is the least private surface Juva touches.
 */
export function journeyBody(kind: JourneyKind, formattedAmount?: string): string {
  switch (kind) {
    case 'basket_cheaper':
      return formattedAmount === undefined
        ? 'One of your saved baskets got cheaper. Re-run it to see the new plan.'
        : `A saved basket is ${formattedAmount} cheaper than when you saved it.`;
    case 'trip_not_started':
      return 'Your plan is still waiting. Prices move, so Juva will re-check them when you open it.';
    case 'receipt_not_verified':
      return 'Add your receipt to turn this trip’s estimated saving into a verified one.';
    case 'basket_under_budget':
      return formattedAmount === undefined
        ? 'A basket that was over budget now fits.'
        : `A basket that was over budget now fits, with ${formattedAmount} to spare.`;
    case 'plan_changed':
      // Never names the stores or the basket: the notification says a better plan exists,
      // and the plan itself lives behind the app.
      return formattedAmount === undefined
        ? 'Prices changed enough that Juva would shop this basket differently today.'
        : `Prices changed enough that Juva would shop this basket differently today — about ${formattedAmount} better.`;
  }
}

/** Drops history older than the cap window, so stored state cannot grow forever. */
export function pruneHistory(history: readonly SentMessage[], now: Date): SentMessage[] {
  const cutoff = now.getTime() - WEEK_MS * 8;
  return history.filter((sent) => sent.sentAt >= cutoff);
}

/**
 * What the app knows that a journey might be about.
 *
 * Kept as a flat, primitive-only shape so candidate selection can be tested without
 * constructing a whole `JuvaState`. The provider fills it in from real state.
 */
export interface JourneySources {
  /** A plan exists, is selected, and no trip was ever started from it. */
  pendingPlanId?: string | undefined;
  /** A trip finished but its savings record is not receipt-confirmed. */
  unverifiedTripId?: string | undefined;
  /** A saved basket that re-priced cheaper, and by how much. */
  cheaperListId?: string | undefined;
  cheaperByCents?: number | undefined;
  /** A saved basket that was over budget and now fits, and the headroom. */
  underBudgetListId?: string | undefined;
  underBudgetByCents?: number | undefined;
}

/**
 * Turns what the app knows into candidate messages.
 *
 * Deliberately dumb: it proposes, `decideJourney` disposes. Separating the two means the
 * caps cannot be bypassed by a caller that builds a candidate directly, and it makes the
 * question "what could Juva say right now?" answerable in a test.
 *
 * Order matters — it is the order they will be offered, so the most actionable comes
 * first. A shopper who has both an unverified trip and a cheaper basket should hear about
 * the money they already spent before the money they might save.
 */
export function journeyCandidates(sources: JourneySources): JourneyCandidate[] {
  const candidates: JourneyCandidate[] = [];

  if (sources.unverifiedTripId !== undefined) {
    candidates.push({ kind: 'receipt_not_verified', subjectId: sources.unverifiedTripId });
  }
  if (sources.cheaperListId !== undefined) {
    candidates.push({
      kind: 'basket_cheaper',
      subjectId: sources.cheaperListId,
      ...(sources.cheaperByCents === undefined ? {} : { savingsCents: sources.cheaperByCents }),
    });
  }
  if (sources.underBudgetListId !== undefined) {
    candidates.push({
      kind: 'basket_under_budget',
      subjectId: sources.underBudgetListId,
      ...(sources.underBudgetByCents === undefined
        ? {}
        : { savingsCents: sources.underBudgetByCents }),
    });
  }
  if (sources.pendingPlanId !== undefined) {
    candidates.push({ kind: 'trip_not_started', subjectId: sources.pendingPlanId });
  }

  return candidates;
}

/**
 * Turns two recommendation snapshots into a Journey D decision.
 *
 * The ordering is load-bearing: the comparison happens against the *stored* snapshot, and
 * only then is the snapshot replaced. Updating first would compare a plan against itself
 * and no change would ever be detected.
 */
export function evaluatePlanChange(input: {
  previous: RecommendationSnapshot | undefined;
  current: RecommendationSnapshot;
  history: readonly SentMessage[];
  notificationsEnabled: boolean;
  now: Date;
  quietHours?: QuietHours;
}): { decision: JourneyDecision; nextSnapshot: RecommendationSnapshot } {
  const { previous, current, now } = input;

  // The snapshot is always stored, whether or not anything is sent. A first run has
  // nothing to compare against and must not notify.
  if (!previous) {
    return {
      decision: {
        send: false,
        reason: 'First recommendation for this basket; nothing to compare.',
      },
      nextSnapshot: current,
    };
  }

  // Scoring changed underneath us. Two plans from different optimizer generations are not
  // comparable, and treating them as such would notify on a Juva release rather than a
  // price change.
  if (previous.optimizerVersion !== current.optimizerVersion) {
    return {
      decision: {
        send: false,
        reason: 'The optimizer changed since the last plan; not comparable.',
      },
      nextSnapshot: current,
    };
  }

  if (!input.notificationsEnabled) {
    return {
      decision: { send: false, reason: 'Lifecycle messages are switched off.' },
      nextSnapshot: current,
    };
  }

  const qualification = planChangeQualifies(
    {
      listId: current.basketId,
      previousStoreIds: previous.primaryStoreIds,
      previousCostCents: previous.estimatedCostCents,
      currentStoreIds: current.primaryStoreIds,
      currentCostCents: current.estimatedCostCents,
      bothComplete:
        previous.marketCompleteness === 'complete' && current.marketCompleteness === 'complete',
      currentConfidence: current.confidence,
      observedAt: current.observedAt,
    },
    now,
  );

  if (!qualification.qualifies) {
    return { decision: { send: false, reason: qualification.reason }, nextSnapshot: current };
  }

  // Qualified on the economics. The shared cap, gap and quiet-hour rules still apply.
  const decision = decideJourney(
    { kind: 'plan_changed', subjectId: current.basketId, savingsCents: qualification.savingsCents },
    input.history,
    now,
    input.quietHours ?? DEFAULT_QUIET_HOURS,
  );
  return { decision, nextSnapshot: current };
}
