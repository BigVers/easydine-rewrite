# EasyDine — Rewritten Codebase

A multi-restaurant dining automation platform. Patron tablets (requestor devices) pair with waiter phones (receiver devices) via QR code, enabling digital ordering, service requests, and bill payment — all in real-time.

---

## Architecture

```
app/                        ← Expo Router screens
  _layout.tsx               ← Root: auth guard + providers + OneSignal bootstrap
  index.tsx                 ← Patron home: service request buttons
  login.tsx                 ← Staff login (waiters/managers)
  menu/
    index.tsx               ← Menu browser + cart + order placement
  pairing/
    GeneratePairing.tsx     ← Requestor: generates QR code
    PairDevices.tsx         ← Receiver: scans QR / manual code entry
  staff/
    WaiterDashboardGrid.tsx ← Waiter notification dashboard

lib/                        ← Business logic (pure services, contexts)
  types/index.ts            ← Single source of truth for all TS types
  supabase.ts               ← Supabase client singleton
  deviceService.ts          ← Device identity & registration
  pairingService.ts         ← QR generation, scanning, pairing lifecycle
  notificationService.ts    ← Push delivery, waiter grid, realtime subscription
  oneSignalManager.ts       ← OneSignal SDK wrapper
  AuthContext.tsx           ← Supabase auth for staff
  ThemeContext.tsx           ← Per-branch theming from DB

supabase/
  migrations/
    001_schema.sql          ← Full DB schema (run once)
  functions/
    send-notification/
      index.ts              ← Edge Function: OneSignal REST API proxy
```

---

## Device Roles

| Role | Device | Screen |
|------|--------|--------|
| Requestor | Patron tablet | `GeneratePairing`, `HomeScreen`, `MenuScreen` |
| Receiver | Waiter phone | `PairDevices`, `WaiterDashboardGrid` |

**Pairing rules:**
- 1 requestor ↔ 1 receiver (unique constraint in DB)
- 1 receiver ↔ N requestors (waiter serves multiple tables)
- QR codes expire after 2 hours
- Session closes when bill is paid → `deactivatePairing()`

---

## Setup

### 1. Prerequisites

- Node.js 20+
- [Expo CLI](https://docs.expo.dev/get-started/installation/)
- [EAS CLI](https://docs.expo.dev/eas/) — `npm install -g eas-cli`
- [Supabase CLI](https://supabase.com/docs/guides/cli) — `brew install supabase/tap/supabase`
- A Supabase project
- A OneSignal app

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_ANON_KEY, ONESIGNAL_APP_ID, BRANCH_ID
```

### 4. Run database migration

```bash
supabase link --project-ref your-project-ref
supabase db push
```

### 5. Set Edge Function secrets

```bash
supabase secrets set ONESIGNAL_REST_API_KEY=your-rest-api-key
supabase secrets set ONESIGNAL_APP_ID=your-onesignal-app-id
```

### 6. Deploy Edge Function

```bash
supabase functions deploy send-notification
```

### 7. Start development

```bash
npx expo start
```

---

## Building for Production

```bash
# Android
eas build --platform android --profile production

# iOS
eas build --platform ios --profile production
```

---

## Key Design Decisions

### Naming Consistency
The entire codebase uses `requestor` / `receiver` consistently. No more mixing with `patron/waiter/tablet/mobile` in code (the UI still shows user-friendly labels like "waiter").

### Security
OneSignal REST API key lives **only** in Supabase Edge Functions secrets. The client never sees it.

### Atomic Pairing
The `pair_device()` Postgres function handles the full pairing flow atomically: validate code → check expiry → check no existing pairing → create pairing → mark code used. No race conditions possible.

### Real-time Updates
`subscribeToWaiterNotifications()` opens a single Supabase Realtime channel per dashboard session, filtered to the active pairing IDs. It updates the waiter grid in-place without refetching everything.

### Per-Branch Theming
`ThemeContext` fetches `restaurant_customisations` (primary color, font, border radius) from Supabase on mount. Every screen gets the right brand look without any hardcoded colors.

---

## Adding a New Restaurant Branch

1. Insert a row into `restaurants` and `branches`
2. Insert a row into `restaurant_customisations` with brand colors/fonts
3. Insert menus, categories, and menu items
4. Build a new app binary with the branch's `EXPO_PUBLIC_BRANCH_ID` in `.env`
5. Distribute to that location's devices

---

## Notification Types

| Type | Trigger | Who sees it |
|------|---------|-------------|
| `NEW_ORDER` | Patron places order from menu | Waiter |
| `WAITER_REQUEST` | Patron taps "Call Waiter" | Waiter |
| `CONDIMENT_REQUEST` | Patron taps "Condiments" | Waiter |
| `BILL_REQUEST` | Patron taps "Request Bill" | Waiter |
| `ORDER_UPDATE` | Future: kitchen status updates | Patron |

---

## Troubleshooting

**Pairing fails with "Code not found or expired"**
→ QR codes expire after 2 hours. Have the patron generate a fresh code.

**Notifications not arriving**
→ Check OneSignal dashboard for delivery stats. Ensure device has notification permissions (`requestPermission()` is called on app start).

**Theme not loading**
→ Verify `EXPO_PUBLIC_BRANCH_ID` in `.env` matches a row in `restaurant_customisations`.

**Waiter dashboard empty**
→ Device must be paired before the dashboard shows any rows. Pair via `PairDevices` screen first.
