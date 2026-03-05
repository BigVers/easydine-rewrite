// app/index.tsx
// Patron home screen (requestor device).
// Shows service request buttons: Call Waiter, Order Food, Request Condiments, Request Bill.
// Also shows pairing status and navigates to the menu.

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Redirect, useRouter } from 'expo-router';

import { useTheme } from '../lib/ThemeContext';
import { useAuth } from '../lib/AuthContext';
import { sendNotification } from '../lib/notificationService';
import { getActivePairingId } from '../lib/pairingService';

// ─── Service button config ────────────────────────────────────────────────────

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

// ─── Component ───────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const { session, profile, isLoading: authLoading } = useAuth();

  // Declarative auth guard — staff members who are logged in go to /notifications.
  // Using <Redirect /> instead of router.replace() avoids the SceneView crash
  // that occurs when the navigator hasn't finished mounting yet.
  if (!authLoading && session && profile) {
    return <Redirect href="/notifications" />;
  }

  const [pairingId, setPairingId] = useState<string | null>(null);
  const [isPairingLoading, setIsPairingLoading] = useState(true);
  const [sendingId, setSendingId] = useState<string | null>(null);

  // Check pairing status on mount
  useEffect(() => {
    getActivePairingId().then((id) => {
      setPairingId(id);
      setIsPairingLoading(false);
    });
  }, []);

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
    } catch (err) {
      Alert.alert('Error', 'Could not send request. Please try again.');
    } finally {
      setSendingId(null);
    }
  };

  const handleOrderFood = () => {
    if (requiresPairing()) return;
    router.push('/menu');
  };

  const styles = createStyles(theme.primaryColor, theme.borderRadius);

  return (
    <ScrollView
      style={{ backgroundColor: theme.backgroundColor }}
      contentContainerStyle={styles.container}
    >
      {/* Brand header */}
      <View style={styles.brandHeader}>
        <Text style={[styles.welcome, { color: theme.textColor, fontFamily: theme.fontFamily }]}>
          Welcome
        </Text>
        <Text style={[styles.tagline, { color: theme.textColor }]}>
          How can we help you today?
        </Text>
      </View>

      {/* Pairing status */}
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

      {/* Scan QR — waiter scans patron's code (receiver side) */}
      <TouchableOpacity
        style={[
          styles.scanBtn,
          { borderColor: theme.primaryColor, borderRadius: theme.borderRadius },
        ]}
        onPress={() => router.push('/pairing/PairDevices')}
      >
        <Text style={styles.scanBtnIcon}>📷</Text>
        <View>
          <Text style={[styles.scanBtnLabel, { color: theme.primaryColor }]}>Scan QR Code</Text>
          <Text style={[styles.scanBtnSub, { color: theme.textColor }]}>Pair with a patron table</Text>
        </View>
      </TouchableOpacity>

      {/* Order food — primary action */}
      <TouchableOpacity
        style={[
          styles.orderBtn,
          { backgroundColor: theme.primaryColor, borderRadius: theme.borderRadius },
        ]}
        onPress={handleOrderFood}
      >
        <Text style={styles.orderBtnIcon}>🍽️</Text>
        <View>
          <Text style={styles.orderBtnLabel}>Order Food</Text>
          <Text style={styles.orderBtnSub}>Browse the menu</Text>
        </View>
      </TouchableOpacity>

      {/* Service request buttons */}
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
    container: { padding: 24, gap: 20 },
    brandHeader: { alignItems: 'center', paddingVertical: 16 },
    welcome: { fontSize: 32, fontWeight: 'bold' },
    tagline: { fontSize: 16, opacity: 0.7, marginTop: 4 },

    statusCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 16,
      borderRadius: 12,
      borderWidth: 1.5,
      backgroundColor: '#fff',
    },
    statusDot: { fontSize: 20 },
    statusText: { fontSize: 14, flex: 1 },
    pairLink: { fontSize: 14, fontWeight: '600', marginTop: 4 },

    scanBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      padding: 18,
      borderWidth: 1.5,
      backgroundColor: '#fff',
    },
    scanBtnIcon: { fontSize: 32 },
    scanBtnLabel: { fontSize: 17, fontWeight: '700' },
    scanBtnSub: { fontSize: 12, opacity: 0.6, marginTop: 2 },

    orderBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      padding: 20,
    },
    orderBtnIcon: { fontSize: 36 },
    orderBtnLabel: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
    orderBtnSub: { color: 'rgba(255,255,255,0.8)', fontSize: 13 },

    sectionTitle: { fontSize: 16, fontWeight: '700' },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    gridBtn: {
      flex: 1,
      minWidth: 140,
      padding: 20,
      alignItems: 'center',
      borderWidth: 1.5,
      gap: 8,
    },
    gridBtnIcon: { fontSize: 32 },
    gridBtnLabel: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  });
}
