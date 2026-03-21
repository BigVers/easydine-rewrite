// lib/AuthContext.tsx
// Authentication context for restaurant staff (waiters, managers, admins).
// Patrons do NOT log in — they use the app as a guest (requestor device).
//
// After a successful sign-in the context exposes the resolved profile so
// any screen can call `signIn` and then navigate based on role:
//   - waiter / manager / admin → /notifications (WaiterDashboard)
//   - super_admin              → /notifications (or future admin panel)

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { supabase } from './supabase';
import type { Session } from '@supabase/supabase-js';
import type { UserRole } from './types';

export interface UserProfile {
  id: string;
  full_name: string;
  email: string;
  role: UserRole;
  branch_id: string | null;
  restaurant_id: string | null;
}

interface AuthContextValue {
  session: Session | null;
  profile: UserProfile | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<UserProfile>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  profile: null,
  isLoading: true,
  signIn: async () => { throw new Error('AuthContext not initialised'); },
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchProfile = useCallback(async (userId: string): Promise<UserProfile | null> => {
    const { data } = await supabase
      .from('user_profiles')
      .select('id, full_name, email, role, branch_id, restaurant_id')
      .eq('id', userId)
      .single();
    const p = data as UserProfile | null;
    setProfile(p);
    return p;
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      if (s?.user) {
        fetchProfile(s.user.id).finally(() => setIsLoading(false));
      } else {
        setIsLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s?.user) {
        fetchProfile(s.user.id);
      } else {
        setProfile(null);
      }
    });

    return () => subscription.unsubscribe();
  }, [fetchProfile]);

  /**
   * Signs the user in and returns their profile so the caller can
   * immediately navigate to the correct screen without waiting for a
   * second render cycle.
   */
  const signIn = useCallback(async (email: string, password: string): Promise<UserProfile> => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    const p = await fetchProfile(data.user.id);
    if (!p) throw new Error('User profile not found. Please contact your administrator.');
    return p;
  }, [fetchProfile]);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    setProfile(null);
  }, []);

  return (
    <AuthContext.Provider value={{ session, profile, isLoading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
