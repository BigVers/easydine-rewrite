// app/menu/index.tsx
// Food menu screen for the patron (requestor) device.
//
// Data source: the `resolved_menu_items` Postgres view which joins
// master_menus + master_menu_items + branch-level price overrides
// into a single flat query scoped by branch_id.
//
// The view's `master_menu_id` / `menu_name` columns act as the category
// grouping — each distinct menu (Burgers, Chicken, Starters, etc.) becomes
// a tab in the UI. There is no separate categories table.
//
// Key columns used:
//   branch_id            — filter to the current branch
//   master_menu_id       — groups items into menu tabs
//   menu_name            — tab label
//   master_menu_item_id  — unique item ID
//   name                 — item display name
//   description          — item description
//   image_url            — item image
//   effective_price      — price to display (respects branch overrides)
//   is_available         — filter out unavailable items
//   is_addon             — filter out add-ons from main list
//   dietary_tags         — green tag chips
//   display_order        — sort order within a menu

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '../../lib/ThemeContext';
import { supabase } from '../../lib/supabase';
import { getActivePairingId } from '../../lib/pairingService';
import { sendNotification } from '../../lib/notificationService';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ResolvedMenuItem {
  branch_id: string;
  restaurant_id: string;
  master_menu_id: string;
  menu_name: string;
  master_menu_item_id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  is_addon: boolean;
  allergens: string[] | null;
  dietary_tags: string[] | null;
  display_order: number;
  effective_price: number;
  is_available: boolean;
}

interface MenuTab {
  id: string;   // master_menu_id
  name: string; // menu_name
}

