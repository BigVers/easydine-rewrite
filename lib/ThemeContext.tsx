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
// Fix: EXPO_PUBLIC_BRANCH_ID is now consumed here so that patron tablets
// (which never log in) correctly resolve a branchId — enabling the menu
// screen to scope its queries to the right branch.

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

// Patron tablets: branch from EXPO_PUBLIC_BRANCH_ID. Must be a real UUID — placeholders
// like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx cause Postgres 22P02 and break menu queries.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _rawEnvBranchId = process.env.EXPO_PUBLIC_BRANCH_ID?.trim() ?? '';
const ENV_BRANCH_ID = UUID_RE.test(_rawEnvBranchId) ? _rawEnvBranchId : null;

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
    // ── Debug log — remove once branch resolution is confirmed working ────────
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
      console.log(
        '[ThemeContext] Patron / env branch:',
        branchId ?? '(none — set EXPO_PUBLIC_BRANCH_ID to a real branch UUID or log in as staff)'
      );
    }

    if (branchId && !restaurantId) {
      // Resolve restaurant from branch so we can fetch the correct theme
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

    if (!restaurantId) {
      console.warn('[ThemeContext] No restaurantId resolved — rendering with default theme.');
      setIsLoading(false);
      return;
    }

    // ── Fetch customisation for this restaurant ───────────────────────────────
    const { data, error } = await supabase
      .from('restaurant_customisations')
      .select(
        'id, restaurant_id, primary_color, secondary_color, background_color, ' +
        'text_color, font_family, logo_url, banner_url, border_radius'
      )
      .eq('restaurant_id', restaurantId)
      .maybeSingle();

    if (error) {
      console.warn('[ThemeContext] Failed to fetch restaurant customisation:', error.message);
    }

    if (!error && data) {
      console.log('[ThemeContext] ✅ Theme loaded for restaurant:', restaurantId);
      setTheme(toAppTheme(data as unknown as RestaurantCustomisation));
    }

    setIsLoading(false);
  }, [authLoading, profile, propBranchId]);

  // FIX: only run fetchTheme after auth has finished loading.
  // Previously fetchTheme ran immediately (including while authLoading=true),
  // hit the early return, and sometimes never re-ran when authLoading settled.
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
