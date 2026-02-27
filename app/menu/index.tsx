// app/menu/index.tsx
// Patron-facing menu browser.
// Loads categories + items for the branch, allows adding to cart,
// and sends a NEW_ORDER notification when the order is placed.

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

import { supabase } from '../../lib/supabase';
import { useTheme } from '../../lib/ThemeContext';
import { sendNotification } from '../../lib/notificationService';
import { getActivePairingId } from '../../lib/pairingService';
import type { CartItem, Category, MenuItem } from '../../lib/types';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MenuData {
  categories: Category[];
  itemsByCategory: Record<string, MenuItem[]>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cartTotal(cart: CartItem[]): number {
  return cart.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
}

function cartCount(cart: CartItem[]): number {
  return cart.reduce((sum, item) => sum + item.quantity, 0);
}

function formatPrice(cents: number): string {
  return `R ${(cents / 100).toFixed(2)}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function MenuScreen() {
  const router = useRouter();
  const { theme, branchId } = useTheme();

  const [menuData, setMenuData] = useState<MenuData | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);

  // ── Fetch menu data ───────────────────────────────────────────────────────

  const loadMenu = useCallback(async () => {
    if (!branchId) return;
    setIsLoading(true);
    try {
      // Fetch all menu items with their category info for this branch
      const { data, error } = await supabase
        .from('menu_items')
        .select(`
          id, name, description, price_cents, image_url, is_available,
          categories!inner (
            id, name, sort_order,
            menus!inner ( branch_id )
          )
        `)
        .eq('categories.menus.branch_id', branchId)
        .eq('is_available', true)
        .order('name');

      if (error) throw error;

      // Group by category
      const categoryMap = new Map<string, Category>();
      const itemMap: Record<string, MenuItem[]> = {};

      for (const row of data ?? []) {
        const cat = row.categories as unknown as Category;
        if (!categoryMap.has(cat.id)) {
          categoryMap.set(cat.id, cat);
          itemMap[cat.id] = [];
        }
        itemMap[cat.id].push({
          id: row.id,
          menu_id: '',
          category_id: cat.id,
          name: row.name,
          description: row.description,
          price: row.price_cents,
          image_url: row.image_url,
          is_available: row.is_available,
          is_addon: false,
          allergens: null,
          dietary_tags: null,
          display_order: 0,
        });
      }

      const categories = [...categoryMap.values()].sort(
        (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
      );

      setMenuData({ categories, itemsByCategory: itemMap });
      setSelectedCategoryId(categories[0]?.id ?? null);
    } catch (err) {
      Alert.alert('Error', 'Could not load the menu. Please try again.');
      console.error('[MenuScreen] loadMenu error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    loadMenu();
  }, [loadMenu]);

  // ── Cart management ───────────────────────────────────────────────────────

  const addToCart = useCallback((item: MenuItem) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.menu_item_id === item.id);
      if (existing) {
        return prev.map((c) =>
          c.menu_item_id === item.id ? { ...c, quantity: c.quantity + 1 } : c
        );
      }
      return [
        ...prev,
        {
          menu_item_id: item.id,
          name: item.name,
          unit_price: item.price,
          quantity: 1,
          condiments: [],
          extras: [],
        },
      ];
    });
  }, []);

  const removeFromCart = useCallback((itemId: string) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.menu_item_id === itemId);
      if (!existing) return prev;
      if (existing.quantity === 1) return prev.filter((c) => c.menu_item_id !== itemId);
      return prev.map((c) =>
        c.menu_item_id === itemId ? { ...c, quantity: c.quantity - 1 } : c
      );
    });
  }, []);

  const getQuantity = useCallback(
    (itemId: string) => cart.find((c) => c.menu_item_id === itemId)?.quantity ?? 0,
    [cart]
  );

  // ── Place order ───────────────────────────────────────────────────────────

  const handlePlaceOrder = async () => {
    if (cart.length === 0) {
      Alert.alert('Empty Cart', 'Add items to your order first.');
      return;
    }

    const pairingId = await getActivePairingId();
    if (!pairingId) {
      Alert.alert(
        'Not Paired',
        'Your table is not paired with a waiter. Please scan the QR code again.'
      );
      return;
    }

    setIsPlacingOrder(true);
    try {
      const summary = cart
        .map((c) => `${c.quantity}× ${c.name}`)
        .join(', ');

      await sendNotification({
        pairingId,
        notificationType: 'NEW_ORDER',
        message: summary,
        metadata: { items: cart, total: cartTotal(cart) },
      });

      setCart([]);
      Alert.alert('Order Placed!', 'Your waiter has been notified.');
    } catch (err) {
      Alert.alert('Error', 'Could not place your order. Please try again.');
    } finally {
      setIsPlacingOrder(false);
    }
  };

  // ── Visible items ─────────────────────────────────────────────────────────

  const visibleItems = useMemo(
    () => (selectedCategoryId ? (menuData?.itemsByCategory[selectedCategoryId] ?? []) : []),
    [menuData, selectedCategoryId]
  );

  const styles = createStyles(theme.primaryColor, theme.borderRadius);

  // ── Render ────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.backgroundColor }]}>
        <ActivityIndicator size="large" color={theme.primaryColor} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.backgroundColor }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={[styles.backBtnText, { color: theme.primaryColor }]}>←</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.textColor, fontFamily: theme.fontFamily }]}>
          Menu
        </Text>
        {/* Cart badge */}
        <TouchableOpacity
          style={[styles.cartBtn, { backgroundColor: theme.primaryColor }]}
          onPress={() => router.push('/menu/cart')}
        >
          <Text style={styles.cartBtnText}>
            🛒 {cartCount(cart)} · {formatPrice(cartTotal(cart))}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Category tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabs}
      >
        {menuData?.categories.map((cat) => (
          <TouchableOpacity
            key={cat.id}
            style={[
              styles.tab,
              selectedCategoryId === cat.id && {
                backgroundColor: theme.primaryColor,
                borderColor: theme.primaryColor,
              },
            ]}
            onPress={() => setSelectedCategoryId(cat.id)}
          >
            <Text
              style={[
                styles.tabText,
                { color: selectedCategoryId === cat.id ? '#fff' : theme.textColor },
              ]}
            >
              {cat.name}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Item list */}
      <FlatList
        data={visibleItems}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          const qty = getQuantity(item.id);
          return (
            <View style={[styles.itemCard, { borderRadius: theme.borderRadius }]}>
              {item.image_url && (
                <Image source={{ uri: item.image_url }} style={styles.itemImage} />
              )}
              <View style={styles.itemInfo}>
                <Text style={[styles.itemName, { color: theme.textColor }]}>{item.name}</Text>
                {item.description && (
                  <Text style={[styles.itemDesc, { color: theme.textColor }]} numberOfLines={2}>
                    {item.description}
                  </Text>
                )}
                <Text style={[styles.itemPrice, { color: theme.primaryColor }]}>
                  {formatPrice(item.price)}
                </Text>
              </View>

              {/* Quantity stepper */}
              <View style={styles.stepper}>
                {qty > 0 && (
                  <>
                    <TouchableOpacity
                      style={[styles.stepBtn, { borderColor: theme.primaryColor }]}
                      onPress={() => removeFromCart(item.id)}
                    >
                      <Text style={[styles.stepBtnText, { color: theme.primaryColor }]}>−</Text>
                    </TouchableOpacity>
                    <Text style={[styles.stepQty, { color: theme.textColor }]}>{qty}</Text>
                  </>
                )}
                <TouchableOpacity
                  style={[styles.stepBtn, { backgroundColor: theme.primaryColor, borderColor: theme.primaryColor }]}
                  onPress={() => addToCart(item)}
                >
                  <Text style={[styles.stepBtnText, { color: '#fff' }]}>+</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <Text style={[styles.emptyText, { color: theme.textColor }]}>
            No items in this category.
          </Text>
        }
      />

      {/* Place Order bar */}
      {cart.length > 0 && (
        <View style={styles.orderBar}>
          <TouchableOpacity
            style={[
              styles.orderBtn,
              { backgroundColor: theme.primaryColor, borderRadius: theme.borderRadius },
              isPlacingOrder && styles.btnDisabled,
            ]}
            onPress={handlePlaceOrder}
            disabled={isPlacingOrder}
          >
            {isPlacingOrder ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.orderBtnText}>
                Place Order · {formatPrice(cartTotal(cart))}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function createStyles(primaryColor: string, borderRadius: number) {
  return StyleSheet.create({
    container: { flex: 1 },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
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
    cartBtn: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 20,
    },
    cartBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },

    // Category tabs
    tabs: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
    tab: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: '#ccc',
    },
    tabText: { fontSize: 13, fontWeight: '600' },

    // Item cards
    list: { padding: 16, gap: 12, paddingBottom: 100 },
    itemCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#fff',
      padding: 12,
      elevation: 2,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.1,
      shadowRadius: 2,
      gap: 12,
    },
    itemImage: { width: 72, height: 72, borderRadius: 8 },
    itemInfo: { flex: 1 },
    itemName: { fontSize: 15, fontWeight: '600', marginBottom: 4 },
    itemDesc: { fontSize: 12, opacity: 0.7, marginBottom: 6 },
    itemPrice: { fontSize: 14, fontWeight: '700' },

    stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    stepBtn: {
      width: 32,
      height: 32,
      borderRadius: 16,
      borderWidth: 2,
      justifyContent: 'center',
      alignItems: 'center',
    },
    stepBtnText: { fontSize: 18, fontWeight: 'bold', lineHeight: 20 },
    stepQty: { fontSize: 15, fontWeight: '600', minWidth: 20, textAlign: 'center' },

    emptyText: { textAlign: 'center', marginTop: 40, opacity: 0.6, fontSize: 14 },

    // Order bar
    orderBar: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      padding: 16,
      backgroundColor: 'rgba(255,255,255,0.95)',
      borderTopWidth: 1,
      borderTopColor: '#e0e0e0',
    },
    orderBtn: { paddingVertical: 16, alignItems: 'center' },
    orderBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
    btnDisabled: { opacity: 0.5 },
  });
}