interface CartItem {
  master_menu_item_id: string;
  name: string;
  unit_price: number;
  quantity: number;
  menu_name: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPrice(amount: number): string {
  return `R${Number(amount).toFixed(2)}`;
}

function cartTotal(cart: CartItem[]): number {
  return cart.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function MenuScreen() {
  const router = useRouter();
  const { theme, branchId } = useTheme();

  const [allItems, setAllItems] = useState<ResolvedMenuItem[]>([]);
  const [menuTabs, setMenuTabs] = useState<MenuTab[]>([]);
  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isLoadingMenu, setIsLoadingMenu] = useState(true);
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [pairingId, setPairingId] = useState<string | null>(null);
  const [tableName, setTableName] = useState<string>('');

  // ── Load pairing info ─────────────────────────────────────────────────────

  useEffect(() => {
    getActivePairingId().then(async (id) => {
      setPairingId(id);
      if (id) {
        const { data } = await supabase
          .from('pairings')
          .select('table_name')
          .eq('id', id)
          .maybeSingle();
        setTableName(data?.table_name ?? '');
      }
    });
  }, []);

  // ── Load menu from resolved_menu_items view ───────────────────────────────

  const loadMenu = useCallback(async () => {
    if (!branchId) {
      setMenuError('No branch configured. Please contact staff.');
      setIsLoadingMenu(false);
      return;
    }

    setIsLoadingMenu(true);
    setMenuError(null);

    try {
      const { data, error } = await supabase
        .from('resolved_menu_items')
        .select(
          'branch_id, restaurant_id, master_menu_id, menu_name, ' +
          'master_menu_item_id, name, description, image_url, ' +
          'is_addon, allergens, dietary_tags, display_order, ' +
          'effective_price, is_available'
        )
        .eq('branch_id', branchId)
        .eq('is_available', true)
        .eq('is_addon', false)
        .order('menu_name', { ascending: true })
        .order('display_order', { ascending: true });

      if (error) throw error;

      if (!data?.length) {
        setMenuError('No menu items found for this location.');
        setIsLoadingMenu(false);
        return;
      }

      // View not in generated DB types → Supabase infers a loose row type; assert after successful query.
      const rows = (data ?? []) as unknown as ResolvedMenuItem[];
      setAllItems(rows);

      // Derive unique menu tabs from the data, preserving first-seen order
      const seen = new Map<string, string>();
      for (const row of rows) {
        if (!seen.has(row.master_menu_id)) {
          seen.set(row.master_menu_id, row.menu_name);
        }
      }
      const tabs: MenuTab[] = Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
      setMenuTabs(tabs);
      if (tabs.length) setSelectedMenuId(tabs[0].id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load menu.';
      console.error('[MenuScreen] Load error:', err);
      setMenuError(msg);
    } finally {
      setIsLoadingMenu(false);
    }
  }, [branchId]);

  useEffect(() => {
    loadMenu();
  }, [loadMenu]);

  // ── Cart helpers ──────────────────────────────────────────────────────────

  const addToCart = (item: ResolvedMenuItem) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.master_menu_item_id === item.master_menu_item_id);
      if (existing) {
        return prev.map((c) =>
          c.master_menu_item_id === item.master_menu_item_id
            ? { ...c, quantity: c.quantity + 1 }
            : c
        );
      }
      return [
        ...prev,
        {
          master_menu_item_id: item.master_menu_item_id,
          name: item.name,
          unit_price: Number(item.effective_price),
          quantity: 1,
          menu_name: item.menu_name,
        },
      ];
    });
  };

  const removeFromCart = (itemId: string) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.master_menu_item_id === itemId);
      if (!existing) return prev;
      if (existing.quantity === 1) return prev.filter((c) => c.master_menu_item_id !== itemId);
      return prev.map((c) =>
        c.master_menu_item_id === itemId ? { ...c, quantity: c.quantity - 1 } : c
      );
    });
  };

  const getQty = (itemId: string) =>
    cart.find((c) => c.master_menu_item_id === itemId)?.quantity ?? 0;

  // ── Place order ───────────────────────────────────────────────────────────

  const handlePlaceOrder = async () => {
    if (!cart.length) {
      Alert.alert('Empty Cart', 'Add at least one item before placing an order.');
      return;
    }
    if (!pairingId || !branchId) {
      Alert.alert(
        'Not Paired',
        'Your table is not paired with a waiter. Please go back and generate a QR code.',
        [{ text: 'OK' }, { text: 'Go Back', onPress: () => router.back() }]
      );
      return;
    }

    setIsPlacingOrder(true);
    try {
      const total = cartTotal(cart);

      // Insert the order
      const { data: order, error: orderErr } = await supabase
        .from('orders')
        .insert({
          pairing_id: pairingId,
          branch_id: branchId,
          table_name: tableName || 'Unknown Table',
          status: 'pending',
          total_amount: total,
        })
        .select('id')
        .single();

      if (orderErr) throw orderErr;

      // Insert order_items — one row per cart item
      // menu_item_id is NOT NULL so we pass the same ID to satisfy that constraint.
      // master_menu_item_id must be set and branch_special_id must be NULL to
      // satisfy the XOR check constraint chk_order_item_source.
      const orderItemRows = cart.map((c) => ({
        order_id: order.id,
        menu_item_id: c.master_menu_item_id,         // NOT NULL — use same ID
        master_menu_item_id: c.master_menu_item_id,  // satisfies chk_order_item_source
        branch_special_id: null,                     // explicitly NULL — satisfies XOR
        quantity: c.quantity,
        unit_price: c.unit_price,
        subtotal: c.unit_price * c.quantity,
      }));

      const { error: itemsErr } = await supabase
        .from('order_items')
        .insert(orderItemRows);

      if (itemsErr) throw itemsErr;

      // Notify the paired waiter
      const itemSummary = cart.map((c) => `${c.quantity}× ${c.name}`).join(', ');
      await sendNotification({
        pairingId,
        notificationType: 'NEW_ORDER',
        message: `New order: ${itemSummary}`,
        metadata: { orderId: order.id },
      });

      setCart([]);
      Alert.alert(
        '✅ Order Placed!',
        'Your waiter has been notified and will be with you shortly.',
        [{ text: 'Great!' , onPress: () => router.back() }]
      );
    } catch (err) {
      Alert.alert('Error', 'Could not place order. Please try again.');
      console.error('[MenuScreen] Place order error:', err);
    } finally {
      setIsPlacingOrder(false);
    }
  };

  // ── Derived data ──────────────────────────────────────────────────────────

  const filteredItems = useMemo(
    () => allItems.filter((i) => i.master_menu_id === selectedMenuId),
    [allItems, selectedMenuId]
  );

  const cartItemCount = cart.reduce((n, c) => n + c.quantity, 0);

  const styles = useMemo(
    () => createStyles(theme.primaryColor, theme.borderRadius),
    [theme.primaryColor, theme.borderRadius]
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (isLoadingMenu) {
    return (
      <View style={[styles.center, { backgroundColor: theme.backgroundColor }]}>
        <ActivityIndicator size="large" color={theme.primaryColor} />
        <Text style={[styles.loadingText, { color: theme.textColor }]}>Loading menu…</Text>
      </View>
    );
  }

  if (menuError) {
    return (
      <View style={[styles.center, { backgroundColor: theme.backgroundColor }]}>
        <Text style={styles.errorText}>{menuError}</Text>
        <TouchableOpacity
          style={[styles.retryBtn, { backgroundColor: theme.primaryColor }]}
          onPress={loadMenu}
        >
          <Text style={styles.retryBtnText}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 12 }}>
          <Text style={[styles.backLink, { color: theme.primaryColor }]}>← Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.backgroundColor }]}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={[styles.backBtnText, { color: theme.primaryColor }]}>←</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.textColor, fontFamily: theme.fontFamily }]}>
          Menu
        </Text>
        <View style={styles.cartBtn}>
          <Text style={styles.cartIcon}>🛒</Text>
          {cartItemCount > 0 && (
            <View style={[styles.cartBadge, { backgroundColor: theme.primaryColor }]}>
              <Text style={styles.cartBadgeText}>{cartItemCount}</Text>
            </View>
          )}
        </View>
      </View>

      {/* ── Menu tabs (one per master_menu) ── */}
      {menuTabs.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabRow}
        >
          {menuTabs.map((tab) => {
            const active = selectedMenuId === tab.id;
            return (
              <TouchableOpacity
                key={tab.id}
                style={[
                  styles.tab,
                  active
                    ? { backgroundColor: theme.primaryColor }
                    : { backgroundColor: '#f0f0f0' },
                ]}
                onPress={() => setSelectedMenuId(tab.id)}
              >
                <Text
                  style={[
                    styles.tabText,
                    active ? { color: '#fff' } : { color: theme.textColor },
                  ]}
                >
                  {tab.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* ── Item list ── */}
      <FlatList
        data={filteredItems}
        keyExtractor={(item) => item.master_menu_item_id}
        contentContainerStyle={styles.itemList}
        ListEmptyComponent={
          <Text style={[styles.emptyText, { color: theme.textColor }]}>
            No items in this section.
          </Text>
        }
        renderItem={({ item }) => {
          const qty = getQty(item.master_menu_item_id);
          return (
            <View style={[styles.itemCard, { borderRadius: theme.borderRadius }]}>
              {item.image_url ? (
                <Image source={{ uri: item.image_url }} style={styles.itemImage} />
              ) : (
                <View
                  style={[
                    styles.itemImagePlaceholder,
                    { backgroundColor: theme.primaryColor + '20' },
                  ]}
                >
                  <Text style={styles.placeholderIcon}>🍽️</Text>
                </View>
              )}

              <View style={styles.itemInfo}>
                <Text style={[styles.itemName, { color: theme.textColor }]}>{item.name}</Text>

                {item.description ? (
                  <Text style={[styles.itemDesc, { color: theme.textColor }]} numberOfLines={2}>
                    {item.description}
                  </Text>
                ) : null}

                {item.dietary_tags?.length ? (
                  <View style={styles.tagRow}>
                    {item.dietary_tags.map((tag) => (
                      <View key={tag} style={styles.tag}>
                        <Text style={styles.tagText}>{tag}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}

                <View style={styles.itemFooter}>
                  <Text style={[styles.itemPrice, { color: theme.primaryColor }]}>
                    {formatPrice(item.effective_price)}
                  </Text>

                  {qty === 0 ? (
                    <TouchableOpacity
                      style={[
                        styles.addBtn,
                        {
                          backgroundColor: theme.primaryColor,
                          borderRadius: theme.borderRadius,
                        },
                      ]}
                      onPress={() => addToCart(item)}
                    >
                      <Text style={styles.addBtnText}>Add</Text>
                    </TouchableOpacity>
                  ) : (
                    <View style={styles.stepper}>
                      <TouchableOpacity
                        style={[styles.stepperBtn, { borderColor: theme.primaryColor }]}
                        onPress={() => removeFromCart(item.master_menu_item_id)}
                      >
                        <Text style={[styles.stepperBtnText, { color: theme.primaryColor }]}>
                          −
                        </Text>
                      </TouchableOpacity>
                      <Text style={[styles.stepperQty, { color: theme.textColor }]}>{qty}</Text>
                      <TouchableOpacity
                        style={[styles.stepperBtn, { borderColor: theme.primaryColor }]}
                        onPress={() => addToCart(item)}
                      >
                        <Text style={[styles.stepperBtnText, { color: theme.primaryColor }]}>
                          +
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              </View>
            </View>
          );
        }}
      />

      {/* ── Sticky cart bar ── */}
      {cart.length > 0 && (
        <View style={styles.cartBar}>
          <View>
            <Text style={[styles.cartBarItems, { color: theme.textColor }]}>
              {cartItemCount} item{cartItemCount !== 1 ? 's' : ''}
            </Text>
            <Text style={[styles.cartBarTotal, { color: theme.primaryColor }]}>
              {formatPrice(cartTotal(cart))}
            </Text>
          </View>
          <TouchableOpacity
            style={[
              styles.placeOrderBtn,
              { backgroundColor: theme.primaryColor, borderRadius: theme.borderRadius },
              isPlacingOrder && styles.btnDisabled,
            ]}
            onPress={handlePlaceOrder}
            disabled={isPlacingOrder}
          >
            {isPlacingOrder ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.placeOrderBtnText}>Place Order</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

function createStyles(primaryColor: string, borderRadius: number) {
  return StyleSheet.create({
    container: { flex: 1 },
    center: {
      flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, padding: 24,
    },

    // Header
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 16, paddingVertical: 12,
      borderBottomWidth: 1, borderBottomColor: '#e0e0e0',
    },
    backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
    backBtnText: { fontSize: 24, fontWeight: 'bold' },
    title: { fontSize: 20, fontWeight: 'bold' },
    cartBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
    cartIcon: { fontSize: 22 },
    cartBadge: {
      position: 'absolute', top: 2, right: 2,
      minWidth: 16, height: 16, borderRadius: 8,
      alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
    },
    cartBadgeText: { color: '#fff', fontSize: 10, fontWeight: 'bold' },

    // Menu tabs
    tabRow: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
    tab: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
    tabText: { fontSize: 14, fontWeight: '600' },

    // Item list
    itemList: { padding: 16, gap: 12, paddingBottom: 120 },
    emptyText: { textAlign: 'center', opacity: 0.5, marginTop: 32 },

    // Item card
    itemCard: {
      flexDirection: 'row', backgroundColor: '#fff', overflow: 'hidden',
      elevation: 2, shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3,
    },
    itemImage: { width: 100, height: 100 },
    itemImagePlaceholder: {
      width: 100, height: 100, justifyContent: 'center', alignItems: 'center',
    },
    placeholderIcon: { fontSize: 32 },
    itemInfo: { flex: 1, padding: 12, gap: 4 },
    itemName: { fontSize: 15, fontWeight: '700' },
    itemDesc: { fontSize: 12, opacity: 0.65, lineHeight: 16 },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 },
    tag: {
      backgroundColor: '#e8f5e9', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
    },
    tagText: { fontSize: 10, color: '#388e3c', fontWeight: '600' },
    itemFooter: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6,
    },
    itemPrice: { fontSize: 16, fontWeight: 'bold' },
    addBtn: { paddingHorizontal: 16, paddingVertical: 6 },
    addBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
    stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    stepperBtn: {
      width: 28, height: 28, borderWidth: 1.5, borderRadius: 14,
      justifyContent: 'center', alignItems: 'center',
    },
    stepperBtnText: { fontSize: 16, fontWeight: 'bold', lineHeight: 20 },
    stepperQty: { fontSize: 15, fontWeight: '700', minWidth: 20, textAlign: 'center' },

    // Cart bar
    cartBar: {
      position: 'absolute', bottom: 0, left: 0, right: 0,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      padding: 16, backgroundColor: '#fff',
      borderTopWidth: 1, borderTopColor: '#e0e0e0',
      elevation: 8, shadowColor: '#000',
      shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.1, shadowRadius: 4,
    },
    cartBarItems: { fontSize: 13, opacity: 0.7 },
    cartBarTotal: { fontSize: 18, fontWeight: 'bold' },
    placeOrderBtn: { paddingHorizontal: 24, paddingVertical: 12 },
    placeOrderBtnText: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
    btnDisabled: { opacity: 0.5 },

    // Error / loading
    loadingText: { marginTop: 12, fontSize: 15 },
    errorText: { color: '#D32F2F', fontSize: 15, textAlign: 'center' },
    retryBtn: { paddingHorizontal: 24, paddingVertical: 10, borderRadius: 8 },
    retryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
    backLink: { fontSize: 14, fontWeight: '600' },
  });
}
