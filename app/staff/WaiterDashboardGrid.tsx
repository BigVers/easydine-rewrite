// app/staff/WaiterDashboardGrid.tsx
// Waiter dashboard with two sections:
//
//  1. PAIRING REQUESTS (top) — new patron scan requests, waiter taps Accept
//  2. NOTIFICATIONS (below) — orders, waiter calls, bill requests etc.
//
// Pairing request flow:
//   Patron scans printed QR → pairing_request INSERT → Realtime fires here →
//   waiter taps Accept → accept_pairing_request RPC → pairing created →
//   patron's web app Realtime fires → deep link opens mobile app menu

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  SectionList,
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
import {
  fetchPendingRequests,
  subscribeToPairingRequests,
  acceptPairingRequest,
} from '../../lib/pairingRequestService';
import type { PairingRequestRow } from '../../lib/pairingRequestService';
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

  const [pairingRequests, setPairingRequests] = useState<PairingRequestRow[]>([]);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [activePairings, setActivePairings] = useState<Map<string, string>>(new Map());
  const [branchId, setBranchId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);

  const notifChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const requestUnsubRef = useRef<(() => void) | null>(null);
  const pairingChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // ── Load data ─────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    try {
      const receiverId = await getDeviceId();

      // Get device's branch_id for pairing request subscription
      const { data: deviceRow } = await supabase
        .from('devices')
        .select('branch_id')
        .eq('id', receiverId)
        .maybeSingle();

      const resolvedBranchId = deviceRow?.branch_id ?? null;
      setBranchId(resolvedBranchId);

      // Fetch pending pairing requests for this branch
      if (resolvedBranchId) {
        const requests = await fetchPendingRequests(resolvedBranchId);
        setPairingRequests(requests);

        // Subscribe to new pairing requests
        requestUnsubRef.current?.();
        requestUnsubRef.current = subscribeToPairingRequests(
          resolvedBranchId,
          (newReq) => {
            setPairingRequests((prev) => {
              // Avoid duplicates
              if (prev.some((r) => r.id === newReq.id)) return prev;
              return [newReq, ...prev];
            });
          }
        );
      }

      // Fetch active pairings (for notification subscription)
      const { data: pairings, error: pErr } = await supabase
        .from('pairings')
        .select('id, table_name')
        .eq('receiver_id', receiverId)
        .eq('is_active', true);

      if (pErr) throw pErr;

      if (!pairings?.length) {
        setNotifications([]);
        setActivePairings(new Map());

        // Still subscribe to new pairings — the waiter may have just registered
        // for a table but no patron has scanned yet.
        pairingChannelRef.current?.unsubscribe();
        pairingChannelRef.current = supabase
          .channel(`waiter-pairings-${receiverId}`)
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'pairings',
              filter: `receiver_id=eq.${receiverId}`,
            },
            (payload) => {
              const p = payload.new as any;
              if (!p?.is_active) return;
              console.log('[WaiterDashboard] First pairing detected, reloading:', p.id);
              loadData();
            }
          )
          .subscribe();

        setIsLoading(false);
        setRefreshing(false);
        return;
      }

      const pairingMap = new Map(pairings.map((p) => [p.id, p.table_name]));
      setActivePairings(pairingMap);

      const pairingIds = pairings.map((p) => p.id);

      // Fetch all notifications, newest first
      const { data: notifs, error: nErr } = await supabase
        .from('notifications')
        .select('id, pairing_id, notification_type, message, is_actioned, created_at')
        .in('pairing_id', pairingIds)
        .order('created_at', { ascending: false });

      if (nErr) throw nErr;

      setNotifications(
        (notifs ?? []).map((n) => ({
          notificationId: n.id,
          pairingId: n.pairing_id,
          tableName: pairingMap.get(n.pairing_id) ?? 'Unknown Table',
          notificationType: n.notification_type as NotificationType,
          message: n.message,
          isActioned: n.is_actioned,
          receivedAt: n.created_at,
        }))
      );

      // Subscribe to new + updated notifications
      notifChannelRef.current?.unsubscribe();
      const filter = `pairing_id=in.(${pairingIds.join(',')})`;
      notifChannelRef.current = supabase
        .channel(`waiter-notifs-${Date.now()}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notifications', filter },
          (payload) => {
            const n = payload.new as any;
            setNotifications((prev) => [{
              notificationId: n.id,
              pairingId: n.pairing_id,
              tableName: pairingMap.get(n.pairing_id) ?? 'Unknown Table',
              notificationType: n.notification_type as NotificationType,
              message: n.message,
              isActioned: n.is_actioned,
              receivedAt: n.created_at,
            }, ...prev]);
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
        .subscribe();

      // ── Subscribe to new pairings for this receiver ──────────────────────
      // When a patron scans the printed table QR, pair_table RPC creates a
      // pairing directly (no waiter action needed). We listen for that INSERT
      // here and reload so the new pairing is added to the notification
      // subscription and appears in the active tables count.
      pairingChannelRef.current?.unsubscribe();
      pairingChannelRef.current = supabase
        .channel(`waiter-pairings-${receiverId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'pairings',
            filter: `receiver_id=eq.${receiverId}`,
          },
          (payload) => {
            const p = payload.new as any;
            if (!p?.is_active) return;
            console.log('[WaiterDashboard] New pairing detected, reloading:', p.id);
            loadData();
          }
        )
        .subscribe();

    } catch (err) {
      console.error('[WaiterDashboard] loadData error:', err);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    return () => {
      notifChannelRef.current?.unsubscribe();
      pairingChannelRef.current?.unsubscribe();
      requestUnsubRef.current?.();
    };
  }, [loadData]);

  // ── Accept pairing request ────────────────────────────────────────────────

  const handleAccept = async (req: PairingRequestRow) => {
    setAcceptingId(req.id);
    try {
      const result = await acceptPairingRequest(req.id);
      // Remove from requests list
      setPairingRequests((prev) => prev.filter((r) => r.id !== req.id));
      // Add to active pairings map so notification subscription updates
      setActivePairings((prev) => new Map(prev).set(result.pairingId, req.tableName));
      Alert.alert('Paired!', `You are now serving ${req.tableName}.`);
      // Reload to pick up the new pairing for the notification subscription
      loadData();
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not accept request.');
    } finally {
      setAcceptingId(null);
    }
  };

  const handleDismiss = (reqId: string) => {
    setPairingRequests((prev) => prev.filter((r) => r.id !== reqId));
  };

  // ── Notification actions ──────────────────────────────────────────────────

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
      `Close the session for ${tableName}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          style: 'destructive',
          onPress: async () => {
            setClosingId(pairingId);
            try {
              await deactivatePairing(pairingId);
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

  // ── Render: pairing request card ─────────────────────────────────────────

  const renderPairingRequest = (req: PairingRequestRow) => {
    const isAccepting = acceptingId === req.id;
    return (
      <View key={req.id} style={[styles.requestCard, { borderColor: theme.primaryColor }]}>
        <View style={styles.requestHeader}>
          <View>
            <Text style={[styles.requestTable, { color: theme.primaryColor }]}>
              {req.tableName}
            </Text>
            <Text style={styles.requestTime}>{timeAgo(req.createdAt)} • New patron</Text>
          </View>
          <View style={[styles.requestBadge, { backgroundColor: theme.primaryColor + '18' }]}>
            <Text style={[styles.requestBadgeText, { color: theme.primaryColor }]}>
              Needs service
            </Text>
          </View>
        </View>
        <Text style={[styles.requestMessage, { color: theme.textColor }]}>
          A patron scanned the QR code at this table and is waiting to be served.
        </Text>
        <View style={styles.requestActions}>
          <TouchableOpacity
            style={[styles.acceptBtn, { backgroundColor: theme.primaryColor }, isAccepting && styles.btnDisabled]}
            onPress={() => handleAccept(req)}
            disabled={isAccepting}
          >
            {isAccepting
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.acceptBtnText}>Accept Table</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.dismissBtn}
            onPress={() => handleDismiss(req.id)}
            disabled={isAccepting}
          >
            <Text style={styles.dismissBtnText}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ── Render: notification card ─────────────────────────────────────────────

  const renderNotification = ({ item }: { item: NotificationRow }) => {
    const typeColor = TYPE_COLORS[item.notificationType] ?? theme.primaryColor;
    const isClosing = closingId === item.pairingId;
    return (
      <View style={[styles.card, item.isActioned && styles.cardActioned]}>
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
            {isClosing
              ? <ActivityIndicator size="small" color={theme.primaryColor} />
              : <Text style={[styles.billBtnText, { color: theme.primaryColor }]}>Bill Paid</Text>
            }
          </TouchableOpacity>
        </View>
        <View style={[styles.typeBadge, { backgroundColor: typeColor + '18' }]}>
          <Text style={[styles.typeBadgeText, { color: typeColor }]}>
            {TYPE_LABELS[item.notificationType] ?? item.notificationType}
          </Text>
        </View>
        <Text style={[styles.message, { color: theme.textColor }]}>{item.message}</Text>
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
              {actioningId === item.notificationId
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.actionBtnText}>Mark Actioned</Text>
              }
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  // ── Main render ───────────────────────────────────────────────────────────

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

      {/* Summary bar */}
      {(activePairings.size > 0 || pairingRequests.length > 0) && (
        <View style={[styles.summaryBar, { backgroundColor: theme.primaryColor + '12' }]}>
          <Text style={[styles.summaryText, { color: theme.primaryColor }]}>
            {pairingRequests.length > 0 && `${pairingRequests.length} new request${pairingRequests.length !== 1 ? 's' : ''} • `}
            {activePairings.size} active table{activePairings.size !== 1 ? 's' : ''} • {notifications.filter((n) => !n.isActioned).length} pending
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
          renderItem={renderNotification}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); loadData(); }}
              colors={[theme.primaryColor]}
            />
          }
          ListHeaderComponent={
            pairingRequests.length > 0 ? (
              <View style={styles.requestsSection}>
                <Text style={[styles.sectionLabel, { color: theme.primaryColor }]}>
                  New Table Requests
                </Text>
                {pairingRequests.map(renderPairingRequest)}
              </View>
            ) : null
          }
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            pairingRequests.length > 0 ? null : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyIcon}>🔔</Text>
                <Text style={[styles.emptyTitle, { color: theme.textColor }]}>No notifications yet</Text>
                <Text style={[styles.emptySubtitle, { color: theme.textColor }]}>
                  When a patron scans a table QR code or places an order, it will appear here.
                </Text>
                <TouchableOpacity
                  style={[styles.emptyBtn, { backgroundColor: theme.primaryColor }]}
                  onPress={() => router.push('/pairing/PairDevices')}
                >
                  <Text style={styles.emptyBtnText}>📷  Scan QR Code</Text>
                </TouchableOpacity>
              </View>
            )
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

  summaryBar: { paddingHorizontal: 16, paddingVertical: 8 },
  summaryText: { fontSize: 13, fontWeight: '600' },

  list: { padding: 16, gap: 12 },

  // ── Pairing request section ──
  requestsSection: { gap: 10, marginBottom: 8 },
  sectionLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 },

  requestCard: {
    backgroundColor: '#fff',
    borderRadius: 12, padding: 14,
    borderWidth: 2,
    elevation: 3, shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.10, shadowRadius: 4,
    gap: 10,
  },
  requestHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  requestTable: { fontSize: 17, fontWeight: '800' },
  requestTime: { fontSize: 11, color: '#999', marginTop: 2 },
  requestBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  requestBadgeText: { fontSize: 12, fontWeight: '700' },
  requestMessage: { fontSize: 13, lineHeight: 19, opacity: 0.75 },
  requestActions: { flexDirection: 'row', gap: 10 },
  acceptBtn: { flex: 1, paddingVertical: 11, borderRadius: 8, alignItems: 'center' },
  acceptBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  dismissBtn: { paddingVertical: 11, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: '#ddd' },
  dismissBtnText: { fontSize: 14, color: '#888' },

  // ── Notification cards ──
  card: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14,
    elevation: 2, shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3,
    gap: 10,
  },
  cardActioned: { opacity: 0.65 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardHeaderLeft: { gap: 2 },
  tableName: { fontSize: 16, fontWeight: '800' },
  timeAgo: { fontSize: 11, color: '#999' },
  typeBadge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  typeBadgeText: { fontSize: 13, fontWeight: '700' },
  message: { fontSize: 14, lineHeight: 20, opacity: 0.8 },
  cardFooter: { flexDirection: 'row', alignItems: 'center' },
  actionBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8 },
  actionBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  actionedBadge: { backgroundColor: '#E8F5E9', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 8 },
  actionedText: { color: '#388E3C', fontSize: 13, fontWeight: '700' },
  billBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1.5 },
  billBtnText: { fontSize: 12, fontWeight: '700' },
  btnDisabled: { opacity: 0.5 },

  emptyState: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyIcon: { fontSize: 56 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptySubtitle: { fontSize: 14, opacity: 0.6, textAlign: 'center', paddingHorizontal: 32 },
  emptyBtn: { marginTop: 8, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10 },
  emptyBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
