// app/pairing/GeneratePairing.tsx
// Used by the REQUESTOR (patron tablet) to display a QR code
// that the waiter will scan.
//
// Flow:
//   1. Patron enters table name → app generates QR code
//   2. QR is displayed on screen
//   3. A Supabase Realtime subscription listens for a new pairing
//      row where requestor_id = this device's UUID
//   4. When the waiter scans → pairing row is inserted in DB →
//      Realtime fires → patron tablet redirects to /menu

import React, { useState, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useTheme } from '../../lib/ThemeContext';
import { generatePairingCode } from '../../lib/pairingService';
import { getDeviceId, registerDevice } from '../../lib/deviceService';
import { supabase } from '../../lib/supabase';
import type { GeneratePairingResult } from '../../lib/pairingService';

export default function GeneratePairing() {
  const router = useRouter();
  const { theme } = useTheme();

  const [tableName, setTableName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<GeneratePairingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairingDetected, setPairingDetected] = useState(false);

  // Keep subscription ref so we can unsubscribe on unmount / reset
  const subscriptionRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // ── Subscribe to pairings for this device once QR is shown ────────────────
  useEffect(() => {
    if (!result) return; // only subscribe when QR is displayed

    let cancelled = false;

    const setupSubscription = async () => {
      const deviceId = await getDeviceId();

      // Clean up any old channel before creating a new one
      if (subscriptionRef.current) {
        await supabase.removeChannel(subscriptionRef.current);
      }

      const channel = supabase
        .channel(`pairing-watch-${deviceId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'pairings',
            filter: `requestor_id=eq.${deviceId}`,
          },
          (payload) => {
            if (cancelled) return;
            console.log('[GeneratePairing] Pairing detected:', payload.new);
            setPairingDetected(true);

            // Small delay so the patron sees the confirmation briefly
            setTimeout(() => {
              if (!cancelled) {
                router.replace('/menu');
              }
            }, 1200);
          }
        )
        .subscribe((status) => {
          console.log('[GeneratePairing] Realtime status:', status);
        });

      subscriptionRef.current = channel;
    };

    setupSubscription();

    return () => {
      cancelled = true;
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
        subscriptionRef.current = null;
      }
    };
  }, [result]); // re-subscribe whenever a new QR is generated

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    if (!tableName.trim()) {
      Alert.alert('Table name required', 'Please enter the table name or number.');
      return;
    }

    setIsLoading(true);
    setError(null);
    setPairingDetected(false);

    try {
      // Ensure this device is registered as a requestor (patron tablet)
      await registerDevice({ deviceType: 'requestor', deviceName: 'Patron Tablet' });
      const data = await generatePairingCode(tableName.trim());
      setResult(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate QR code.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = async () => {
    // Unsubscribe before resetting so old listener doesn't fire
    if (subscriptionRef.current) {
      await supabase.removeChannel(subscriptionRef.current);
      subscriptionRef.current = null;
    }
    setResult(null);
    setTableName('');
    setError(null);
    setPairingDetected(false);
  };

  const styles = createStyles(theme.primaryColor, theme.borderRadius);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { backgroundColor: theme.backgroundColor }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={[styles.backBtnText, { color: theme.primaryColor }]}>←</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.textColor, fontFamily: theme.fontFamily }]}>
          Generate Pairing
        </Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {result ? (
          /* ── QR Code display ── */
          <View style={styles.qrSection}>
            {pairingDetected ? (
              /* Waiter has scanned — show confirmation before redirect */
              <View style={styles.successBox}>
                <Text style={styles.successIcon}>✅</Text>
                <Text style={[styles.successTitle, { color: theme.primaryColor }]}>
                  Waiter Connected!
                </Text>
                <Text style={[styles.successSub, { color: theme.textColor }]}>
                  Taking you to the menu…
                </Text>
                <ActivityIndicator color={theme.primaryColor} style={{ marginTop: 12 }} />
              </View>
            ) : (
              <>
                <Text style={[styles.subtitle, { color: theme.textColor, fontFamily: theme.fontFamily }]}>
                  Show this QR code to your waiter
                </Text>

                <View style={styles.qrCard}>
                  <Image
                    source={{
                      uri: `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(result.qrData)}`,
                    }}
                    style={styles.qrImage}
                    contentFit="contain"
                  />
                </View>

                <View style={[styles.codeBox, { borderColor: theme.primaryColor }]}>
                  <Text style={[styles.codeLabel, { color: theme.textColor }]}>Code</Text>
                  <Text style={[styles.codeValue, { color: theme.primaryColor, fontFamily: theme.fontFamily }]}>
                    {result.code}
                  </Text>
                </View>

                <Text style={[styles.expiry, { color: theme.textColor }]}>
                  Expires in 2 hours • Waiting for waiter to scan…
                </Text>

                {/* Pulsing indicator to show we're listening */}
                <View style={styles.waitingRow}>
                  <ActivityIndicator size="small" color={theme.primaryColor} />
                  <Text style={[styles.waitingText, { color: theme.textColor }]}>
                    Waiting for waiter to scan
                  </Text>
                </View>

                <TouchableOpacity
                  style={[styles.secondaryBtn, { borderColor: theme.primaryColor }]}
                  onPress={handleReset}
                >
                  <Text style={[styles.secondaryBtnText, { color: theme.primaryColor }]}>
                    Generate New Code
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        ) : (
          /* ── Table name input ── */
          <View style={styles.inputSection}>
            <Text style={[styles.description, { color: theme.textColor }]}>
              Enter your table name or number to generate a QR code your waiter can scan.
            </Text>

            <Text style={[styles.label, { color: theme.textColor }]}>Table Name / Number</Text>
            <TextInput
              style={[
                styles.input,
                {
                  borderColor: theme.primaryColor,
                  color: theme.textColor,
                  backgroundColor: '#f9f9f9',
                  borderRadius: theme.borderRadius,
                },
              ]}
              placeholder="e.g. Table 5 or Window Table"
              placeholderTextColor="#999"
              value={tableName}
              onChangeText={setTableName}
              autoCapitalize="words"
              editable={!isLoading}
            />

            {error && (
              <Text style={styles.errorText}>{error}</Text>
            )}

            <TouchableOpacity
              style={[
                styles.primaryBtn,
                { backgroundColor: theme.primaryColor, borderRadius: theme.borderRadius },
                (!tableName.trim() || isLoading) && styles.btnDisabled,
              ]}
              onPress={handleGenerate}
              disabled={!tableName.trim() || isLoading}
            >
              {isLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>Generate QR Code</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function createStyles(primaryColor: string, borderRadius: number) {
  return StyleSheet.create({
    container: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: '#e0e0e0',
    },
    backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
    backBtnText: { fontSize: 24, fontWeight: 'bold' },
    title: { fontSize: 20, fontWeight: 'bold' },
    content: { padding: 24 },

    // QR section
    qrSection: { alignItems: 'center', gap: 20 },
    subtitle: { fontSize: 16, textAlign: 'center' },
    qrCard: {
      padding: 20,
      backgroundColor: '#fff',
      borderRadius: 12,
      elevation: 4,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.15,
      shadowRadius: 4,
    },
    qrImage: { width: 280, height: 280 },
    codeBox: {
      borderWidth: 2,
      borderRadius: 8,
      paddingHorizontal: 32,
      paddingVertical: 12,
      alignItems: 'center',
    },
    codeLabel: { fontSize: 12, marginBottom: 4 },
    codeValue: { fontSize: 28, fontWeight: 'bold', letterSpacing: 6 },
    expiry: { fontSize: 13, fontStyle: 'italic', opacity: 0.7, textAlign: 'center' },
    waitingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
      paddingHorizontal: 16,
      backgroundColor: '#f0f4ff',
      borderRadius: 20,
    },
    waitingText: { fontSize: 13 },
    secondaryBtn: {
      borderWidth: 2,
      borderRadius: 8,
      paddingHorizontal: 24,
      paddingVertical: 12,
    },
    secondaryBtnText: { fontSize: 15, fontWeight: '600' },

    // Success state
    successBox: { alignItems: 'center', gap: 12, paddingVertical: 40 },
    successIcon: { fontSize: 56 },
    successTitle: { fontSize: 24, fontWeight: 'bold', textAlign: 'center' },
    successSub: { fontSize: 16, textAlign: 'center', opacity: 0.7 },

    // Input section
    inputSection: { gap: 12 },
    description: { fontSize: 15, lineHeight: 22, marginBottom: 8 },
    label: { fontSize: 15, fontWeight: '600' },
    input: {
      borderWidth: 2,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 16,
    },
    errorText: { color: '#D32F2F', fontSize: 13, textAlign: 'center' },
    primaryBtn: {
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 8,
    },
    primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
    btnDisabled: { opacity: 0.5 },
  });
}
