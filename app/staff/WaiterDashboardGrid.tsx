// app/staff/WaiterDashboardGrid.tsx
// The waiter's notification dashboard.
// Columns: Table | Request Made | Actioned | Bill Paid (close session)
// Real-time updates via Supabase subscription.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  getWaiterGridRows,
  markActioned,
  subscribeToWaiterNotifications,
} from '../../lib/notificationService';
import { deactivatePairing } from '../../lib/pairingService';
import { useTheme } from '../../lib/ThemeContext';
import type { NotificationType, WaiterGridRow } from '../../lib/types';

const TYPE_LABELS: Record<NotificationType, string> = {
  NEW_ORDER: 'New Order',
  BILL_REQUEST: 'Bill Request',
  WAITER_REQUEST: 'Call Waiter',
  CONDIMENT_REQUEST: 'Condiments',
  ORDER_UPDATE: 'Order Update',
};

export default function WaiterDashboardGrid() {
  const { theme } = useTheme();
  const router = useRouter();
  const [rows, setRows] = useState<WaiterGridRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);

  const unsubscribeRef = useRef<(() => void) | null>(null);

  // ── Data fetching ─────────────────────────────────────────────────────────

  const loadRows = useCallback(async () => {
    try {
      const data = await getWaiterGridRows();
      setRows(data);

      // Re-subscribe whenever the pairing set changes
      unsubscribeRef.current?.();
      const pairingIds = data.map((r) => r.pairingId);
      unsubscribeRef.current = subscribeToWaiterNotifications(pairingIds, (newRow) => {
        setRows((prev) => {
          const idx = prev.findIndex((r) => r.pairingId === newRow.pairingId);
          if (idx === -1) return [...prev, newRow];
          const updated = [...prev];
          updated[idx] = newRow;
          return updated;
        });
      });
    } catch (err) {
      console.error('[WaiterDashboard] loadRows error:', err);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadRows();
    return () => {
      unsubscribeRef.current?.();
    };
  }, [loadRows]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleActioned = async (row: WaiterGridRow) => {
    if (!row.latestNotificationId) return;
    setActioningId(row.latestNotificationId);
    try {
      await markActioned(row.latestNotificationId);
      setRows((prev) =>
        prev.map((r) =>
          r.pairingId === row.pairingId ? { ...r, isActioned: true } : r
        )
      );
    } catch {
      Alert.alert('Error', 'Could not mark as actioned.');
    } finally {
      setActioningId(null);
    }
  };

  const handleBillPaid = (row: WaiterGridRow) => {
    Alert.alert(
      'Bill Paid',
      `Close the session for ${row.tableName}? The table will need to scan a new QR code for future orders.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          style: 'destructive',
          onPress: async () => {
            setClosingId(row.pairingId);
            try {
              await deactivatePairing(row.pairingId);
              setRows((prev) => prev.filter((r) => r.pairingId !== row.pairingId));
            } catch {
              Alert.alert('Error', 'Could not close the session.');
            } finally {
              setClosingId(null);
            }
          },
        },
      ]
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.backgroundColor }}>
        <View style={[styles.dashHeader, { borderBottomColor: theme.primaryColor }]}>
          <View style={styles.dashTitleRow}>
            {theme.logoUrl ? (
              <Image source={{ uri: theme.logoUrl }} style={styles.headerLogo} resizeMode="contain" />
            ) : null}
            <Text style={[styles.dashTitle, { color: theme.textColor }]}>Waiter Dashboard</Text>
          </View>
          <TouchableOpacity
            style={[styles.scanBtn, { backgroundColor: theme.primaryColor }]}
            onPress={() => router.push('/pairing/PairDevices')}
          >
            <Text style={styles.scanBtnText}>📷  Scan QR</Text>
          </TouchableOpacity>
        </View>
        <View style={[styles.centered, { flex: 1 }]}>
          <ActivityIndicator size="large" color={theme.primaryColor} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.backgroundColor }}>
      {/* ── Header with logo and Scan button ── */}
      <View style={[styles.dashHeader, { borderBottomColor: theme.primaryColor }]}>
        <View style={styles.dashTitleRow}>
          {theme.logoUrl ? (
            <Image source={{ uri: theme.logoUrl }} style={styles.headerLogo} resizeMode="contain" />
          ) : null}
          <Text style={[styles.dashTitle, { color: theme.textColor }]}>
            Waiter Dashboard
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.scanBtn, { backgroundColor: theme.primaryColor }]}
          onPress={() => router.push('/pairing/PairDevices')}
        >
          <Text style={styles.scanBtnText}>📷  Scan QR</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
      style={{ backgroundColor: theme.backgroundColor }}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            loadRows();
          }}
          colors={[theme.primaryColor]}
        />
      }
      horizontal
    >
      <View style={styles.table}>
        {/* Header row */}
        <View style={[styles.row, styles.headerRow, { borderBottomColor: theme.primaryColor }]}>
          <Text style={[styles.headerCell, styles.colTable, { color: theme.textColor }]}>Table</Text>
          <Text style={[styles.headerCell, styles.colRequest, { color: theme.textColor }]}>Request</Text>
          <Text style={[styles.headerCell, styles.colAction, { color: theme.textColor }]}>Actioned</Text>
          <Text style={[styles.headerCell, styles.colBill, { color: theme.textColor }]}>Bill Paid</Text>
        </View>

        {rows.length === 0 ? (
          <View style={styles.emptyRow}>
            <Text style={[styles.emptyText, { color: theme.textColor }]}>
              No active tables. Pair a patron device to start receiving requests.
            </Text>
          </View>
        ) : (
          rows.map((row) => (
            <View key={row.pairingId} style={[styles.row, styles.dataRow]}>
              {/* Table name */}
              <Text style={[styles.cell, styles.colTable, { color: theme.textColor }]} numberOfLines={2}>
                {row.tableName}
              </Text>

              {/* Request type + message */}
              <View style={[styles.colRequest]}>
                {row.notificationType && (
                  <Text style={[styles.badge, { backgroundColor: theme.primaryColor + '20', color: theme.primaryColor }]}>
                    {TYPE_LABELS[row.notificationType] ?? row.notificationType}
                  </Text>
                )}
                <Text style={[styles.cell, { color: theme.textColor }]} numberOfLines={2}>
                  {row.requestMade}
                </Text>
              </View>

              {/* Actioned button */}
              <View style={styles.colAction}>
                {row.isActioned ? (
                  <Text style={styles.doneLabel}>✓ Done</Text>
                ) : row.latestNotificationId ? (
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: theme.primaryColor }]}
                    onPress={() => handleActioned(row)}
                    disabled={actioningId === row.latestNotificationId}
                  >
                    {actioningId === row.latestNotificationId ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.actionBtnText}>Action</Text>
                    )}
                  </TouchableOpacity>
                ) : (
                  <Text style={styles.muted}>—</Text>
                )}
              </View>

              {/* Bill Paid button */}
              <View style={styles.colBill}>
                <TouchableOpacity
                  style={[styles.billBtn, { borderColor: theme.primaryColor }]}
                  onPress={() => handleBillPaid(row)}
                  disabled={closingId === row.pairingId}
                >
                  {closingId === row.pairingId ? (
                    <ActivityIndicator size="small" color={theme.primaryColor} />
                  ) : (
                    <Text style={[styles.billBtnText, { color: theme.primaryColor }]}>Bill Paid</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
      </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 32 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  table: { minWidth: 640 },

  dashHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 2,
  },
  dashTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  headerLogo: {
    width: 36,
    height: 36,
    borderRadius: 6,
  },
  dashTitle: { fontSize: 18, fontWeight: '700' },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
  },
  scanBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 8 },
  headerRow: { borderBottomWidth: 2, marginBottom: 4 },
  dataRow: { borderBottomWidth: 1, borderBottomColor: '#eee' },

  headerCell: { fontWeight: '700', fontSize: 13 },
  cell: { fontSize: 13 },

  colTable:   { width: 120 },
  colRequest: { flex: 1, minWidth: 160, paddingRight: 8, gap: 4 },
  colAction:  { width: 90, alignItems: 'center' },
  colBill:    { width: 90, alignItems: 'center' },

  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
    fontSize: 11,
    fontWeight: '600',
  },

  actionBtn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8 },
  actionBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  doneLabel: { color: '#4CAF50', fontSize: 12, fontWeight: '600' },
  muted: { color: '#999', fontSize: 12 },

  billBtn: { paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1 },
  billBtnText: { fontSize: 12, fontWeight: '600' },

  emptyRow: { padding: 32, alignItems: 'center' },
  emptyText: { textAlign: 'center', fontSize: 14, opacity: 0.7 },
});
