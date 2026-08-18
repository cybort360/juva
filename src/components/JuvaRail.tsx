import { router, usePathname } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { JuvaPressable } from '@/components/Pressable';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';

/**
 * Juva's own navigation surface. Routes are literal so `typedRoutes` checks them
 * at build time; there is no cast to silence the router's types.
 */
const destinations = [
  { label: 'PLAN', path: '/' },
  { label: 'SHOP', path: '/shop' },
  { label: 'VERIFY', path: '/verify' },
] as const;

export function JuvaRail({ status }: { status?: string }) {
  const pathname = usePathname();
  return (
    <View style={styles.wrap}>
      <View style={styles.rail}>
        {status ? (
          <Text numberOfLines={1} style={styles.status}>
            {status}
          </Text>
        ) : (
          destinations.map((item) => {
            const active = item.path === '/' ? pathname === '/' : pathname.startsWith(item.path);
            return (
              <JuvaPressable
                key={item.path}
                onPress={() => router.push(item.path)}
                accessibilityRole="link"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: active }}
                style={[styles.nav, active && styles.navActive]}
              >
                <Text
                  style={[styles.navText, active && styles.navTextActive]}
                  allowFontScaling
                  numberOfLines={1}
                >
                  {item.label}
                </Text>
              </JuvaPressable>
            );
          })
        )}
        <JuvaPressable
          onPress={() => router.push('/profile')}
          accessibilityRole="link"
          accessibilityLabel="Juva Space"
          accessibilityHint="Preferences, loyalty, subscription and privacy"
          style={styles.orb}
        >
          <View style={styles.orbInner} />
        </JuvaPressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.sm, paddingTop: spacing.xs },
  rail: {
    minHeight: 62,
    borderRadius: 25,
    backgroundColor: colors.ink,
    padding: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    shadowColor: colors.black,
    shadowOpacity: 0.14,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  nav: { flex: 1, height: 46, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  navActive: { backgroundColor: colors.paper },
  navText: { ...type.label, color: 'rgba(255,255,255,0.56)', letterSpacing: 0.9 },
  navTextActive: { color: colors.ink },
  status: {
    flex: 1,
    color: colors.white,
    paddingHorizontal: spacing.md,
    ...type.bodySmall,
    fontWeight: '800',
  },
  orb: {
    width: 46,
    height: 46,
    borderRadius: 19,
    backgroundColor: colors.signal,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
  },
  orbInner: { width: 16, height: 16, borderRadius: 8, backgroundColor: colors.ink },
});
