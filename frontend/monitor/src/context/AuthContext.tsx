'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SupervisorProfile {
  email: string;
  full_name: string | null;
  role: string;
}

export type AuthStatus =
  | 'loading'       // initial check in progress
  | 'unauthenticated' // no Supabase session
  | 'checking'      // session found, querying allowlist
  | 'authorized'    // session + in allowlist
  | 'denied';       // session exists but not in allowlist

interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  supervisor: SupervisorProfile | null;
  accessDeniedMessage: string | null;
  signOut: () => Promise<void>;
  /** Re-run the allowlist check (call after dev-bypass login) */
  recheck: () => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [supervisor, setSupervisor] = useState<SupervisorProfile | null>(null);
  const [accessDeniedMessage, setAccessDeniedMessage] = useState<string | null>(null);

  // ── Allowlist check ──────────────────────────────────────────────────────
  const checkAllowlist = useCallback(async (email: string): Promise<boolean> => {
    const { data, error } = await supabase
      .from('supervisor_accounts')
      .select('email, full_name, role, is_active')
      .eq('email', email)
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      console.error('AuthContext: allowlist query error', error.message);
      return false;
    }

    if (data) {
      setSupervisor({ email: data.email, full_name: data.full_name, role: data.role });
      return true;
    }

    return false;
  }, []);

  // ── Handle a resolved session (Supabase or dev bypass) ───────────────────
  const handleSession = useCallback(
    async (s: Session | null, devEmail?: string) => {
      const email = devEmail || s?.user?.email;

      if (!email) {
        setSession(null);
        setSupervisor(null);
        setStatus('unauthenticated');
        return;
      }

      setSession(s);
      setStatus('checking');
      setAccessDeniedMessage(null);

      const allowed = await checkAllowlist(email);

      if (allowed) {
        setStatus('authorized');
      } else {
        // Reject: sign out Supabase session + clear legacy tokens
        await supabase.auth.signOut().catch(() => {});
        if (typeof window !== 'undefined') {
          localStorage.removeItem('google_access_token');
          localStorage.removeItem('google_token_expiry');
          localStorage.removeItem('google_user_profile');
        }
        setSupervisor(null);
        setSession(null);
        setStatus('denied');
        setAccessDeniedMessage(
          'Access denied. Your account has not been registered. Contact your administrator.'
        );
      }
    },
    [checkAllowlist]
  );

  // ── Public sign-out ──────────────────────────────────────────────────────
  const signOut = useCallback(async () => {
    await supabase.auth.signOut().catch(() => {});
    if (typeof window !== 'undefined') {
      localStorage.removeItem('google_access_token');
      localStorage.removeItem('google_token_expiry');
      localStorage.removeItem('google_user_profile');
    }
    setSupervisor(null);
    setSession(null);
    setStatus('unauthenticated');
    setAccessDeniedMessage(null);
  }, []);

  // ── recheck: used after the developer-bypass login ───────────────────────
  const recheck = useCallback(async () => {
    // 1. Try live Supabase session first
    const { data: { session: s } } = await supabase.auth.getSession();
    if (s?.user?.email) {
      await handleSession(s);
      return;
    }

    // 2. Fall back to legacy dev-bypass localStorage token
    if (typeof window !== 'undefined') {
      const profileStr = localStorage.getItem('google_user_profile');
      const token = localStorage.getItem('google_access_token');
      const expiry = localStorage.getItem('google_token_expiry');

      if (token && expiry && Date.now() < Number(expiry) && profileStr) {
        const profile = JSON.parse(profileStr);
        await handleSession(null, profile.email);
        return;
      }
    }

    setStatus('unauthenticated');
  }, [handleSession]);

  // ── Bootstrap: subscribe to Supabase auth state ───────────────────────────
  useEffect(() => {
    // Initial session read
    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      if (s) {
        await handleSession(s);
      } else {
        setStatus('unauthenticated');
      }
    });

    // Live subscription
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, s) => {
      if (s) {
        await handleSession(s);
      } else {
        // Don't clobber 'denied' status on SIGNED_OUT triggered by our own rejection
        setStatus((prev) => (prev === 'denied' ? 'denied' : 'unauthenticated'));
        setSession(null);
        setSupervisor(null);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [handleSession]);

  return (
    <AuthContext.Provider value={{ status, session, supervisor, accessDeniedMessage, signOut, recheck }}>
      {children}
    </AuthContext.Provider>
  );
}
