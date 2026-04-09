import type { ReactNode } from 'react';

interface EmptyStateProps {
  /** Icon or illustration to show */
  icon?: ReactNode;
  /** Main heading */
  title: string;
  /** Description text */
  description?: string;
  /** Optional action button */
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      {icon && (
        <div className="w-16 h-16 rounded-full bg-[rgba(107,143,113,0.1)] flex items-center justify-center mb-4 text-[#6B8F71]">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold text-[#2C3E2D] mb-2">{title}</h3>
      {description && (
        <p className="text-sm text-[#7A7A6E] max-w-xs mb-6">{description}</p>
      )}
      {action && action}
    </div>
  );
}
