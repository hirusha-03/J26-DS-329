// Design tokens from Stitch design system
export const COLORS = {
  primary: '#012d1d',
  primaryContainer: '#1b4332',
  secondary: '#2c694e',
  secondaryContainer: '#aeeecb',
  tertiary: '#002d1b',
  tertiaryContainer: '#00452c',
  surface: '#f8faf8',
  surfaceDim: '#d8dad9',
  surfaceContainer: '#eceeec',
  surfaceContainerHigh: '#e6e9e7',
  onSurface: '#191c1b',
  onSurfaceVariant: '#414844',
  outline: '#717973',
  outlineVariant: '#c1c8c2',
  error: '#ba1a1a',
  errorContainer: '#ffdad6',
  paleGreen: '#D8F3DC',
  amberWarning: '#F4A261',
  redAlert: '#E63946',
  textPrimary: '#1A1A1A',
  textSecondary: '#6B7280',
  borderLight: '#E5E7EB',
  white: '#FFFFFF',
  zoneA: '#DC2626',
  zoneB: '#D97706',
  zoneC: '#16A34A',
  zoneD: '#2563EB',
} as const;

export const ZONES = [
  { id: 'A', label: 'Zone A', color: COLORS.zoneA, blocks: 5 },
  { id: 'B', label: 'Zone B', color: COLORS.zoneB, blocks: 6 },
  { id: 'C', label: 'Zone C', color: COLORS.zoneC, blocks: 4 },
  { id: 'D', label: 'Zone D', color: COLORS.zoneD, blocks: 4 },
] as const;

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export const NAV_ITEMS = [
  { href: '/dashboard', label: 'Home', icon: 'Home' },
  { href: '/inspect', label: 'Inspect', icon: 'Bug' },
  { href: '/digital-twin', label: 'Map', icon: 'Map' },
  { href: '/history', label: 'History', icon: 'History' },
  { href: '/profile', label: 'Profile', icon: 'User' },
] as const;

export const DISEASE_LABELS = [
  'Healthy',
  'Fusarium Root Rot',
  'Stem Rot',
  'Black Pod Rot',
  'Leaf Scorch',
  'Mosaic Virus',
] as const;

export const BEAN_GRADES = [
  'Grade A - Premium',
  'Grade B - Standard',
  'Grade C - Below Standard',
  'Grade D - Reject',
] as const;
