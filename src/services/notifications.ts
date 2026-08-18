import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * Juva's notifications.
 *
 * Scope, stated plainly: these are **local** notifications scheduled on the
 * device. Juva has no push server, no APNs or FCM credentials and no background
 * job, so it cannot tell you a price dropped while the app was closed — doing
 * that needs infrastructure this project does not have. Offering a "price alerts"
 * toggle that silently never fires would be worse than not offering one.
 *
 * What is real: a reminder to verify a finished trip. Juva knows a trip completed
 * and that no receipt has been recorded, both purely from local state, so that
 * reminder is genuinely deliverable.
 */

/** Identifier so a pending reminder can be replaced or cancelled. */
const RECEIPT_REMINDER_ID = 'juva.receipt-reminder';

export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'unsupported';

/**
 * Local notifications need a native module. Web support is partial and varies by
 * browser, so Juva reports it unsupported there rather than half-working.
 */
export function notificationsSupported(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

export async function getPermissionState(): Promise<PermissionState> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    return 'undetermined';
  } catch {
    return 'unsupported';
  }
}

/**
 * Asks for permission.
 *
 * Only ever called from an explicit shopper action. A cold-start permission
 * prompt is the fastest way to get permanently denied, and a denied shopper
 * cannot be re-prompted by the app at all.
 */
export async function requestPermission(): Promise<PermissionState> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.status === 'granted') return 'granted';
    // A denied shopper must go to system settings; asking again does nothing.
    if (!existing.canAskAgain) return 'denied';
    const { status } = await Notifications.requestPermissionsAsync();
    return status === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

export interface ReceiptReminderInput {
  /** Store the shopper just finished, for a reminder that names it. */
  readonly storeName: string;
  /** Delay before the reminder fires. */
  readonly afterMinutes: number;
}

/**
 * Schedules the one reminder Juva can honestly deliver.
 *
 * Replaces any pending reminder rather than stacking them, so finishing three
 * trips does not produce three alerts. Returns false when it could not be
 * scheduled, which callers surface instead of assuming success.
 */
export async function scheduleReceiptReminder(input: ReceiptReminderInput): Promise<boolean> {
  if (!notificationsSupported()) return false;
  try {
    if ((await getPermissionState()) !== 'granted') return false;
    await cancelReceiptReminder();
    await Notifications.scheduleNotificationAsync({
      identifier: RECEIPT_REMINDER_ID,
      content: {
        title: 'Verify your savings',
        body: `Add your ${input.storeName} receipt to turn this trip's estimate into verified savings.`,
        // No figures in the body: a notification must not quote a saving that
        // has not been verified yet.
        sound: false,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: Math.max(60, Math.round(input.afterMinutes * 60)),
        repeats: false,
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function cancelReceiptReminder(): Promise<void> {
  if (!notificationsSupported()) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(RECEIPT_REMINDER_ID);
  } catch {
    // Nothing pending, or the module is unavailable. Either way there is nothing
    // to clean up and nothing worth interrupting the shopper about.
  }
}

/** Reminders currently pending, so the UI can state what is actually scheduled. */
/**
 * Whether Juva's own receipt reminder is currently scheduled.
 *
 * Filtered by identifier on purpose. `getAllScheduledNotificationsAsync` returns
 * every notification scheduled in the process — in Expo Go that means every other
 * project the shopper has opened — so counting the raw list reported strangers'
 * reminders as Juva's. Because the reminder uses one fixed identifier, there is
 * only ever nothing or a single reminder, and this answers exactly that.
 */
export async function receiptReminderScheduled(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    return scheduled.some((request) => request.identifier === RECEIPT_REMINDER_ID);
  } catch {
    return false;
  }
}
