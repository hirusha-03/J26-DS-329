'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, ClipboardCheck, Map, History, User } from 'lucide-react';

const ICON_MAP = {
  Home: Home,
  Bug: ClipboardCheck,
  Map: Map,
  History: History,
  User: User,
} as const;

export default function BottomNav() {
  const pathname = usePathname();

  const navItems = [
    { href: '/dashboard', label: 'Home', icon: 'Home' as const },
    { href: '/digital-twin', label: 'Map', icon: 'Map' as const },
    { href: '/history', label: 'History', icon: 'History' as const },
    { href: '/profile', label: 'Profile', icon: 'User' as const },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 h-16 border-t border-border-light bg-white px-2 shadow-lg">
      <div className="mx-auto flex h-full max-w-md justify-around items-center">
        {navItems.map((item) => {
          const Icon = ICON_MAP[item.icon];
          const isActive = pathname === item.href || (item.href === '/new-inspection' && pathname?.startsWith('/new-inspection'));

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center w-14 h-12 rounded-xl transition-all duration-200 ${
                isActive
                  ? 'text-primary font-semibold'
                  : 'text-text-secondary hover:text-primary'
              }`}
            >
              <Icon
                className={`h-5 w-5 mb-0.5 transition-transform duration-200 ${
                  isActive ? 'scale-110 stroke-[2.5px]' : 'stroke-[2px]'
                }`}
              />
              <span className="text-[10px] tracking-wide font-medium">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
