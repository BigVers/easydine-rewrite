// app/menu/index.tsx
// Food menu screen for the patron (requestor) device.
//
// Cart UX:
//   - Cart overlay auto-opens the moment the first item is added
//   - Overlay slides up from the bottom and sits ON TOP of the menu list
//     (not a separate screen — patron can still see menu behind it)
//   - "Done" collapses the overlay back so patron can keep browsing
//   - "Place Order" submits the order directly from the overlay
//   - Quantities and removals are editable inside the overlay

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
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
  id: string;
  name: string;
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
  const [cartOpen, setCartOpen] = useState(false);
  const [isLoadingMenu, setIsLoadingMenu] = useState(true);
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [pairingId, setPairingId] = useState<string | null>(null);
  const [tableName, setTableName] = useState<string>('');

  // Track whether cart was empty so we auto-open on first add
  const prevCartLength = useRef(0);

  // Slide animation for cart overlay
  const slideAnim = useRef(new Animated.Value(0)).current;

  const openCart = useCallback(() => {
    setCartOpen(true);
    Animated.spring(slideAnim, {
      toValue: 1,
      useNativeDriver: true,
      tension: 65,
      friction: 11,
    }).start();
  }, [slideAnim]);

  const closeCart = useCallback(() => {
    Animated.timing(slideAnim, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start(() => setCartOpen(false));
  }, [slideAnim]);

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

  // ── Load menu ─────────────────────────────────────────────────────────────

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

      const rows = data as unknown as ResolvedMenuItem[];
      setAllItems(rows);

      const seen = new Map<string, string>();
      for (const row of rows) {
        if (!seen.has(row.master_menu_id)) seen.set(row.master_menu_id, row.menu_name);
      }
      const tabs: MenuTab[] = Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
      setMenuTabs(tabs);
      if (tabs.length) setSelectedMenuId(tabs[0].id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load menu.';
      console.error('[MenuScreen] loadMenu error:', err);
      setMenuError(msg);
    } finally {
      setIsLoadingMenu(false);
    }
  }, [branchId]);

  useEffect(() => { loadMenu(); }, [loadMenu]);

  // ── Cart helpers ──────────────────────────────────────────────────────────

  const addToCart = useCallback((item: ResolvedMenuItem) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.master_menu_item_id === item.master_menu_item_id);
      const next = existing
        ? prev.map((c) =>
            c.master_menu_item_id === item.master_menu_item_id
              ? { ...c, quantity: c.quantity + 1 }
              : c
          )
        : [...prev, {
            master_menu_item_id: item.master_menu_item_id,
            name: item.name,
            unit_price: Number(item.effective_price),
            quantity: 1,
            menu_name: item.menu_name,
          }];

      // Auto-open overlay the first time an item is added
      if (prevCartLength.current === 0 && next.length > 0) {
        // Use setTimeout so state update finishes before animation
        setTimeout(() => openCart(), 50);
      }
      prevCartLength.current = next.length;
      return next;
    });
  }, [openCart]);

  const removeFromCart = useCallback((itemId: string) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.master_menu_item_id === itemId);
      if (!existing) return prev;
      const next = existing.quantity === 1
        ? prev.filter((c) => c.master_menu_item_id !== itemId)
        : prev.map((c) =>
            c.master_menu_item_id === itemId ? { ...c, quantity: c.quantity - 1 } : c
          );
      prevCartLength.current = next.length;
      // Close overlay if cart becomes empty
      if (next.length === 0) setTimeout(() => closeCart(), 50);
      return next;
    });
  }, [closeCart]);

  const deleteFromCart = useCallback((itemId: string) => {
    setCart((prev) => {
      const next = prev.filter((c) => c.master_menu_item_id !== itemId);
      prevCartLength.current = next.length;
      if (next.length === 0) setTimeout(() => closeCart(), 50);
      return next;
    });
  }, [closeCart]);

  const getQty = (itemId: string) =>
    cart.find((c) => c.master_menu_item_id === itemId)?.quantity ?? 0;

  // ── Place order ───────────────────────────────────────────────────────────

  const handlePlaceOrder = async () => {
    if (!cart.length) {
      Alert.alert('Empty Cart', 'Add at least one item before placing an order.');
      return;
    }
    if (!pairingId || !branchId) {
      Alert.alert('Not Paired', 'Your table is not paired with a waiter.',
        [{ text: 'OK' }, { text: 'Go Back', onPress: () => router.back() }]
      );
      return;
    }

    setIsPlacingOrder(true);
    try {
      const total = cartTotal(cart);

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

      const orderItemRows = cart.map((c) => ({
        order_id: order.id,
        menu_item_id: c.master_menu_item_id,
        master_menu_item_id: c.master_menu_item_id,
        branch_special_id: null,
        quantity: c.quantity,
        unit_price: c.unit_price,
        subtotal: c.unit_price * c.quantity,
      }));

      const { error: itemsErr } = await supabase.from('order_items').insert(orderItemRows);
      if (itemsErr) throw itemsErr;

      const itemSummary = cart.map((c) => `${c.quantity}× ${c.name}`).join(', ');
      await sendNotification({
        pairingId,
        notificationType: 'NEW_ORDER',
        message: `New order: ${itemSummary}`,
        metadata: { orderId: order.id },
      });

      setCart([]);
      prevCartLength.current = 0;
      closeCart();
      Alert.alert('✅ Order Placed!', 'Your waiter has been notified.',
        [{ text: 'Great!', onPress: () => router.back() }]
      );
    } catch (err) {
      Alert.alert('Error', 'Could not place order. Please try again.');
      console.error('[MenuScreen] Place order error:', err);
    } finally {
      setIsPlacingOrder(false);
    }
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const filteredItems = useMemo(
    () => allItems.filter((i) => i.master_menu_id === selectedMenuId),
    [allItems, selectedMenuId]
  );

  const cartItemCount = cart.reduce((n, c) => n + c.quantity, 0);

  const styles = useMemo(
    () => createStyles(theme.primaryColor, theme.borderRadius),
    [theme.primaryColor, theme.borderRadius]
  );

  // Cart overlay translate Y — slides up from bottom
  const cartTranslateY = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [400, 0],
  });

  // ── Loading / Error ───────────────────────────────────────────────────────

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

  // ── Render ────────────────────────────────────────────────────────────────

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
        {/* Cart icon — tapping reopens overlay if it was closed */}
        <TouchableOpacity
          style={styles.cartIconBtn}
          onPress={() => cartItemCount > 0 && openCart()}
        >
          <Text style={styles.cartIcon}>🛒</Text>
          {cartItemCount > 0 && (
            <View style={[styles.cartBadge, { backgroundColor: theme.primaryColor }]}>
              <Text style={styles.cartBadgeText}>{cartItemCount}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* ── Category tabs ── */}
      {menuTabs.length > 0 && (
        <View style={styles.tabContainer}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tabRow}
            bounces={false}
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
                  activeOpacity={0.75}
                >
                  <Text
                    style={[
                      styles.tabText,
                      active ? { color: '#fff' } : { color: theme.textColor },
                    ]}
                    numberOfLines={1}
                  >
                    {tab.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* ── Menu items list ── */}
      <FlatList
        data={filteredItems}
        keyExtractor={(item) => item.master_menu_item_id}
        contentContainerStyle={[
          styles.itemList,
          { paddingBottom: cartItemCount > 0 ? 32 : 32 },
        ]}
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
                <View style={[styles.itemImagePlaceholder, { backgroundColor: theme.primaryColor + '18' }]}>
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
                      style={[styles.addBtn, { backgroundColor: theme.primaryColor, borderRadius: theme.borderRadius }]}
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
                        <Text style={[styles.stepperBtnText, { color: theme.primaryColor }]}>−</Text>
                      </TouchableOpacity>
                      <Text style={[styles.stepperQty, { color: theme.textColor }]}>{qty}</Text>
                      <TouchableOpacity
                        style={[styles.stepperBtn, { borderColor: theme.primaryColor }]}
                        onPress={() => addToCart(item)}
                      >
                        <Text style={[styles.stepperBtnText, { color: theme.primaryColor }]}>+</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              </View>
            </View>
          );
        }}
      />

      {/* ── Backdrop — tapping outside collapses the overlay ── */}
      {cartOpen && (
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={closeCart}
        />
      )}

      {/* ── Persistent mini-bar — always visible when cart has items ── */}
      {cartItemCount > 0 && (
        <TouchableOpacity
          style={[styles.miniBar, { backgroundColor: theme.primaryColor }]}
          onPress={openCart}
          activeOpacity={0.85}
        >
          <View style={styles.miniBarLeft}>
            <View style={styles.miniBarBadge}>
              <Text style={styles.miniBarBadgeText}>{cartItemCount}</Text>
            </View>
            <Text style={styles.miniBarLabel}>
              {cartItemCount} item{cartItemCount !== 1 ? 's' : ''}
            </Text>
          </View>
          <Text style={styles.miniBarTotal}>{formatPrice(cartTotal(cart))}</Text>
        </TouchableOpacity>
      )}

      {/* ── Cart overlay (slides up over the menu list) ── */}
      {cartItemCount > 0 && (
        <Animated.View
          style={[
            styles.cartOverlay,
            { backgroundColor: theme.backgroundColor },
            { transform: [{ translateY: cartTranslateY }] },
          ]}
        >
          {/* Drag handle — also tappable to collapse */}
          <TouchableOpacity onPress={closeCart} activeOpacity={0.7}>
            <View style={styles.drawerHandleWrap}>
              <View style={styles.drawerHandle} />
            </View>
          </TouchableOpacity>

          {/* Overlay header */}
          <View style={styles.overlayHeader}>
            <Text style={[styles.overlayTitle, { color: theme.textColor }]}>
              Your Order
            </Text>
            <Text style={[styles.overlayCount, { color: theme.primaryColor }]}>
              {cartItemCount} item{cartItemCount !== 1 ? 's' : ''}
            </Text>
          </View>

          {/* Cart items */}
          <ScrollView style={styles.cartItems} showsVerticalScrollIndicator={false}>
            {cart.map((item) => (
              <View key={item.master_menu_item_id} style={styles.cartRow}>
                <View style={styles.cartRowInfo}>
                  <Text style={[styles.cartRowName, { color: theme.textColor }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={[styles.cartRowPrice, { color: theme.primaryColor }]}>
                    {formatPrice(item.unit_price * item.quantity)}
                  </Text>
                </View>

                <View style={styles.cartRowRight}>
                  <View style={styles.stepper}>
                    <TouchableOpacity
                      style={[styles.stepperBtn, { borderColor: theme.primaryColor }]}
                      onPress={() => removeFromCart(item.master_menu_item_id)}
                    >
                      <Text style={[styles.stepperBtnText, { color: theme.primaryColor }]}>−</Text>
                    </TouchableOpacity>
                    <Text style={[styles.stepperQty, { color: theme.textColor }]}>{item.quantity}</Text>
                    <TouchableOpacity
                      style={[styles.stepperBtn, { borderColor: theme.primaryColor }]}
                      onPress={() => {
                        const menuItem = allItems.find(
                          (i) => i.master_menu_item_id === item.master_menu_item_id
                        );
                        if (menuItem) addToCart(menuItem);
                      }}
                    >
                      <Text style={[styles.stepperBtnText, { color: theme.primaryColor }]}>+</Text>
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity
                    onPress={() => deleteFromCart(item.master_menu_item_id)}
                    style={styles.deleteBtn}
                  >
                    <Text style={styles.deleteBtnText}>🗑️</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </ScrollView>

          {/* Footer: total + Place Order */}
          <View style={[styles.overlayFooter, { borderTopColor: '#e8e8e8' }]}>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: theme.textColor }]}>Total</Text>
              <Text style={[styles.totalValue, { color: theme.primaryColor }]}>
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
        </Animated.View>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

function createStyles(primaryColor: string, borderRadius: number) {
  return StyleSheet.create({
    container: { flex: 1 },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, padding: 24 },

    // Header
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 16, paddingVertical: 12,
      borderBottomWidth: 1, borderBottomColor: '#e0e0e0',
    },
    backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
    backBtnText: { fontSize: 24, fontWeight: 'bold' },
    title: { fontSize: 20, fontWeight: 'bold' },
    cartIconBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
    cartIcon: { fontSize: 22 },
    cartBadge: {
      position: 'absolute', top: 0, right: 0,
      minWidth: 18, height: 18, borderRadius: 9,
      alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
    },
    cartBadgeText: { color: '#fff', fontSize: 11, fontWeight: 'bold' },

    // Category tabs
    tabContainer: {
      borderBottomWidth: 1, borderBottomColor: '#e8e8e8', backgroundColor: '#fff',
    },
    tabRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 8, alignItems: 'center' },
    tab: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 24, minWidth: 80, alignItems: 'center' },
    tabText: { fontSize: 13, fontWeight: '700', letterSpacing: 0.2 },

    // Item list
    itemList: { padding: 16, gap: 12 },
    emptyText: { textAlign: 'center', opacity: 0.5, marginTop: 32 },

    // Item card
    itemCard: {
      flexDirection: 'row', backgroundColor: '#fff', overflow: 'hidden',
      elevation: 2, shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3,
      marginBottom: 2,
    },
    itemImage: { width: 100, height: 110 },
    itemImagePlaceholder: { width: 100, height: 110, justifyContent: 'center', alignItems: 'center' },
    placeholderIcon: { fontSize: 32 },
    itemInfo: { flex: 1, padding: 12, gap: 4 },
    itemName: { fontSize: 15, fontWeight: '700' },
    itemDesc: { fontSize: 12, opacity: 0.65, lineHeight: 17 },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 },
    tag: { backgroundColor: '#e8f5e9', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
    tagText: { fontSize: 10, color: '#388e3c', fontWeight: '600' },
    itemFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
    itemPrice: { fontSize: 16, fontWeight: 'bold' },
    addBtn: { paddingHorizontal: 18, paddingVertical: 7 },
    addBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
    stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    stepperBtn: { width: 30, height: 30, borderWidth: 1.5, borderRadius: 15, justifyContent: 'center', alignItems: 'center' },
    stepperBtnText: { fontSize: 17, fontWeight: 'bold', lineHeight: 21 },
    stepperQty: { fontSize: 15, fontWeight: '700', minWidth: 22, textAlign: 'center' },

    // Backdrop — covers menu list behind open overlay, tap to dismiss
    backdrop: {
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.35)',
      zIndex: 1,
    },

    // Persistent mini-bar — always visible at bottom when cart has items
    miniBar: {
      position: 'absolute', bottom: 0, left: 0, right: 0,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 20, paddingVertical: 14,
      elevation: 8, shadowColor: '#000',
      shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.15, shadowRadius: 6,
      zIndex: 2,
    },
    miniBarLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    miniBarBadge: {
      backgroundColor: 'rgba(255,255,255,0.25)',
      width: 26, height: 26, borderRadius: 13,
      alignItems: 'center', justifyContent: 'center',
    },
    miniBarBadgeText: { color: '#fff', fontSize: 13, fontWeight: 'bold' },
    miniBarLabel: { color: '#fff', fontSize: 15, fontWeight: '700' },
    miniBarTotal: { color: '#fff', fontSize: 17, fontWeight: 'bold' },

    // Cart overlay — sits above mini-bar and backdrop
    cartOverlay: {
      position: 'absolute', bottom: 0, left: 0, right: 0,
      maxHeight: '62%',
      borderTopLeftRadius: 20, borderTopRightRadius: 20,
      elevation: 20, shadowColor: '#000',
      shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.2, shadowRadius: 10,
      zIndex: 3,
    },
    drawerHandleWrap: { alignItems: 'center', paddingVertical: 10 },
    drawerHandle: {
      width: 40, height: 4, backgroundColor: '#ddd', borderRadius: 2,
    },
    overlayHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 20, paddingBottom: 12,
      borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
    },
    overlayTitle: { fontSize: 17, fontWeight: '800' },
    overlayCount: { fontSize: 14, fontWeight: '600' },

    // Cart items inside overlay
    cartItems: { maxHeight: 220, paddingHorizontal: 20 },
    cartRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f5f5f5', gap: 10,
    },
    cartRowInfo: { flex: 1, gap: 2 },
    cartRowName: { fontSize: 14, fontWeight: '700' },
    cartRowPrice: { fontSize: 13, fontWeight: '600' },
    cartRowRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    deleteBtn: { padding: 4 },
    deleteBtnText: { fontSize: 18 },

    // Overlay footer
    overlayFooter: {
      paddingHorizontal: 20, paddingTop: 14, paddingBottom: 28,
      borderTopWidth: 1, gap: 12,
    },
    totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    totalLabel: { fontSize: 15, fontWeight: '600' },
    totalValue: { fontSize: 22, fontWeight: 'bold' },
    placeOrderBtn: { paddingVertical: 15, alignItems: 'center' },
    placeOrderBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
    btnDisabled: { opacity: 0.5 },

    // Error/loading
    loadingText: { marginTop: 12, fontSize: 15 },
    errorText: { color: '#D32F2F', fontSize: 15, textAlign: 'center' },
    retryBtn: { paddingHorizontal: 24, paddingVertical: 10, borderRadius: 8 },
    retryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
    backLink: { fontSize: 14, fontWeight: '600' },
  });
}
