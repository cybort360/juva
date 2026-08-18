import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { JuvaButton } from '@/components/JuvaButton';
import { JuvaPressable } from '@/components/Pressable';
import { SectionLabel } from '@/components/SectionLabel';
import { Surface } from '@/components/Surface';
import { TopBar } from '@/components/TopBar';
import { track } from '@/services/analytics';
import {
  getPermissionState,
  notificationsSupported,
  receiptReminderScheduled,
  requestPermission,
  cancelReceiptReminder,
  type PermissionState,
} from '@/services/notifications';
import {
  optOutOfPush,
  pushState,
  pushUnavailableReason,
  requestPushPermission,
} from '@/services/pushJourneys';
import { useJuva } from '@/state/JuvaProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';

const REMINDER_DELAYS = [
  { minutes: 60, label: '1 hour' },
  { minutes: 90, label: '90 min' },
  { minutes: 180, label: '3 hours' },
] as const;

/**
 * Notification settings.
 *
 * The honest shape of this screen is the point. Juva has one notification it can
 * actually deliver — a local reminder to verify a finished trip — and this screen
 * says so, rather than listing plausible alerts (price drops, deal alerts) that
 * would need a push server Juva does not have.
 */
export default function NotificationsScreen() {
  const { preferences, updatePreferences } = useJuva();
  const [permission, setPermission] = useState<PermissionState>('undetermined');
  const [reminderSet, setReminderSet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [push, setPush] = useState(pushState());

  /**
   * Reads the live permission and schedule state.
   *
   * Both reads resolve before anything is set, so the screen never shows a
   * half-updated picture of what the system actually permits.
   */
  const refresh = useCallback(async () => {
    const [state, scheduled] = await Promise.all([
      getPermissionState(),
      receiptReminderScheduled(),
    ]);
    setPermission(state);
    setReminderSet(scheduled);
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([getPermissionState(), receiptReminderScheduled()]).then(
      ([state, scheduled]) => {
        if (!active) return;
        setPermission(state);
        setReminderSet(scheduled);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const supported = notificationsSupported();
  const enabled = preferences.receiptRemindersEnabled;

  /**
   * Turning the reminder on is the only place Juva asks for permission — never on
   * a cold start, because a reflexive denial is permanent as far as the app is
   * concerned.
   */
  const toggleReminders = async (): Promise<void> => {
    if (enabled) {
      updatePreferences({ receiptRemindersEnabled: false });
      await cancelReceiptReminder();
      await refresh();
      return;
    }
    setBusy(true);
    const result = await requestPermission();
    setPermission(result);
    setBusy(false);
    if (result === 'granted') updatePreferences({ receiptRemindersEnabled: true });
  };

  return (
    <AppScreen>
      <TopBar back title="Notifications" eyebrow="JUVA SPACE" />

      <SectionLabel>Verify reminders</SectionLabel>
      <Surface>
        <View style={styles.toggleRow}>
          <View style={styles.toggleText}>
            <Text style={styles.toggleTitle} allowFontScaling>
              Remind me to verify a trip
            </Text>
            <Text style={styles.toggleCopy} allowFontScaling>
              After you finish shopping, Juva reminds you once to add the receipt. That is what
              turns an estimated saving into a verified one.
            </Text>
          </View>
        </View>

        <JuvaPressable
          onPress={() => void toggleReminders()}
          feedback="select"
          disabled={!supported || busy}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: enabled, disabled: !supported, busy }}
          accessibilityLabel="Remind me to verify a trip"
          accessibilityHint={
            enabled
              ? 'Turns the reminder off'
              : 'Asks for notification permission, then turns it on'
          }
          style={[styles.switch, enabled && styles.switchOn]}
        >
          <Text style={[styles.switchText, enabled && styles.switchTextOn]}>
            {busy ? 'ASKING…' : enabled ? 'ON' : 'OFF'}
          </Text>
        </JuvaPressable>

        {enabled ? (
          <>
            <Text style={styles.label}>REMIND ME AFTER</Text>
            <View style={styles.segments} accessibilityRole="radiogroup">
              {REMINDER_DELAYS.map((option) => {
                const active = preferences.receiptReminderMinutes === option.minutes;
                return (
                  <JuvaPressable
                    key={option.minutes}
                    onPress={() => updatePreferences({ receiptReminderMinutes: option.minutes })}
                    feedback="select"
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`Remind me after ${option.label}`}
                    style={[styles.segment, active && styles.segmentActive]}
                  >
                    <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                      {option.label}
                    </Text>
                  </JuvaPressable>
                );
              })}
            </View>
            {/* States what is actually scheduled, rather than implying activity. */}
            <Text style={styles.status} allowFontScaling>
              {reminderSet
                ? 'A reminder is scheduled for your current trip.'
                : 'Nothing scheduled right now. A reminder is set when you finish a trip.'}
            </Text>
          </>
        ) : null}

        {!supported ? (
          <Text style={styles.notice} allowFontScaling>
            Notifications need the Juva app on iOS or Android. They are unavailable in the browser,
            so this setting is switched off here.
          </Text>
        ) : null}

        {supported && permission === 'denied' ? (
          <>
            <Text style={styles.notice} allowFontScaling>
              Notifications are turned off for Juva in system settings. The app cannot re-ask, so
              this has to be changed there.
            </Text>
            <JuvaButton
              label="Open system settings"
              variant="ghost"
              onPress={() => void Linking.openSettings()}
              accessibilityHint="Opens the device settings for Juva"
            />
          </>
        ) : null}
      </Surface>

      {/*
        The opt-in for lifecycle messages.
        Separate from the local reminder above because they are different promises: one is
        a timer on this device, the other is a message from a server. A shopper should be
        able to want one and refuse the other.
      */}
      <SectionLabel>Lifecycle messages</SectionLabel>
      <Surface>
        <Text style={styles.toggleTitle} allowFontScaling>
          Tell me when something changes
        </Text>
        <Text style={styles.toggleCopy} allowFontScaling>
          At most two messages a week, never between 9pm and 9am, and only when a saved basket gets
          at least $3 cheaper, a plan is left unshopped, or a finished trip still needs its receipt.
          Never a streak, never a reminder to open the app.
        </Text>

        {push.supported ? (
          <>
            <JuvaPressable
              onPress={() => {
                void (async () => {
                  setBusy(true);
                  if (push.optedIn) optOutOfPush();
                  else {
                    const granted = await requestPushPermission();
                    // Recorded on the real outcome, not on the tap: a denied prompt is
                    // not an opt-in.
                    if (granted) track('notification_opt_in');
                  }
                  setPush(pushState());
                  setBusy(false);
                })();
              }}
              feedback="select"
              disabled={busy}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: push.optedIn, busy }}
              accessibilityLabel="Tell me when something changes"
              style={[styles.switch, push.optedIn && styles.switchOn]}
            >
              <Text style={[styles.switchText, push.optedIn && styles.switchTextOn]}>
                {busy ? 'ASKING…' : push.optedIn ? 'ON' : 'OFF'}
              </Text>
            </JuvaPressable>
            <Text style={styles.status} allowFontScaling>
              {push.optedIn
                ? 'Juva may send lifecycle messages, within the limits above.'
                : 'Nothing will be sent until you turn this on.'}
            </Text>
          </>
        ) : (
          /* Stated rather than shown as a dead switch: a control that cannot work is worse
             than no control. */
          <Text style={styles.notice} allowFontScaling>
            {pushUnavailableReason() ?? 'Lifecycle messages are unavailable in this build.'}
          </Text>
        )}
      </Surface>

      <SectionLabel>What Juva will not send</SectionLabel>
      <Surface>
        <Text style={styles.honestTitle} allowFontScaling>
          No deal alerts, and no price watching while Juva is closed.
        </Text>
        <Text style={styles.honestCopy} allowFontScaling>
          The messages above are noticed when you open Juva and it re-prices your baskets — not by a
          server monitoring shops on your behalf. Juva has no such server, so it will never tell you
          a price moved while the app was closed, and it will never send a deal or a promotion
          someone paid to put in front of you.
        </Text>
        <Text style={styles.honestCopy} allowFontScaling>
          The verify reminder is scheduled on this device only. Nothing about your basket, your
          location or your prices leaves the phone to make it work.
        </Text>
      </Surface>

      <JuvaButton
        label="Back to Juva Space"
        variant="ghost"
        onPress={() => router.replace('/profile')}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  toggleRow: { flexDirection: 'row', gap: spacing.md },
  toggleText: { flex: 1 },
  toggleTitle: { ...type.h2, color: colors.ink },
  toggleCopy: { ...type.bodySmall, color: colors.muted, marginTop: 4 },
  switch: {
    alignSelf: 'flex-start',
    minWidth: 84,
    borderRadius: 14,
    backgroundColor: colors.paperStrong,
    paddingHorizontal: spacing.md,
    paddingVertical: 11,
    alignItems: 'center',
  },
  switchOn: { backgroundColor: colors.ink },
  switchText: { ...type.label, fontSize: 9, color: colors.inkSoft },
  switchTextOn: { color: colors.signal },
  label: { ...type.label, color: colors.muted, marginTop: spacing.xs },
  segments: { flexDirection: 'row', gap: spacing.xs },
  segment: {
    flex: 1,
    minHeight: 48,
    borderRadius: 16,
    backgroundColor: colors.paperStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: { backgroundColor: colors.ink },
  segmentText: { ...type.bodySmall, color: colors.muted, fontWeight: '900' },
  segmentTextActive: { color: colors.white },
  status: { ...type.bodySmall, fontSize: 11, color: colors.signalDeep, fontWeight: '800' },
  notice: { ...type.bodySmall, fontSize: 12, lineHeight: 18, color: colors.amber },
  honestTitle: { ...type.h2, color: colors.ink },
  honestCopy: { ...type.bodySmall, color: colors.muted, lineHeight: 20 },
});
