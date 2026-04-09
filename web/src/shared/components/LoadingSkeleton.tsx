interface LoadingSkeletonProps {
  /** Number of skeleton rows to render */
  rows?: number;
  /** Show a card-shaped skeleton instead of rows */
  variant?: 'rows' | 'card' | 'stat-grid';
}

export function LoadingSkeleton({ rows = 3, variant = 'rows' }: LoadingSkeletonProps) {
  if (variant === 'stat-grid') {
    return (
      <div className="grid grid-cols-2 gap-3 mb-6">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white rounded-[16px] p-4 animate-pulse">
            <div className="h-3 bg-[rgba(44,62,45,0.08)] rounded w-2/3 mb-3" />
            <div className="h-6 bg-[rgba(44,62,45,0.08)] rounded w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'card') {
    return (
      <div className="bg-white rounded-[16px] p-5 animate-pulse">
        <div className="h-4 bg-[rgba(44,62,45,0.08)] rounded w-3/4 mb-4" />
        <div className="h-3 bg-[rgba(44,62,45,0.08)] rounded w-1/2 mb-3" />
        <div className="h-3 bg-[rgba(44,62,45,0.08)] rounded w-2/3" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {[...Array(rows)].map((_, i) => (
        <div key={i} className="bg-white rounded-[16px] p-5 animate-pulse">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-[rgba(44,62,45,0.08)] rounded-full" />
            <div className="flex-1">
              <div className="h-4 bg-[rgba(44,62,45,0.08)] rounded w-1/3 mb-2" />
              <div className="h-3 bg-[rgba(44,62,45,0.08)] rounded w-1/2" />
            </div>
          </div>
          <div className="h-3 bg-[rgba(44,62,45,0.08)] rounded w-full mb-2" />
          <div className="h-3 bg-[rgba(44,62,45,0.08)] rounded w-4/5" />
        </div>
      ))}
    </div>
  );
}
