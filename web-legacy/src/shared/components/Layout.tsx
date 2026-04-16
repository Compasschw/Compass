import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { BottomNav } from './BottomNav';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LayoutProps {
  children: ReactNode;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Root shell for authenticated pages.
 *
 * Desktop layout: Sidebar on the left, content fills the remaining width.
 * Mobile layout:  Full-width content, BottomNav fixed at the viewport bottom.
 *
 * The main content area adds bottom padding on mobile so content is never
 * hidden beneath the BottomNav.
 */
export function Layout({ children }: LayoutProps) {
  return (
    <div className="flex min-h-screen bg-[#FBF7F0]">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0">
        <main
          className="flex-1 overflow-y-auto pb-24 lg:pb-8 px-4 lg:px-8 py-6"
          id="main-content"
        >
          {children}
        </main>
      </div>

      <BottomNav />
    </div>
  );
}
