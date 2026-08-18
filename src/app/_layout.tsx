import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, type PropsWithChildren } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { JuvaButton } from '@/components/JuvaButton';
import { JuvaStateScreen } from '@/components/JuvaStateScreen';
import { LoadingScreen } from '@/components/LoadingScreen';
import { startAnalyticsLifecycle } from '@/services/analytics';
import { initMonitoring } from '@/services/monitoring';
import { JuvaProvider, useJuva } from '@/state/JuvaProvider';
import { RevenueCatProvider } from '@/state/RevenueCatProvider';
import { colors } from '@/theme/colors';

export const unstable_settings = {
  initialRouteName: 'index',
};

/**
 * Monitoring starts at module scope, before the first render.
 *
 * A crash during provider setup is exactly the crash worth catching, and an init call
 * inside a component would miss it. No-ops when no DSN is configured.
 */
initMonitoring();

/**
 * Expo Router renders this instead of the tree below whenever a route throws.
 * `retry` remounts the segment, so a transient failure does not require a
 * cold restart of the app.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <StatusBar style="dark" />
      <JuvaStateScreen
        eyebrow="SOMETHING BROKE"
        title="Juva hit an unexpected error."
        copy="Your saved baskets, trips and verified savings are stored on this device and were not affected."
        detail={error.message}
        action={<JuvaButton label="Try again" variant="dark" onPress={() => void retry()} />}
      />
    </SafeAreaProvider>
  );
}

/**
 * Holds navigation back until persisted state is in memory, so screens never
 * render a misleading empty state (no basket, no trip) for state that exists on
 * disk. This is also what makes a cold, offline launch safe.
 */
function HydrationGate({ children }: PropsWithChildren) {
  const { hydrated } = useJuva();
  if (!hydrated) return <LoadingScreen />;
  return <>{children}</>;
}

export default function RootLayout() {
  /**
   * Analytics lifecycle, bound once for the life of the app.
   *
   * Registers the foreground/background hooks, restores anything queued from a previous
   * run, and emits `app_opened`. Everything it does is fire-and-forget, so nothing here
   * can delay the first frame.
   */
  useEffect(() => startAnalyticsLifecycle(), []);

  return (
    // Gesture Handler needs a root view above every gesture detector in the tree.
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <RevenueCatProvider>
          <JuvaProvider>
            <StatusBar style="dark" />
            <HydrationGate>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.paper },
                  animation: 'fade_from_bottom',
                }}
              >
                <Stack.Screen name="index" />
                <Stack.Screen name="onboarding" />
                <Stack.Screen name="basket" />
                <Stack.Screen name="searching" />
                <Stack.Screen name="plan" />
                <Stack.Screen name="shop" />
                <Stack.Screen name="verify" />
                <Stack.Screen name="receipt-result" />
                <Stack.Screen name="history" />
                <Stack.Screen name="profile" />
                <Stack.Screen name="paywall" options={{ presentation: 'modal' }} />
                <Stack.Screen name="settings" />
                <Stack.Screen name="notifications" />
                <Stack.Screen name="subscription" />
                <Stack.Screen name="diagnostics" />
                <Stack.Screen name="+not-found" />
              </Stack>
            </HydrationGate>
          </JuvaProvider>
        </RevenueCatProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
