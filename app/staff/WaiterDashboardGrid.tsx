// app/staff/WaiterDashboardGrid.tsx
// The waiter's notification dashboard.
//
// UI fix: notifications now stack as a list — newest at the top.
// Each pairing (table) can have multiple notification rows, one per
// request received. New notifications are prepended to the list rather
// than replacing the existing row for that table.
//
// Each row shows:
//   • Table name + time received
//   • Request type badge + message
//   • Action button (marks the specific notification as actioned)
//   • Bill Paid button (closes the entire pairing session)

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { getDeviceId } from '../../lib/deviceService';
import { markActioned } from '../../lib/notificationService';
import { deactivatePairing } from '../../lib/pairingService';
import { useTheme } from '../../lib/ThemeContext';
import type { NotificationType } from '../../lib/types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface NotificationRow {
  notificationId: string;
  pairingId: string;
  tableName: string;
  notificationType: NotificationType;
  message: string;
  isActioned: boolean;
  receivedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<NotificationType, string> = {
  NEW_ORDER: '🍽️ New Order',
  BILL_REQUEST: '🧾 Bill Request',
  WAITER_REQUEST: '🙋 Call Waiter',
  CONDIMENT_REQUEST: '🧂 Condiments',
  ORDER_UPDATE: '📝 Order Update',
};

const TYPE_COLORS: Record<NotificationType, string> = {
  NEW_ORDER: '#2196F3',
  BILL_REQUEST: '#9C27B0',
  WAITER_REQUEST: '#FF9800',
  CONDIMENT_REQUEST: '#4CAF50',
  ORDER_UPDATE: '#607D8B',
};

