// app/index.tsx
// Patron home screen (requestor device).
// Shows the restaurant logo/banner from restaurant_customisations,
// pairing status, Order Food, and quick service-request buttons.
//
// Fix: pairingId is refreshed every time the screen comes into focus
// (using useFocusEffect) so that after returning from the menu or pairing
// screens the status card and service buttons reflect the current state.
//
// Session lifecycle:
//   - Session starts when the waiter scans the QR (pairing is created)
//   - Session ends when the waiter marks the bill as paid (pairing deactivated)
//   - On session end the home screen shows "Table not paired yet" again

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';

import { useTheme } from '../lib/ThemeContext';
import { useAuth } from '../lib/AuthContext';
import { sendNotification } from '../lib/notificationService';
import { getActivePairingId } from '../lib/pairingService';

const SERVICE_BUTTONS = [
  {
    id: 'waiter',
    label: 'Call Waiter',
    icon: '🙋',
    type: 'WAITER_REQUEST' as const,
    message: 'Patron is requesting waiter assistance.',
    color: '#2196F3',
  },
  {
    id: 'condiments',
    label: 'Condiments',
    icon: '🧂',
    type: 'CONDIMENT_REQUEST' as const,
    message: 'Patron is requesting condiments.',
    color: '#FF9800',
  },
  {
    id: 'bill',
    label: 'Request Bill',
    icon: '🧾',
    type: 'BILL_REQUEST' as const,
    message: 'Patron has requested the bill.',
    color: '#9C27B0',
  },
] as const;

