/**
 * AdminHomeScreen — landing page for admin role users in the native app.
 *
 * The native app is built for Members and CHWs. Admin actions live in the
 * separate web admin dashboard (web-legacy/, gated by ADMIN_KEY). When an
 * admin signs in via the mobile/web app, they previously fell through to
 * the Member tabs and 403'd on every backend fetch. This screen gives
 * admins a clean landing point with sign-out and a link out to the real
 * admin dashboard.
 */

import React, { useCallback } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ExternalLink, LogOut, ShieldCheck } from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import { colors } from '../../theme/colors';

/**
 * URL for the legacy web admin dashboard. Override at build time via
 * EXPO_PUBLIC_ADMIN_DASHBOARD_URL — defaults to a relative `/admin` path
 * which is fine for the web bundle when both are co-deployed, and a
 * harmless no-op on native (where Linking.openURL on a relative path
 * silently fails — we surface a friendly Alert in that case).
 */
const ADMIN_DASHBOARD_URL = process.env.EXPO_PUBLIC_ADMIN_DASHBOARD_URL ?? '/admin';

export function AdminHomeScreen(): React.JSX.Element {
  const { userName, logout } = useAuth();

  const firstName = (userName ?? 'Admin').split(' ')[0];

  const handleOpenDashboard = useCallback(async () => {
    try {
      const supported = await Linking.canOpenURL(ADMIN_DASHBOARD_URL);
      if (supported) {
        await Linking.openURL(ADMIN_DASHBOARD_URL);
        return;
      }
      throw new Error('unsupported');
    } catch {
      Alert.alert(
        'Dashboard URL not configured',
        'Set EXPO_PUBLIC_ADMIN_DASHBOARD_URL in your environment to wire this button to the admin dashboard.',
      );
    }
  }, []);

  const handleSignOut = useCallback(() => {
    Alert.alert(
      'Sign out?',
      'You will need to sign back in to return to the admin view.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign Out', style: 'destructive', onPress: () => void logout() },
      ],
    );
  }, [logout]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageWrap}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.greeting}>
              Hello, <Text style={styles.greetingAccent}>{firstName}</Text>
            </Text>
            <View style={styles.roleBadge}>
              <ShieldCheck color={colors.primary} size={13} />
              <Text style={styles.roleBadgeText}>Admin</Text>
            </View>
          </View>

          <Text style={styles.subtitle}>
            You're signed in with admin access. Use the dashboard below to
            manage members, CHWs, sessions, and claims.
          </Text>

          {/* Primary CTA — open admin dashboard */}
          <Pressable
            onPress={handleOpenDashboard}
            style={({ pressed }) => [styles.primaryCard, pressed && styles.primaryCardPressed]}
            accessibilityRole="button"
            accessibilityLabel="Open the admin dashboard"
          >
            <View style={styles.primaryCardContent}>
              <Text style={styles.primaryCardTitle}>Open Admin Dashboard</Text>
              <Text style={styles.primaryCardSub}>
                Members, CHWs, sessions, requests, claims, waitlist
              </Text>
            </View>
            <View style={styles.primaryCardIcon}>
              <ExternalLink color={colors.primary} size={18} />
            </View>
          </Pressable>

          {/* Quick reference grid — what's available where */}
          <View style={styles.referenceCard}>
            <Text style={styles.referenceTitle}>WHAT'S WHERE</Text>
            <View style={styles.referenceRow}>
              <Text style={styles.referenceLabel}>Member view</Text>
              <Text style={styles.referenceValue}>Sign in with a member account</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.referenceRow}>
              <Text style={styles.referenceLabel}>CHW view</Text>
              <Text style={styles.referenceValue}>Sign in with a CHW account</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.referenceRow}>
              <Text style={styles.referenceLabel}>Admin tools</Text>
              <Text style={styles.referenceValue}>Web dashboard (button above)</Text>
            </View>
          </View>

          {/* Sign out */}
          <Pressable
            onPress={handleSignOut}
            style={({ pressed }) => [styles.signOutBtn, pressed && styles.signOutBtnPressed]}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
          >
            <LogOut color={colors.destructive} size={16} />
            <Text style={styles.signOutText}>Sign Out</Text>
          </Pressable>

          <Text style={styles.versionText}>Compass CHW · Admin · v1.0.0</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F1ED',
  },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  pageWrap: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  greeting: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
  },
  greetingAccent: {
    color: '#7A9F5A',
  },
  roleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
    backgroundColor: `${colors.primary}15`,
  },
  roleBadgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  subtitle: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    lineHeight: 20,
    color: '#6B7280',
    marginBottom: 20,
  },

  primaryCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 24,
      },
      android: { elevation: 3 },
    }),
  },
  primaryCardPressed: {
    opacity: 0.9,
  },
  primaryCardContent: {
    flex: 1,
    gap: 2,
  },
  primaryCardTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  },
  primaryCardSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
  },
  primaryCardIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: `${colors.primary}15`,
    alignItems: 'center',
    justifyContent: 'center',
  },

  referenceCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    marginBottom: 16,
  },
  referenceTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#6B7280',
    letterSpacing: 1,
    marginBottom: 8,
  },
  referenceRow: {
    paddingVertical: 10,
  },
  referenceLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#1E3320',
  },
  referenceValue: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: '#DDD6CC',
  },

  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    backgroundColor: '#FFFFFF',
    marginBottom: 16,
  },
  signOutBtnPressed: {
    opacity: 0.85,
  },
  signOutText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: colors.destructive,
  },

  versionText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
    textAlign: 'center',
    marginBottom: 24,
  },
});
