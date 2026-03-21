// lib/types/index.ts
// Single source of truth for all domain types

export type DeviceType = 'requestor' | 'receiver';

export type NotificationType =
  | 'NEW_ORDER'
  | 'BILL_REQUEST'
  | 'WAITER_REQUEST'
  | 'CONDIMENT_REQUEST'
  | 'ORDER_UPDATE';

export type OrderStatus =
  | 'pending' | 'confirmed' | 'preparing' | 'ready' | 'served' | 'cancelled';

export type BillStatus = 'OPEN' | 'PAID' | 'CANCELLED';

export type UserRole = 'waiter' | 'manager' | 'admin' | 'super_admin';

// ── Database row types ──────────────────────────────────────────────────────

export interface Restaurant {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  is_active: boolean;
  created_at: string;
}

export interface Branch {
  id: string;
  restaurant_id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  is_active: boolean;
}

export interface RestaurantCustomisation {
  id: string;
  restaurant_id: string;       // matches actual schema column
  primary_color: string;
  secondary_color: string;
  background_color: string;
  text_color: string;
  font_family: string;
  logo_url: string | null;
  banner_url: string | null;
  border_radius: number;
}

export interface Device {
  id: string;
  branch_id: string | null;
  device_name: string;
  device_type: DeviceType;
  onesignal_user_id: string | null;
  is_active: boolean;
  last_seen_at: string;
}

export interface PairingCode {
  id: string;
  requestor_id: string;
  code: string;
  qr_code_data: string;
  table_name: string;
  is_used: boolean;
  expires_at: string;
  created_at: string;
}

export interface Pairing {
  id: string;
  branch_id: string | null;
  requestor_id: string;
  receiver_id: string;
  table_name: string;
  is_active: boolean;
  paired_at: string;
  unpaired_at: string | null;
}

export interface Notification {
  id: string;
  pairing_id: string;
  notification_type: NotificationType;
  message: string;
  is_actioned: boolean;
  actioned_at: string | null;
  actioned_by: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface Category {
  id: string;
  name?: string;
  sort_order?: number;
}

export interface MenuItem {
  id: string;
  menu_id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  price: number;
  image_url: string | null;
  is_available: boolean;
  is_addon: boolean;
  allergens: string[] | null;
  dietary_tags: string[] | null;
  display_order: number;
}

export interface Condiment {
  id: string;
  branch_id: string;
  name: string;
  description: string | null;
  price: number;
  is_available: boolean;
}

export interface OrderItemCondiment {
  condiment_id: string;
  name: string;
  unit_price: number;
  quantity: number;
}

export interface OrderItemExtra {
  id: string;
  name: string;
  unit_price: number;
  quantity: number;
}

export interface CartItem {
  menu_item_id: string;
  name: string;
  unit_price: number;
  quantity: number;
  condiments: OrderItemCondiment[];
  extras: OrderItemExtra[];
}

// ── View / composite types ──────────────────────────────────────────────────

/** A row in the waiter dashboard grid */
export interface WaiterGridRow {
  pairingId: string;
  tableName: string;
  latestNotificationId: string | null;
  notificationType: NotificationType | null;
  requestMade: string;
  isActioned: boolean;
}

/** Theme token set derived from RestaurantCustomisation */
export interface AppTheme {
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  logoUrl: string | null;     // restaurant logo — show in headers
  bannerUrl: string | null;   // hero banner — show on patron home screen
  borderRadius: number;
}
