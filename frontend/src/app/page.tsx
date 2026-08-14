'use client';

import { useState } from 'react';
import {
  Building2, MapPin, ShieldCheck, AlertTriangle,
  Eye, EyeOff, CheckCircle2,
} from 'lucide-react';
import { loginWithGoogle } from '../lib/authService';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';

type Mode = 'signin' | 'signup';

export default function SplashPage() {
  const { accessDeniedMessage, recheck } = useAuth();

  const [mode, setMode] = useState<Mode>('signin');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [signUpSuccess, setSignUpSuccess] = useState(false);

  // Form fields
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // ── Sign In ───────────────────────────────────────────────────────────────
  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setFormError(error.message === 'Invalid login credentials'
          ? 'Incorrect email or password. Please try again.'
          : error.message);
      }
      // On success: onAuthStateChange fires → AuthContext runs allowlist check → redirects
    } catch {
      setFormError('Sign-in failed. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  // ── Sign Up ───────────────────────────────────────────────────────────────
  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (password !== confirmPassword) {
      setFormError('Passwords do not match.');
      return;
    }
    if (password.length < 6) {
      setFormError('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName || email.split('@')[0] },
        },
      });

      if (error) {
        setFormError(error.message);
      } else {
        setSignUpSuccess(true);
        // Trigger runs on new user → supervisor_accounts row is created
        // Try to recheck in case email confirmation is disabled
        await recheck();
      }
    } catch {
      setFormError('Registration failed. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  // ── Google OAuth ──────────────────────────────────────────────────────────
  const handleGoogleSignIn = async () => {
    setLoading(true);
    try {
      await loginWithGoogle();
    } catch {
      setFormError('Google sign-in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Switch mode ───────────────────────────────────────────────────────────
  const switchMode = (m: Mode) => {
    setMode(m);
    setFormError(null);
    setSignUpSuccess(false);
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setFullName('');
  };

  return (
    <div className="flex min-h-screen flex-col bg-surface font-sans">

      {/* ── Brand Header ──────────────────────────────────────────────────── */}
      <div className="flex flex-col items-center justify-center bg-primary-container px-6 py-10 text-center text-white">
        <img src="/logo.png" alt="Vanilla Monitor" className="h-24 w-auto object-contain" />
      </div>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col px-6 py-6 gap-5">

        {/* Plantation info cards */}
        <div className="rounded-2xl border border-border-light bg-white p-4 shadow-sm space-y-0">
          {[
            { icon: Building2, label: 'Organisation', value: 'Sapori dal Mondo PVT (Ltd)' },
            { icon: MapPin, label: 'Location Site', value: 'Galagedara, Kandy District, Sri Lanka' },
          ].map(({ icon: Icon, label, value }, i, arr) => (
            <div key={label}>
              <div className="flex items-start gap-4 py-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-pale-green text-primary">
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <span className="text-[9px] font-bold uppercase tracking-widest text-text-secondary">{label}</span>
                  <p className="text-sm font-semibold text-text-primary">{value}</p>
                </div>
              </div>
              {i < arr.length - 1 && <div className="border-t border-border-light/50" />}
            </div>
          ))}
        </div>



        {/* ── Access denied banner ─────────────────────────────────────────── */}
        {accessDeniedMessage && (
          <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" />
            <p className="text-xs font-medium text-red-700">{accessDeniedMessage}</p>
          </div>
        )}

        {/* ── Form error banner ────────────────────────────────────────────── */}
        {formError && (
          <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" />
            <p className="text-xs font-medium text-red-700">{formError}</p>
          </div>
        )}

        {/* ── Sign-up success ───────────────────────────────────────────────── */}
        {signUpSuccess && (
          <div className="flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3">
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" />
            <div>
              <p className="text-xs font-bold text-green-800">Account created!</p>
              <p className="text-xs text-green-700 mt-0.5">
                Check your email and click the confirmation link, then come back to sign in.
              </p>
            </div>
          </div>
        )}

        {/* ── SIGN IN FORM ──────────────────────────────────────────────────── */}
        {mode === 'signin' && (
          <form onSubmit={handleSignIn} className="space-y-3">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary block mb-1">
                Supervisor Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="supervisor@sapori.lk"
                className="w-full rounded-xl border border-border-light bg-white px-4 py-2.5 text-sm text-text-primary focus:border-primary focus:outline-none"
              />
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary block mb-1">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-xl border border-border-light bg-white px-4 py-2.5 pr-10 text-sm text-text-primary focus:border-primary focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              id="submit-login"
              disabled={loading}
              className="w-full rounded-full bg-[#1B4332] py-3 text-xs font-bold text-white shadow-md transition hover:bg-primary active:scale-95 disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>

            <p className="text-center text-xs text-text-secondary mt-2">
              Don't have an account?{' '}
              <button
                type="button"
                onClick={() => switchMode('signup')}
                className="font-bold text-primary hover:underline cursor-pointer"
              >
                Sign Up
              </button>
            </p>
          </form>
        )}

        {/* ── CREATE ACCOUNT FORM ───────────────────────────────────────────── */}
        {mode === 'signup' && !signUpSuccess && (
          <form onSubmit={handleSignUp} className="space-y-3">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary block mb-1">
                Full Name
              </label>
              <input
                id="full-name"
                type="text"
                autoComplete="name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Chaminda Rajapaksa"
                className="w-full rounded-xl border border-border-light bg-white px-4 py-2.5 text-sm text-text-primary focus:border-primary focus:outline-none"
              />
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary block mb-1">
                Email Address
              </label>
              <input
                id="signup-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="supervisor@sapori.lk"
                className="w-full rounded-xl border border-border-light bg-white px-4 py-2.5 text-sm text-text-primary focus:border-primary focus:outline-none"
              />
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary block mb-1">
                Password
              </label>
              <div className="relative">
                <input
                  id="signup-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min. 6 characters"
                  className="w-full rounded-xl border border-border-light bg-white px-4 py-2.5 pr-10 text-sm text-text-primary focus:border-primary focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary block mb-1">
                Confirm Password
              </label>
              <input
                id="confirm-password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-xl border border-border-light bg-white px-4 py-2.5 text-sm text-text-primary focus:border-primary focus:outline-none"
              />
            </div>

            <button
              type="submit"
              id="submit-signup"
              disabled={loading}
              className="w-full rounded-full bg-[#1B4332] py-3 text-xs font-bold text-white shadow-md transition hover:bg-primary active:scale-95 disabled:opacity-50"
            >
              {loading ? 'Creating Account...' : 'Create Account'}
            </button>

            <p className="text-center text-xs text-text-secondary mt-2">
              Already have an account?{' '}
              <button
                type="button"
                onClick={() => switchMode('signin')}
                className="font-bold text-primary hover:underline cursor-pointer"
              >
                Sign In
              </button>
            </p>
          </form>
        )}

        {/* ── OR divider + Google ───────────────────────────────────────────── */}
        <div className="relative flex items-center justify-center">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border-light/50" />
          </div>
          <span className="relative bg-surface px-3 text-[10px] font-bold uppercase text-text-secondary">
            Or SSO
          </span>
        </div>

        <button
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="flex w-full items-center justify-center gap-3 rounded-full border border-border-light bg-white px-6 py-3 text-sm font-bold text-text-primary shadow-xs transition-all hover:bg-gray-50 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
        >
          {loading ? (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          ) : (
            <svg className="h-5 w-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
            </svg>
          )}
          <span>{loading ? 'Connecting...' : 'Sign in with Google'}</span>
        </button>

        <div className="flex items-center justify-center gap-1.5 text-[10px] text-text-secondary">
          <ShieldCheck className="h-3.5 w-3.5 text-secondary" />
          <span>Secure connection via Sapori SSO</span>
        </div>

      </div>
    </div>
  );
}