function timeAgo(isoString: string): string {
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function WaiterDashboardGrid() {
  const { theme } = useTheme();
  const router = useRouter();

  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [activePairings, setActivePairings] = useState<Map<string, string>>(new Map()); // pairingId → tableName
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // ── Load all notifications for active pairings ────────────────────────────

  const loadData = useCallback(async () => {
    try {
      const receiverId = await getDeviceId();

      // Fetch all active pairings for this waiter
      const { data: pairings, error: pErr } = await supabase
        .from('pairings')
        .select('id, table_name')
        .eq('receiver_id', receiverId)
        .eq('is_active', true);

      if (pErr) throw pErr;
      if (!pairings?.length) {
        setNotifications([]);
        setActivePairings(new Map());
        setIsLoading(false);
        setRefreshing(false);
        return;
      }

      const pairingMap = new Map(pairings.map((p) => [p.id, p.table_name]));
      setActivePairings(pairingMap);

      const pairingIds = pairings.map((p) => p.id);

      // Fetch ALL notifications for these pairings, newest first
      const { data: notifs, error: nErr } = await supabase
        .from('notifications')
        .select('id, pairing_id, notification_type, message, is_actioned, created_at')
        .in('pairing_id', pairingIds)
        .order('created_at', { ascending: false });

      if (nErr) throw nErr;

      const rows: NotificationRow[] = (notifs ?? []).map((n) => ({
        notificationId: n.id,
        pairingId: n.pairing_id,
        tableName: pairingMap.get(n.pairing_id) ?? 'Unknown Table',
        notificationType: n.notification_type as NotificationType,
        message: n.message,
        isActioned: n.is_actioned,
        receivedAt: n.created_at,
      }));

      setNotifications(rows);

      // Subscribe to new notifications for these pairings
      channelRef.current?.unsubscribe();
      const filter = `pairing_id=in.(${pairingIds.join(',')})`;
      channelRef.current = supabase
        .channel(`waiter-notifs-${Date.now()}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notifications', filter },
          (payload) => {
            const n = payload.new as any;
            const newRow: NotificationRow = {
              notificationId: n.id,
              pairingId: n.pairing_id,
              tableName: pairingMap.get(n.pairing_id) ?? 'Unknown Table',
              notificationType: n.notification_type as NotificationType,
              message: n.message,
              isActioned: n.is_actioned,
              receivedAt: n.created_at,
            };
            // Prepend — newest at top
            setNotifications((prev) => [newRow, ...prev]);
          }
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'notifications', filter },
          (payload) => {
            const n = payload.new as any;
            setNotifications((prev) =>
              prev.map((row) =>
                row.notificationId === n.id ? { ...row, isActioned: n.is_actioned } : row
              )
            );
          }
        )
        .subscribe((status) => {
          console.log('[WaiterDashboard] Realtime:', status);
        });

    } catch (err) {
      console.error('[WaiterDashboard] loadData error:', err);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    return () => { channelRef.current?.unsubscribe(); };
  }, [loadData]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleActioned = async (row: NotificationRow) => {
    setActioningId(row.notificationId);
    try {
      await markActioned(row.notificationId);
      setNotifications((prev) =>
        prev.map((r) => r.notificationId === row.notificationId ? { ...r, isActioned: true } : r)
      );
    } catch {
      Alert.alert('Error', 'Could not mark as actioned.');
    } finally {
      setActioningId(null);
    }
  };

  const handleBillPaid = (pairingId: string, tableName: string) => {
    Alert.alert(
      'Bill Paid',
      `Close the session for ${tableName}? The table will need to scan a new QR code for future orders.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          style: 'destructive',
          onPress: async () => {
            setClosingId(pairingId);
            try {
              await deactivatePairing(pairingId);
              // Remove all notifications for this pairing
              setNotifications((prev) => prev.filter((r) => r.pairingId !== pairingId));
              setActivePairings((prev) => { const m = new Map(prev); m.delete(pairingId); return m; });
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

  const renderItem = ({ item }: { item: NotificationRow }) => {
    const typeColor = TYPE_COLORS[item.notificationType] ?? theme.primaryColor;
    const isClosing = closingId === item.pairingId;

    return (
      <View style={[styles.card, item.isActioned && styles.cardActioned]}>
        {/* Top row: table name + time + bill paid */}
        <View style={styles.cardHeader}>
          <View style={styles.cardHeaderLeft}>
            <Text style={[styles.tableName, { color: theme.textColor }]}>{item.tableName}</Text>
            <Text style={styles.timeAgo}>{timeAgo(item.receivedAt)}</Text>
          </View>
          <TouchableOpacity
            style={[styles.billBtn, { borderColor: theme.primaryColor }, isClosing && styles.btnDisabled]}
            onPress={() => handleBillPaid(item.pairingId, item.tableName)}
            disabled={isClosing}
          >
            {isClosing ? (
              <ActivityIndicator size="small" color={theme.primaryColor} />
            ) : (
              <Text style={[styles.billBtnText, { color: theme.primaryColor }]}>Bill Paid</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Type badge */}
        <View style={[styles.typeBadge, { backgroundColor: typeColor + '18' }]}>
          <Text style={[styles.typeBadgeText, { color: typeColor }]}>
            {TYPE_LABELS[item.notificationType] ?? item.notificationType}
          </Text>
        </View>

        {/* Message */}
        <Text style={[styles.message, { color: theme.textColor }]}>{item.message}</Text>

        {/* Action button */}
        <View style={styles.cardFooter}>
          {item.isActioned ? (
            <View style={styles.actionedBadge}>
              <Text style={styles.actionedText}>✓ Actioned</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: theme.primaryColor }]}
              onPress={() => handleActioned(item)}
              disabled={actioningId === item.notificationId}
            >
              {actioningId === item.notificationId ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.actionBtnText}>Mark Actioned</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.backgroundColor }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.primaryColor }]}>
        <Text style={[styles.headerTitle, { color: theme.textColor }]}>Waiter Dashboard</Text>
        <TouchableOpacity
          style={[styles.scanBtn, { backgroundColor: theme.primaryColor }]}
          onPress={() => router.push('/pairing/PairDevices')}
        >
          <Text style={styles.scanBtnText}>📷  Scan QR</Text>
        </TouchableOpacity>
      </View>

      {/* Active tables summary */}
      {activePairings.size > 0 && (
        <View style={[styles.summaryBar, { backgroundColor: theme.primaryColor + '12' }]}>
          <Text style={[styles.summaryText, { color: theme.primaryColor }]}>
            {activePairings.size} active table{activePairings.size !== 1 ? 's' : ''} •{' '}
            {notifications.filter((n) => !n.isActioned).length} pending
          </Text>
        </View>
      )}

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.primaryColor} />
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(item) => item.notificationId}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); loadData(); }}
              colors={[theme.primaryColor]}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>🔔</Text>
              <Text style={[styles.emptyTitle, { color: theme.textColor }]}>No notifications yet</Text>
              <Text style={[styles.emptySubtitle, { color: theme.textColor }]}>
                Pair with a table and notifications will appear here.
              </Text>
              <TouchableOpacity
                style={[styles.emptyBtn, { backgroundColor: theme.primaryColor }]}
                onPress={() => router.push('/pairing/PairDevices')}
              >
                <Text style={styles.emptyBtnText}>📷  Scan QR Code</Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 2,
  },
  headerTitle: { fontSize: 20, fontWeight: '800' },
  scanBtn: { paddingVertical: 9, paddingHorizontal: 16, borderRadius: 10 },
  scanBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },

  summaryBar: {
    paddingHorizontal: 16, paddingVertical: 8,
  },
  summaryText: { fontSize: 13, fontWeight: '600' },

  list: { padding: 16, gap: 12 },

  // Notification card
  card: {
    backgroundColor: '#fff',
    borderRadius: 12, padding: 14,
    elevation: 2, shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3,
    gap: 10,
  },
  cardActioned: { opacity: 0.65 },

  cardHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  cardHeaderLeft: { gap: 2 },
  tableName: { fontSize: 16, fontWeight: '800' },
  timeAgo: { fontSize: 11, color: '#999' },

  typeBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 12,
  },
  typeBadgeText: { fontSize: 13, fontWeight: '700' },

  message: { fontSize: 14, lineHeight: 20, opacity: 0.8 },

  cardFooter: { flexDirection: 'row', alignItems: 'center' },
  actionBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8 },
  actionBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  actionedBadge: {
    backgroundColor: '#E8F5E9', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 8,
  },
  actionedText: { color: '#388E3C', fontSize: 13, fontWeight: '700' },

  billBtn: {
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1.5,
  },
  billBtnText: { fontSize: 12, fontWeight: '700' },
  btnDisabled: { opacity: 0.5 },

  // Empty state
  emptyState: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyIcon: { fontSize: 56 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptySubtitle: { fontSize: 14, opacity: 0.6, textAlign: 'center', paddingHorizontal: 32 },
  emptyBtn: { marginTop: 8, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10 },
  emptyBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
