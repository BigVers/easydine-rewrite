// app/pairing/PairDevices.tsx
// Used by the RECEIVER (waiter's phone) to scan a patron's QR code
// or enter a code manually, completing the pairing.
//
// On success → redirected to the notification dashboard.

import React, { useState } from 'react';
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
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';

import { useTheme } from '../../lib/ThemeContext';
import { pairWithRequestor, parseQRData } from '../../lib/pairingService';
import { registerDevice } from '../../lib/deviceService';

type ScanMode = 'scan' | 'manual' | null;

const CODE_LENGTH = 6;

export default function PairDevices() {
  const router = useRouter();
  const { theme } = useTheme();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const [scanMode, setScanMode] = useState<ScanMode>(null);
  const [manualCode, setManualCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasScanned, setHasScanned] = useState(false);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const openScanner = async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        Alert.alert('Camera Permission', 'Camera access is required to scan QR codes.');
        return;
      }
    }
    setError(null);
    setHasScanned(false);
    setScanMode('scan');
  };

  const openManual = () => {
    setError(null);
    setManualCode('');
    setScanMode('manual');
  };

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (hasScanned || isLoading) return;
    setHasScanned(true);
    setScanMode(null);

    const parsed = parseQRData(data);
    if (!parsed) {
      setError('Invalid QR code. Please scan an EasyDine pairing code.');
      setHasScanned(false);
      return;
    }
    completePairing(parsed.code, parsed.requestorId);
  };

  const handleManualPair = () => {
    const code = manualCode.replace(/-/g, '').trim().toUpperCase();
    if (code.length !== CODE_LENGTH) {
      setError(`Code must be ${CODE_LENGTH} characters.`);
      return;
    }
    setScanMode(null);
    completePairing(code, null);
  };

  const completePairing = async (code: string, requestorId: string | null) => {
    setIsLoading(true);
    setError(null);

    try {
      // Ensure this device is registered as a receiver before pairing
      await registerDevice({ deviceType: 'receiver', deviceName: 'Waiter Device' });

      const parsed = requestorId
        ? { code, requestorId }
        : { code, requestorId: '' };

      // For manual entry the requestorId comes from the pairing_code row (handled server-side)
      const result = await pairWithRequestor(
        requestorId ? parsed : { code, requestorId: '__manual__' }
      );

      router.replace('/notifications');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Pairing failed. Please try again.';
      setError(msg);
      setHasScanned(false);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Styles ────────────────────────────────────────────────────────────────

  const styles = createStyles(theme.primaryColor, theme.borderRadius);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { backgroundColor: theme.backgroundColor }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={[styles.backBtnText, { color: theme.primaryColor }]}>←</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.textColor }]}>Pair With Table</Text>
        <View style={styles.backBtn} />
      </View>

      {/* Camera scanner */}
      {scanMode === 'scan' && (
        <View style={styles.scannerContainer}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={hasScanned ? undefined : handleBarcodeScanned}
          />
          {/* Viewfinder overlay */}
          <View style={styles.overlay} pointerEvents="none">
            <View style={styles.viewfinder} />
            <Text style={styles.scanHint}>Position QR code within the frame</Text>
          </View>

          <TouchableOpacity
            style={[styles.closeScanner, { backgroundColor: theme.primaryColor }]}
            onPress={() => setScanMode(null)}
          >
            <Text style={styles.closeScannerText}>Close Scanner</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Main controls */}
      {scanMode !== 'scan' && (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[styles.description, { color: theme.textColor }]}>
            Scan the QR code on the patron's tablet or enter the pairing code manually.
          </Text>

          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: '#E0E0E0' }]}
            onPress={openScanner}
            disabled={isLoading}
          >
            <Text style={[styles.actionBtnText, { color: '#333' }]}>📷  Scan QR Code</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: theme.primaryColor }]}
            onPress={openManual}
            disabled={isLoading}
          >
            <Text style={styles.actionBtnText}>⌨️  Enter Code Manually</Text>
          </TouchableOpacity>

          {/* Manual code entry */}
          {scanMode === 'manual' && (
            <View style={styles.manualEntry}>
              <Text style={[styles.label, { color: theme.textColor }]}>Pairing Code</Text>
              <TextInput
                style={[
                  styles.input,
                  { borderColor: theme.primaryColor, color: theme.textColor, borderRadius: theme.borderRadius },
                ]}
                placeholder="e.g. ABC123"
                placeholderTextColor="#999"
                value={manualCode}
                onChangeText={(t) => {
                  setManualCode(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH));
                  setError(null);
                }}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={CODE_LENGTH}
                editable={!isLoading}
              />

              <TouchableOpacity
                style={[
                  styles.primaryBtn,
                  { backgroundColor: theme.primaryColor, borderRadius: theme.borderRadius },
                  (manualCode.length !== CODE_LENGTH || isLoading) && styles.btnDisabled,
                ]}
                onPress={handleManualPair}
                disabled={manualCode.length !== CODE_LENGTH || isLoading}
              >
                {isLoading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryBtnText}>Pair</Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {isLoading && !scanMode && (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={theme.primaryColor} />
              <Text style={[styles.loadingText, { color: theme.textColor }]}>Pairing…</Text>
            </View>
          )}
        </ScrollView>
      )}
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
    content: { padding: 24, gap: 16 },
    description: { fontSize: 15, lineHeight: 22, textAlign: 'center' },

    actionBtn: {
      paddingVertical: 16,
      borderRadius: 10,
      alignItems: 'center',
    },
    actionBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },

    manualEntry: { gap: 10 },
    label: { fontSize: 15, fontWeight: '600' },
    input: {
      borderWidth: 2,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 22,
      letterSpacing: 6,
      textAlign: 'center',
    },
    primaryBtn: { paddingVertical: 14, alignItems: 'center' },
    primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
    btnDisabled: { opacity: 0.5 },

    errorBox: {
      backgroundColor: '#FFEBEE',
      borderRadius: 8,
      padding: 12,
    },
    errorText: { color: '#D32F2F', fontSize: 14, textAlign: 'center' },

    loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center' },
    loadingText: { fontSize: 15 },

    // Camera
    scannerContainer: { flex: 1, position: 'relative' },
    overlay: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    viewfinder: {
      width: 260,
      height: 260,
      borderWidth: 3,
      borderColor: '#fff',
      borderRadius: 12,
      backgroundColor: 'transparent',
    },
    scanHint: {
      marginTop: 20,
      color: '#fff',
      fontSize: 15,
      backgroundColor: 'rgba(0,0,0,0.6)',
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 8,
    },
    closeScanner: {
      position: 'absolute',
      bottom: 32,
      left: 24,
      right: 24,
      paddingVertical: 14,
      borderRadius: 10,
      alignItems: 'center',
    },
    closeScannerText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  });
}
