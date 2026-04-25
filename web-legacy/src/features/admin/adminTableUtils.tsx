/**
 * Shared table primitives for admin data tables.
 * Provides: Chip, StatusBadge, Pagination, TableSkeleton, EmptyTableState, ErrorTableState.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { capitalize } from './adminFormatters';

// ─── Chip ─────────────────────────────────────────────────────────────────────

interface ChipProps {
  label: string;
}

/** Small pill for list items like specializations and languages. */
export function Chip({ label }: ChipProps) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-[rgba(107,143,113,0.12)] text-[#6B8F71] mr-1 mb-1">
      {label}
    </span>
  );
}

// ─── Status badge ──────────────────────────────────────────────────────────────

type StatusTone = 'green' | 'amber' | 'blue' | 'gray' | 'red';

function getStatusTone(status: string): StatusTone {
  const s = status.toLowerCase();
  if (['completed', 'paid', 'available', 'active'].includes(s)) return 'green';
  if (['pending', 'open', 'submitted'].includes(s)) return 'amber';
  if (['matched', 'in_progress', 'scheduled'].includes(s)) return 'blue';
  if (['cancelled', 'rejected', 'denied'].includes(s)) return 'red';
  return 'gray';
}

const toneCls: Record<StatusTone, string> = {
  green: 'bg-[rgba(107,143,113,0.15)] text-[#4A7A50]',
  amber: 'bg-[rgba(217,119,6,0.1)] text-[#B45309]',
  blue: 'bg-[rgba(0,119,182,0.1)] text-[#0077B6]',
  red: 'bg-red-50 text-red-600',
  gray: 'bg-[rgba(44,62,45,0.06)] text-[#6B7B6D]',
};

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const tone = getStatusTone(status);
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${toneCls[tone]}`}>
      {capitalize(status.replace(/_/g, ' '))}
    </span>
  );
}

// ─── Table skeleton ───────────────────────────────────────────────────────────

interface TableSkeletonProps {
  rows?: number;
  cols?: number;
}

export function TableSkeleton({ rows = 8, cols = 6 }: TableSkeletonProps) {
  return (
    <div className="animate-pulse">
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex gap-4 px-4 py-3 border-b border-[rgba(44,62,45,0.04)]"
        >
          {Array.from({ length: cols }).map((_, c) => (
            <div
              key={c}
              className="h-4 bg-[rgba(44,62,45,0.06)] rounded flex-1"
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

interface EmptyTableStateProps {
  message?: string;
}

export function EmptyTableState({ message = 'No records found.' }: EmptyTableStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <p className="text-sm text-[#6B7B6D]">{message}</p>
    </div>
  );
}

// ─── Error state ──────────────────────────────────────────────────────────────

interface ErrorTableStateProps {
  message: string;
  onRetry: () => void;
}

export function ErrorTableState({ message, onRetry }: ErrorTableStateProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center py-16 gap-3"
    >
      <p className="text-sm text-red-600">{message}</p>
      <button
        onClick={onRetry}
        className="px-4 py-2 rounded-[10px] border border-[rgba(44,62,45,0.15)] text-sm font-medium text-[#2C3E2D] hover:bg-[#FBF7F0] transition-colors"
      >
        Retry
      </button>
    </div>
  );
}

// ─── Pagination ───────────────────────────────────────────────────────────────

interface PaginationProps {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (newPage: number) => void;
  isLoading?: boolean;
}

/**
 * Zero-indexed pagination bar.
 * Shows "Page X of Y" and prev/next buttons.
 */
export function Pagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  isLoading = false,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const canPrev = page > 0;
  const canNext = page < totalPages - 1;
  const start = totalItems === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, totalItems);

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-[rgba(44,62,45,0.06)]">
      <p className="text-xs text-[#6B7B6D]">
        {totalItems === 0
          ? 'No records'
          : `${start}–${end} of ${totalItems.toLocaleString()}`}
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={!canPrev || isLoading}
          className="flex items-center gap-1 px-3 py-1.5 rounded-[8px] border border-[rgba(44,62,45,0.12)] text-xs font-medium text-[#2C3E2D] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#FBF7F0] transition-colors"
          aria-label="Previous page"
        >
          <ChevronLeft size={14} aria-hidden="true" />
          Prev
        </button>
        <span className="text-xs text-[#6B7B6D] px-1">
          {page + 1} / {totalPages}
        </span>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={!canNext || isLoading}
          className="flex items-center gap-1 px-3 py-1.5 rounded-[8px] border border-[rgba(44,62,45,0.12)] text-xs font-medium text-[#2C3E2D] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#FBF7F0] transition-colors"
          aria-label="Next page"
        >
          Next
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// ─── Table container ──────────────────────────────────────────────────────────

interface TableContainerProps {
  children: React.ReactNode;
}

export function TableContainer({ children }: TableContainerProps) {
  return (
    <div className="bg-white rounded-[16px] border border-[rgba(44,62,45,0.06)] overflow-hidden">
      {children}
    </div>
  );
}

// ─── Page header ──────────────────────────────────────────────────────────────

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between mb-6">
      <div>
        <h1 className="text-2xl font-bold text-[#2C3E2D]">{title}</h1>
        {subtitle && (
          <p className="text-sm text-[#6B7B6D] mt-0.5">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// ─── Filter select ────────────────────────────────────────────────────────────

interface FilterSelectProps {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

export function FilterSelect({ id, label, value, options, onChange }: FilterSelectProps) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium text-[#2C3E2D] shrink-0">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-[10px] border border-[rgba(44,62,45,0.12)] px-3 py-1.5 text-sm text-[#2C3E2D] bg-white focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── Search input ─────────────────────────────────────────────────────────────

interface SearchInputProps {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

export function SearchInput({ id, label, value, placeholder, onChange }: SearchInputProps) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? label}
        className="w-56 rounded-[10px] border border-[rgba(44,62,45,0.12)] px-3 py-1.5 text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] bg-white focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition"
      />
    </div>
  );
}
