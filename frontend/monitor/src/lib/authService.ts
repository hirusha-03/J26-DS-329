import { supabase } from './supabaseClient';

export interface UserProfile {
  name: string;
  email: string;
  picture?: string;
}

// ─── Supabase Auth (Primary) ─────────────────────────────────────────────────

/**
 * Sign in with Google via Supabase OAuth.
 * Supabase handles the redirect, token storage, and session refresh automatically.
 */
export async function loginWithGoogle(): Promise<void> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      // Request Google Sheets + Drive scopes alongside the default openid/email/profile
      scopes: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
      redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
    },
  });

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Sign out via Supabase Auth.
 * Also clears legacy localStorage keys so old sessions don't linger.
 */
export async function logoutGoogle(): Promise<void> {
  // Clear legacy keys
  if (typeof window !== 'undefined') {
    localStorage.removeItem('google_access_token');
    localStorage.removeItem('google_token_expiry');
    localStorage.removeItem('google_user_profile');
  }

  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error('Supabase sign-out error:', error.message);
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('auth-status-change'));
  }
}

/**
 * Gets the current Supabase session synchronously from the stored session,
 * with a fallback to the legacy localStorage token for backward compatibility
 * during the transition / developer bypass mode.
 */
export function isAuthenticated(): boolean {
  if (typeof window === 'undefined') return false;

  // Legacy developer bypass token check (for offline dev without OAuth)
  try {
    const token = localStorage.getItem('google_access_token');
    const expiry = localStorage.getItem('google_token_expiry');
    if (token && expiry && Date.now() < Number(expiry)) return true;
  } catch {
    // ignore localStorage errors
  }

  // Supabase persists session in localStorage under its own key.
  // We check for any Supabase session key as a synchronous indicator.
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const projectRef = supabaseUrl.split('//')[1]?.split('.')[0] || '';
    const sessionKey = `sb-${projectRef}-auth-token`;
    const raw = localStorage.getItem(sessionKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Check that the access token is present and not expired
      if (parsed?.access_token && parsed?.expires_at) {
        return Date.now() / 1000 < parsed.expires_at;
      }
    }
  } catch {
    // ignore parse errors
  }

  return false;
}

/**
 * Gets the current user profile.
 * Prefers the Supabase session user, falls back to the legacy localStorage profile
 * (used by the developer bypass login).
 */
export function getUserProfile(): UserProfile | null {
  if (typeof window === 'undefined') return null;

  // Legacy developer bypass profile
  try {
    const profileStr = localStorage.getItem('google_user_profile');
    if (profileStr) return JSON.parse(profileStr);
  } catch {
    // ignore
  }

  return null;
}

/**
 * Async version — reads the live Supabase session for accurate profile data.
 * Use this in components that can await.
 */
export async function getUserProfileAsync(): Promise<UserProfile | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    const meta = session.user.user_metadata;
    return {
      name: meta?.full_name || meta?.name || session.user.email || 'Supervisor',
      email: session.user.email || '',
      picture: meta?.avatar_url || meta?.picture,
    };
  }

  // Fallback to legacy localStorage profile (developer bypass)
  return getUserProfile();
}

/**
 * Returns the Google OAuth access token from the current Supabase session,
 * or the legacy mock token if in developer bypass mode.
 * Used by syncService to authenticate Google Sheets calls.
 */
export async function getGoogleAccessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.provider_token) return session.provider_token;

  // Legacy fallback
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('google_access_token');
    const expiry = localStorage.getItem('google_token_expiry');
    if (token && expiry && Date.now() < Number(expiry)) return token;
  }

  return null;
}

// ─── Legacy compatibility export (no-op now) ──────────────────────────────────
export async function initGoogleAuth(): Promise<void> {
  // No longer needed — Supabase Auth handles Google OAuth entirely.
}
