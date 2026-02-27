// lib/ThemeContext.tsx
// Fetches per-branch theming from Supabase and exposes it via React context.
// This makes every restaurant "look" like its own physical menu.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { supabase } from './supabase';
import type { AppTheme, RestaurantCustomisation } from './types';

const DEFAULT_THEME: AppTheme = {
  primaryColor: '#8B0000',
  secondaryColor: '#FFDEAD',
  backgroundColor: '#FFFFFF',
  textColor: '#212121',
  fontFamily: 'System',
  borderRadius: 8,
};

function toAppTheme(c: RestaurantCustomisation): AppTheme {
  return {
    primaryColor: c.primary_color,
    secondaryColor: c.secondary_color,
    backgroundColor: c.background_color,
    textColor: c.text_color,
    fontFamily: c.font_family,
    borderRadius: c.border_radius,
  };
}

interface ThemeContextValue {
  theme: AppTheme;
  /** Branch ID for the current menu/session; used for data queries */
  branchId: string | null;
  /** true while the initial theme is being fetched */
  isLoading: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  branchId: null,
  isLoading: true,
});

interface ThemeProviderProps {
  branchId: string;
  children: React.ReactNode;
}

export function ThemeProvider({ branchId, children }: ThemeProviderProps) {
  const [theme, setTheme] = useState<AppTheme>(DEFAULT_THEME);
  const [isLoading, setIsLoading] = useState(true);

  const fetchTheme = useCallback(async () => {
    if (!branchId) {
      setIsLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('restaurant_customisations')
      .select('*')
      .eq('branch_id', branchId)
      .maybeSingle();

    if (!error && data) {
      setTheme(toAppTheme(data as RestaurantCustomisation));
    }
    setIsLoading(false);
  }, [branchId]);

  useEffect(() => {
    fetchTheme();
  }, [fetchTheme]);

  return (
    <ThemeContext.Provider value={{ theme, branchId, isLoading }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
