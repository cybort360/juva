import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { JuvaButton } from '@/components/JuvaButton';
import { SectionLabel } from '@/components/SectionLabel';
import { Surface } from '@/components/Surface';
import { TopBar } from '@/components/TopBar';
import { env } from '@/config/runtimeEnv';
import {
  FREE_HISTORY_LIMIT,
  FREE_ITEM_LIMIT,
  FREE_OPTIMIZATIONS_PER_DAY,
  FREE_SAVED_LIST_LIMIT,
} from '@/domain/entitlements';
import {
  DEFAULT_QUIET_HOURS,
  MAX_PER_WEEK,
  MEANINGFUL_SAVING_CENTS,
  MIN_GAP_HOURS,
  decideJourney,
  isQuietHour,
  journeyBody,
  type JourneyKind,
} from '@/domain/journeys';
import { monitoringState, reportHandled } from '@/services/monitoring';
import { pushState } from '@/services/pushJourneys';
import { useRevenueCat } from '@/state/RevenueCatProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';

const JOURNEYS: JourneyKind[] = [
  'basket_cheaper',
  'trip_not_started',
  'receipt_not_verified',
  'basket_under_budget',
];

/**
 * Diagnostics, for development and preview builds only.
 *
 * The purpose is to make the invisible systems inspectable: what monitoring thinks it
 * is doing, whether push is actually wired, and — most usefully — *why* a lifecycle
 * message would or would not be sent right now. A notification system that fails
 * silently is impossible to trust, and "it didn't send" is not a debuggable statement.
 *
 * Deliberately reports only what it can observe locally. It cannot and does not claim
 * a purchase completed or a campaign was delivered; those are facts only the
 * RevenueCat and OneSignal dashboards hold.
 */