export default function HomeScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const { session, profile, isLoading: authLoading } = useAuth();

  const [pairingId, setPairingId] = useState<string | null>(null);
  const [isPairingLoading, setIsPairingLoading] = useState(true);
  const [sendingId, setSendingId] = useState<string | null>(null);

  // ── Refresh pairing status every time the screen comes into focus ──────────
  // This ensures:
  //   1. After returning from the menu, pairing status is still shown correctly
  //   2. After the waiter marks bill as paid (pairing deactivated), the screen
  //      correctly shows "Table not paired yet" on next focus
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setIsPairingLoading(true);

      getActivePairingId().then((id) => {
        if (!active) return;
        setPairingId(id);
        setIsPairingLoading(false);
      });

      return () => { active = false; };
    }, [])
  );

  // Logged-in staff get redirected to their dashboard
  if (!authLoading && session && profile) {
    return <Redirect href="/notifications" />;
  }

  const requiresPairing = () => {
    if (!pairingId) {
      Alert.alert(
        'Not Paired',
        'Your table is not paired with a waiter. Please tap "Generate QR Code" and ask your waiter to scan it.',
        [
          { text: 'OK' },
          { text: 'Generate QR', onPress: () => router.push('/pairing/GeneratePairing') },
        ]
      );
      return true;
    }
    return false;
  };

  const handleServiceRequest = async (btn: typeof SERVICE_BUTTONS[number]) => {
    if (requiresPairing()) return;
    setSendingId(btn.id);
    try {
      await sendNotification({
        pairingId: pairingId!,
        notificationType: btn.type,
        message: btn.message,
        metadata: {},
      });
      Alert.alert('Sent!', `${btn.label} request sent to your waiter.`);
    } catch {
      Alert.alert('Error', 'Could not send request. Please try again.');
    } finally {
      setSendingId(null);
    }
  };

  const handleOrderFood = () => {
    if (requiresPairing()) return;
    router.push('/menu');
  };

  const styles = useMemo(
    () => createStyles(theme.primaryColor, theme.borderRadius),
    [theme.primaryColor, theme.borderRadius]
  );

  return (
    <ScrollView
      style={{ backgroundColor: theme.backgroundColor }}
      contentContainerStyle={styles.container}
    >
      {/* ── Brand header ── */}
      <View style={styles.brandHeader}>
        {theme.bannerUrl ? (
          <Image
            source={{ uri: theme.bannerUrl }}
            style={styles.banner}
            resizeMode="cover"
          />
        ) : null}

        {theme.logoUrl ? (
          <Image
            source={{ uri: theme.logoUrl }}
            style={[
              styles.logo,
              theme.bannerUrl ? styles.logoOverBanner : null,
            ]}
            resizeMode="contain"
          />
        ) : (
          <Text style={[styles.logoEmoji, { color: theme.primaryColor }]}>🍽️</Text>
        )}

        <Text style={[styles.welcome, { color: theme.textColor, fontFamily: theme.fontFamily }]}>
          Welcome
        </Text>
        <Text style={[styles.tagline, { color: theme.textColor }]}>
          How can we help you today?
        </Text>
      </View>

      {/* ── Pairing status ── */}
      <View style={[styles.statusCard, { borderColor: pairingId ? '#4CAF50' : '#FF9800' }]}>
        {isPairingLoading ? (
          <ActivityIndicator color={theme.primaryColor} />
        ) : pairingId ? (
          <>
            <Text style={styles.statusDot}>🟢</Text>
            <Text style={[styles.statusText, { color: theme.textColor }]}>
              Table paired — your waiter will receive your requests.
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.statusDot}>🟡</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.statusText, { color: theme.textColor }]}>
                Table not paired yet.
              </Text>
              <TouchableOpacity onPress={() => router.push('/pairing/GeneratePairing')}>
                <Text style={[styles.pairLink, { color: theme.primaryColor }]}>
                  Generate QR Code →
                </Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>

      {/* ── Staff: scan patron QR ── */}
      <TouchableOpacity
        style={[
          styles.scanQrBtn,
          {
            borderColor: theme.primaryColor,
            borderRadius: theme.borderRadius,
            backgroundColor: theme.backgroundColor,
          },
        ]}
        onPress={() => router.push('/pairing/PairDevices')}
        activeOpacity={0.85}
      >
        <Text style={styles.scanQrBtnIcon}>📷</Text>
        <View style={{ flex: 1 }}>
          <Text style={[styles.scanQrBtnLabel, { color: theme.textColor }]}>Scan QR Code</Text>
          <Text style={[styles.scanQrBtnSub, { color: theme.textColor }]}>
            Staff: pair with a table by scanning their code
          </Text>
        </View>
      </TouchableOpacity>

      {/* ── Order food — primary CTA ── */}
      <TouchableOpacity
        style={[styles.orderBtn, { backgroundColor: theme.primaryColor, borderRadius: theme.borderRadius }]}
        onPress={handleOrderFood}
      >
        <Text style={styles.orderBtnIcon}>🍽️</Text>
        <View>
          <Text style={styles.orderBtnLabel}>Order Food</Text>
          <Text style={styles.orderBtnSub}>Browse the menu</Text>
        </View>
      </TouchableOpacity>

      {/* ── Quick requests ── */}
      <Text style={[styles.sectionTitle, { color: theme.textColor }]}>Quick Requests</Text>
      <View style={styles.grid}>
        {SERVICE_BUTTONS.map((btn) => (
          <TouchableOpacity
            key={btn.id}
            style={[
              styles.gridBtn,
              { backgroundColor: btn.color + '15', borderColor: btn.color, borderRadius: theme.borderRadius },
            ]}
            onPress={() => handleServiceRequest(btn)}
            disabled={sendingId === btn.id}
          >
            {sendingId === btn.id ? (
              <ActivityIndicator color={btn.color} />
            ) : (
              <Text style={styles.gridBtnIcon}>{btn.icon}</Text>
            )}
            <Text style={[styles.gridBtnLabel, { color: btn.color }]}>{btn.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

function createStyles(primaryColor: string, borderRadius: number) {
  return StyleSheet.create({
    container: { gap: 20, paddingBottom: 32 },

    brandHeader: { alignItems: 'center' },
    banner: { width: '100%', height: 180 },
    logo: {
      width: 100, height: 100, borderRadius: 12,
      marginTop: 16, backgroundColor: '#fff',
    },
    logoOverBanner: {
      marginTop: -40, borderWidth: 3, borderColor: '#fff',
      elevation: 4, shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 4,
    },
    logoEmoji: { fontSize: 56, marginTop: 24 },
    welcome: { fontSize: 28, fontWeight: 'bold', marginTop: 12 },
    tagline: { fontSize: 15, opacity: 0.65, marginTop: 4, marginBottom: 8 },

    statusCard: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      padding: 16, borderRadius: 12, borderWidth: 1.5, backgroundColor: '#fff',
      marginHorizontal: 24,
    },
    statusDot: { fontSize: 20 },
    statusText: { fontSize: 14, flex: 1 },
    pairLink: { fontSize: 14, fontWeight: '600', marginTop: 4 },

    scanQrBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 16,
      padding: 18, marginHorizontal: 24, borderWidth: 2,
    },
    scanQrBtnIcon: { fontSize: 32 },
    scanQrBtnLabel: { fontSize: 18, fontWeight: '700' },
    scanQrBtnSub: { fontSize: 12, opacity: 0.65, marginTop: 2 },

    orderBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 16,
      padding: 20, marginHorizontal: 24,
    },
    orderBtnIcon: { fontSize: 36 },
    orderBtnLabel: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
    orderBtnSub: { color: 'rgba(255,255,255,0.8)', fontSize: 13 },

    sectionTitle: { fontSize: 16, fontWeight: '700', marginHorizontal: 24 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 24 },
    gridBtn: { flex: 1, minWidth: 140, padding: 20, alignItems: 'center', borderWidth: 1.5, gap: 8 },
    gridBtnIcon: { fontSize: 32 },
    gridBtnLabel: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  });
}
