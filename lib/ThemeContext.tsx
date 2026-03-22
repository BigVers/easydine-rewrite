// lib/ThemeContext.tsx
// Fetches per-restaurant theming from public.restaurant_customisations
// and exposes it via React context.
//
// Branch resolution priority (highest → lowest):
//   1. Logged-in user's branch_id from their user_profile
//   2. First active branch for the user's restaurant_id
//   3. EXPO_PUBLIC_BRANCH_ID env var  ← patron tablet path (no login)
//   4. Default theme (no restaurant configured)
//
// Schema note: restaurant_customisations is keyed by branch_id (UNIQUE),
// NOT restaurant_id — so we query by branch_id directly.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { supabase } from './supabase';
import { useAuth } from './AuthContext';
import type { AppTheme, RestaurantCustomisation } from './types';

// Read once at module load — safe for patron tablets that have no auth session.
// Validates UUID format before trusting the value — if the placeholder
// "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" or any other non-UUID value slips
// through, ENV_BRANCH_ID becomes null and the theme falls back to default
// gracefully instead of sending a malformed UUID to Supabase (error 22P02).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _rawEnvBranchId = process.env.EXPO_PUBLIC_BRANCH_ID ?? '';
const ENV_BRANCH_ID: string | null = UUID_RE.test(_rawEnvBranchId) ? _rawEnvBranchId : null;

if (!ENV_BRANCH_ID) {
  console.warn(
    '[ThemeContext] EXPO_PUBLIC_BRANCH_ID is missing or not a valid UUID:',
    JSON.stringify(_rawEnvBranchId),
    '\nSet a real branch UUID in your .env file and restart Metro.'
  );
}

const DEFAULT_THEME: AppTheme = {
  primaryColor: '#8B0000',
  secondaryColor: '#FFDEAD',
  backgroundColor: '#FFFFFF',
  textColor: '#212121',
  fontFamily: 'System',
  logoUrl: null,
  bannerUrl: null,
  borderRadius: 8,
};

function toAppTheme(c: RestaurantCustomisation): AppTheme {
  return {
    primaryColor:    c.primary_color,
    secondaryColor:  c.secondary_color,
    backgroundColor: c.background_color,
    textColor:       c.text_color,
    fontFamily:      c.font_family,
    logoUrl:         c.logo_url,
    bannerUrl:       c.banner_url,
    borderRadius:    c.border_radius,
  };
}

interface ThemeContextValue {
  theme: AppTheme;
  /** Resolved branch ID — used to scope menu/order queries */
  branchId: string | null;
  /** Resolved restaurant ID */
  restaurantId: string | null;
  /** true while the initial customisation fetch is in flight */
  isLoading: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  branchId: null,
  restaurantId: null,
  isLoading: true,
});

interface ThemeProviderProps {
  /** Legacy prop — ignored when a user is logged in or ENV_BRANCH_ID is set */
  branchId?: string;
  children: React.ReactNode;
}

export function ThemeProvider({ branchId: propBranchId, children }: ThemeProviderProps) {
  const { profile, isLoading: authLoading } = useAuth();

  const [theme, setTheme] = useState<AppTheme>(DEFAULT_THEME);
  const [resolvedBranchId, setResolvedBranchId] = useState<string | null>(null);
  const [resolvedRestaurantId, setResolvedRestaurantId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchTheme = useCallback(async () => {
    console.log('[ThemeContext] fetchTheme called. authLoading:', authLoading, '| profile:', profile?.restaurant_id ?? 'no profile');

    if (authLoading) return;

    let branchId: string | null = null;
    let restaurantId: string | null = null;

    // ── 1. Logged-in staff: use profile ──────────────────────────────────────
    if (profile?.restaurant_id) {
      restaurantId = profile.restaurant_id;

      if (profile.branch_id) {
        branchId = profile.branch_id;
      } else {
        const { data: firstBranch } = await supabase
          .from('branches')
          .select('id')
          .eq('restaurant_id', profile.restaurant_id)
          .eq('is_active', true)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();

        branchId = firstBranch?.id ?? null;
      }
    }

    // ── 2. Patron tablet: use EXPO_PUBLIC_BRANCH_ID ───────────────────────────
    if (!branchId) {
      branchId = ENV_BRANCH_ID ?? propBranchId ?? null;
      console.log('[ThemeContext] Using ENV_BRANCH_ID:', branchId);
    }

    // ── Resolve restaurant_id from branch if not already known ────────────────
    if (branchId && !restaurantId) {
      const { data: branch, error: branchErr } = await supabase
        .from('branches')
        .select('restaurant_id')
        .eq('id', branchId)
        .maybeSingle();

      console.log('[ThemeContext] Branch lookup → restaurant_id:', branch?.restaurant_id ?? 'NOT FOUND', branchErr?.message ?? '');
      restaurantId = branch?.restaurant_id ?? null;
    }

    setResolvedBranchId(branchId);
    setResolvedRestaurantId(restaurantId);

    if (!branchId) {
      console.warn('[ThemeContext] No branchId resolved — rendering with default theme.');
      setIsLoading(false);
      return;
    }

    // ── Fetch customisation by branch_id (schema uses branch_id as the key) ──
    // NOTE: the restaurant_customisations table has branch_id as its unique key,
    // NOT restaurant_id — so we must query by branch_id here.
    const { data, error } = await supabase
      .from('restaurant_customisations')
      .select(
        'id, primary_color, secondary_color, background_color, ' +
        'text_color, font_family, logo_url, banner_url, border_radius'
      )
      .eq('branch_id', branchId)
      .maybeSingle();

    if (error) {
      console.warn('[ThemeContext] Failed to fetch restaurant customisation:', error.message);
    }

    if (!error && data) {
      console.log('[ThemeContext] ✅ Theme loaded for branch:', branchId);
      setTheme(toAppTheme(data as unknown as RestaurantCustomisation));
    } else {
      console.log('[ThemeContext] No customisation row found for branch — using default theme.');
    }

    setIsLoading(false);
  }, [authLoading, profile, propBranchId]);

  // Only run fetchTheme after auth has finished loading
  useEffect(() => {
    if (!authLoading) {
      fetchTheme();
    }
  }, [authLoading, fetchTheme]);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        branchId: resolvedBranchId,
        restaurantId: resolvedRestaurantId,
        isLoading,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