export default function DiagnosticsScreen() {
  const { status, subscription, entitlementIsCached, customerCenterAvailable, packages, error } =
    useRevenueCat();
  const [note, setNote] = useState<string>();

  const monitoring = monitoringState();
  const push = pushState();
  const now = new Date();

  /** Production builds have no business exposing this. */
  if (env.environment === 'production') {
    return (
      <AppScreen>
        <TopBar back title="Diagnostics" eyebrow="DEVELOPMENT" />
        <Surface>
          <Text style={styles.title}>Not available in a production build.</Text>
          <JuvaButton label="Back" variant="ghost" onPress={() => router.back()} />
        </Surface>
      </AppScreen>
    );
  }

  const rows = (entries: [string, string][]) =>
    entries.map(([label, value]) => (
      <View key={label} style={styles.row}>
        <Text style={styles.rowKey}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
    ));

  return (
    <AppScreen>
      <TopBar back title="Diagnostics" eyebrow={`${env.environment.toUpperCase()} BUILD`} />

      <SectionLabel>Purchases</SectionLabel>
      <Surface>
        {rows([
          ['SDK status', status],
          ['Key', env.revenueCatApiKey === undefined ? 'not configured' : 'configured'],
          ['Store', env.revenueCatUsesTestStore ? 'Test Store' : 'platform store'],
          ['Subscription state', subscription],
          ['Source', entitlementIsCached ? 'cached (offline)' : 'live'],
          ['Packages', String(packages.length)],
          ['Customer Center', customerCenterAvailable ? 'available' : 'unavailable'],
        ])}
        {error ? <Text style={styles.warn}>{error}</Text> : null}
        <Text style={styles.note}>
          Whether a purchase actually succeeded is only knowable from the RevenueCat dashboard. This
          screen reports what the SDK told the app, nothing more.
        </Text>
      </Surface>

      <SectionLabel>Monitoring</SectionLabel>
      <Surface>
        {rows([
          ['DSN', monitoring.configured ? 'configured' : 'not configured'],
          ['Started', monitoring.started ? 'yes' : 'no'],
          ['Environment', monitoring.environment],
          ['Trace sample rate', String(monitoring.tracesSampleRate)],
        ])}
        <JuvaButton
          label="Send a test diagnostic"
          variant="ghost"
          disabled={!monitoring.started}
          onPress={() => {
            reportHandled('diagnostics.test_event', { screen: 'diagnostics' });
            setNote('Sent. Confirm it arrived in the Sentry dashboard — the app cannot know.');
          }}
        />
      </Surface>

      <SectionLabel>Push</SectionLabel>
      <Surface>
        {rows([
          ['App ID', push.configured ? 'configured' : 'not configured'],
          ['Supported here', push.supported ? 'yes' : 'no'],
          ['Started', push.started ? 'yes' : 'no'],
          ['Opted in', push.optedIn ? 'yes' : 'no'],
          ['Quiet hours', `${DEFAULT_QUIET_HOURS.startHour}:00–${DEFAULT_QUIET_HOURS.endHour}:00`],
          ['Now quiet', isQuietHour(now.getHours()) ? 'yes' : 'no'],
          ['Weekly cap', String(MAX_PER_WEEK)],
          ['Minimum gap', `${MIN_GAP_HOURS}h`],
          ['Worth-sending floor', `${MEANINGFUL_SAVING_CENTS}c`],
        ])}
        {push.reason ? <Text style={styles.reason}>{push.reason}</Text> : null}
        {/*
          Stated plainly because it is the most misread part of this integration: the
          journey rules below are live and testable here, but nothing can be delivered
          from this binary.
        */}
        <Text style={styles.note}>
          Delivery is only observable in the OneSignal dashboard. This screen reports the local
          decision, never that a message was sent.
        </Text>
      </Surface>

      {/*
        The useful part: the same pure decision function the app uses, run against an
        empty history, so a developer can see which journeys are currently sendable and
        read the exact reason for each that is not.
      */}
      <SectionLabel>Journey decisions, right now</SectionLabel>
      <Surface>
        {JOURNEYS.map((kind) => {
          const decision = decideJourney(
            { kind, subjectId: 'diagnostics', savingsCents: 500 },
            [],
            now,
          );
          return (
            <View key={kind} style={styles.journey}>
              <View style={styles.row}>
                <Text style={styles.rowKey}>{kind}</Text>
                <Text style={[styles.rowValue, decision.send ? styles.ok : styles.blocked]}>
                  {decision.send ? 'would send' : 'blocked'}
                </Text>
              </View>
              <Text style={styles.reason}>{decision.reason}</Text>
              <Text style={styles.body}>“{journeyBody(kind, '$5.00')}”</Text>
            </View>
          );
        })}
      </Surface>

      <SectionLabel>Free tier limits</SectionLabel>
      <Surface>
        {rows([
          ['Items per basket', String(FREE_ITEM_LIMIT)],
          ['Saved baskets', String(FREE_SAVED_LIST_LIMIT)],
          ['Searches per day', String(FREE_OPTIMIZATIONS_PER_DAY)],
          ['History shown', String(FREE_HISTORY_LIMIT)],
        ])}
      </Surface>

      {env.issues.length > 0 ? (
        <>
          <SectionLabel>Configuration issues</SectionLabel>
          <Surface>
            {env.issues.map((issue) => (
              <Text
                key={`${issue.key}-${issue.message}`}
                style={issue.severity === 'error' ? styles.warn : styles.reason}
              >
                {issue.key}: {issue.message}
              </Text>
            ))}
          </Surface>
        </>
      ) : null}

      {note ? (
        <Surface signal>
          <Text style={styles.noteStrong} accessibilityLiveRegion="polite">
            {note}
          </Text>
        </Surface>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  title: { ...type.h2, color: colors.ink },
  row: { flexDirection: 'row', justifyContent: 'space-between', minHeight: 28, gap: spacing.sm },
  rowKey: { ...type.bodySmall, color: colors.muted, flex: 1 },
  rowValue: { ...type.bodySmall, color: colors.ink, fontWeight: '900' },
  ok: { color: colors.signalDeep },
  blocked: { color: colors.amber },
  journey: { gap: 2, paddingVertical: 6 },
  reason: { ...type.bodySmall, fontSize: 12, color: colors.muted },
  body: { ...type.bodySmall, fontSize: 12, color: colors.inkSoft, fontStyle: 'italic' },
  warn: { ...type.bodySmall, color: colors.red, fontWeight: '800' },
  note: { ...type.bodySmall, fontSize: 12, color: colors.muted, lineHeight: 18 },
  noteStrong: { ...type.bodySmall, color: colors.ink, fontWeight: '800' },
});
