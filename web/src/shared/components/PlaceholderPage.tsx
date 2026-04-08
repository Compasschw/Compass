import { Construction } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PlaceholderPageProps {
  title: string;
  description?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Generic placeholder used for pages that haven't been implemented yet.
 * Rendered inside the authenticated Layout so nav and chrome still function.
 */
export function PlaceholderPage({
  title,
  description = 'This page is coming soon.',
}: PlaceholderPageProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
      <div className="w-14 h-14 rounded-full bg-[rgba(44,62,45,0.1)] flex items-center justify-center mb-4">
        <Construction size={26} className="text-[#8B9B8D]" aria-hidden="true" />
      </div>
      <h1 className="text-xl font-semibold text-[#2C3E2D] mb-2">{title}</h1>
      <p className="text-sm text-[#555555] max-w-xs">{description}</p>
    </div>
  );
}
