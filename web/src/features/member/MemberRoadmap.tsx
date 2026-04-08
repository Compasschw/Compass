import { useState, useCallback } from 'react';
import { Plus, CalendarDays, X, CheckCircle } from 'lucide-react';
import { Badge } from '../../shared/components/Badge';
import {
  goals,
  type Goal,
  type Vertical,
} from '../../data/mock';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LocalGoal extends Goal {
  /** True when added in this session (not from mock data) */
  isNew?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VERTICAL_OPTIONS: { key: Vertical; label: string; emoji: string }[] = [
  { key: 'housing', label: 'Housing', emoji: '🏠' },
  { key: 'food', label: 'Food Security', emoji: '🛒' },
  { key: 'mental_health', label: 'Mental Health', emoji: '🧠' },
  { key: 'rehab', label: 'Rehab & Recovery', emoji: '💪' },
  { key: 'healthcare', label: 'Healthcare Access', emoji: '🏥' },
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const YEARS = ['2026', '2027', '2028'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatNextSession(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function calcOverallProgress(goalList: LocalGoal[]): number {
  if (goalList.length === 0) return 0;
  const sum = goalList.reduce((acc, g) => acc + g.progress, 0);
  return Math.round(sum / goalList.length);
}

function statusLabel(status: string): string {
  switch (status) {
    case 'on_track':
      return 'On track';
    case 'almost_done':
      return 'Almost done';
    case 'completed':
      return 'Completed';
    default:
      return status;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ProgressBarProps {
  value: number;
  label: string;
  size?: 'sm' | 'md';
}

function ProgressBar({ value, label, size = 'sm' }: ProgressBarProps) {
  const height = size === 'md' ? 'h-2.5' : 'h-1.5';
  return (
    <div
      className={`w-full bg-[rgba(44,62,45,0.1)] rounded-full ${height}`}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={`bg-[#2C3E2D] ${height} rounded-full transition-all duration-500`}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

interface GoalCardProps {
  goal: LocalGoal;
}

function GoalCard({ goal }: GoalCardProps) {
  return (
    <article
      className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-5"
      aria-label={`Goal: ${goal.title}`}
    >
      <div className="flex items-start gap-4">
        {/* Emoji icon */}
        <span
          className="text-3xl leading-none mt-0.5 shrink-0"
          role="img"
          aria-hidden="true"
        >
          {goal.emoji}
        </span>

        <div className="flex-1 min-w-0">
          {/* Title + badge */}
          <div className="flex items-start justify-between gap-2 mb-1">
            <p className="text-sm font-bold text-[#2C3E2D]">{goal.title}</p>
            <Badge variant="vertical" value={goal.category} />
          </div>

          {/* Status text */}
          <p className="text-xs text-[#555555] mb-3">
            {goal.sessionsCompleted > 0
              ? `${goal.sessionsCompleted} session${goal.sessionsCompleted !== 1 ? 's' : ''} completed`
              : 'Just getting started'}
            {' · '}
            <span className="text-[#6B8F71] font-medium">{statusLabel(goal.status)}</span>
          </p>

          {/* Progress bar with percentage */}
          <div className="mb-2">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-[#8B9B8D]">Progress</span>
              <span className="text-xs font-bold text-[#2C3E2D]">
                {goal.progress}%
              </span>
            </div>
            <ProgressBar
              value={goal.progress}
              label={`${goal.title} progress: ${goal.progress}%`}
              size="md"
            />
          </div>

          {/* Footer meta */}
          <p className="text-xs text-[#8B9B8D] mt-2">
            CHW Sessions: {goal.sessionsCompleted}
            {' · '}
            Next: {formatNextSession(goal.nextSession)}
          </p>
        </div>
      </div>
    </article>
  );
}

// ─── Add Goal Modal ────────────────────────────────────────────────────────────

interface AddGoalModalProps {
  onClose: () => void;
  onAdd: (goal: LocalGoal) => void;
}

function AddGoalModal({ onClose, onAdd }: AddGoalModalProps) {
  const [selectedVertical, setSelectedVertical] = useState<Vertical | null>(null);
  const [title, setTitle] = useState('');
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('2026');

  const isValid = selectedVertical !== null && title.trim().length > 0;

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!selectedVertical) return;

      const option = VERTICAL_OPTIONS.find((v) => v.key === selectedVertical)!;
      const targetDate = month
        ? `${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, '0')}-01T00:00:00Z`
        : `${year}-12-01T00:00:00Z`;

      const newGoal: LocalGoal = {
        id: `goal-new-${Date.now()}`,
        title: title.trim(),
        emoji: option.emoji,
        category: selectedVertical,
        progress: 0,
        sessionsCompleted: 0,
        nextSession: targetDate,
        status: 'on_track',
        isNew: true,
      };

      onAdd(newGoal);
    },
    [selectedVertical, title, month, year, onAdd],
  );

  return (
    <div
      className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-goal-modal-heading"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-[16px] w-full max-w-lg shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[rgba(44,62,45,0.1)]">
          <h2
            id="add-goal-modal-heading"
            className="text-base font-bold text-[#2C3E2D]"
          >
            Add a New Goal
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-[#FBF7F0] text-[#8B9B8D] hover:text-[#555555] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077B6]"
            aria-label="Close modal"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-5">
          {/* Category selection */}
          <fieldset>
            <legend className="text-sm font-semibold text-[#2C3E2D] mb-3">
              Category
            </legend>
            <div className="space-y-2">
              {VERTICAL_OPTIONS.map((option) => {
                const isSelected = selectedVertical === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setSelectedVertical(option.key)}
                    aria-pressed={isSelected}
                    className={[
                      'w-full flex items-center gap-3 px-4 py-3 rounded-[10px] border text-left transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]',
                      isSelected
                        ? 'border-[#6B8F71] bg-[rgba(107,143,113,0.15)]/40'
                        : 'border-[rgba(44,62,45,0.1)] bg-white hover:border-[#6B8F71]/50',
                    ].join(' ')}
                  >
                    <span className="text-xl" role="img" aria-hidden="true">
                      {option.emoji}
                    </span>
                    <span
                      className={`text-sm font-medium ${isSelected ? 'text-[#6B8F71]' : 'text-[#2C3E2D]'}`}
                    >
                      {option.label}
                    </span>
                    {isSelected && (
                      <CheckCircle
                        size={16}
                        className="text-[#6B8F71] ml-auto shrink-0"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Goal title */}
          <div>
            <label
              htmlFor="goal-title"
              className="text-sm font-semibold text-[#2C3E2D] block mb-2"
            >
              Goal Title
            </label>
            <input
              id="goal-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Enroll in CalFresh by June"
              maxLength={80}
              required
              className="w-full px-3 py-2.5 rounded-[12px] border border-[rgba(44,62,45,0.1)] text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71]/30 focus:border-[#6B8F71] transition-colors"
            />
          </div>

          {/* Target date */}
          <div>
            <label className="text-sm font-semibold text-[#2C3E2D] block mb-2">
              Target Date{' '}
              <span className="text-[#8B9B8D] font-normal">(optional)</span>
            </label>
            <div className="flex gap-2">
              <select
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className="flex-1 px-3 py-2.5 rounded-[12px] border border-[rgba(44,62,45,0.1)] text-sm text-[#2C3E2D] bg-white focus:outline-none focus:ring-2 focus:ring-[#6B8F71]/30 focus:border-[#6B8F71] transition-colors"
                aria-label="Target month"
              >
                <option value="">Month</option>
                {MONTHS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select
                value={year}
                onChange={(e) => setYear(e.target.value)}
                className="w-24 px-3 py-2.5 rounded-[12px] border border-[rgba(44,62,45,0.1)] text-sm text-[#2C3E2D] bg-white focus:outline-none focus:ring-2 focus:ring-[#6B8F71]/30 focus:border-[#6B8F71] transition-colors"
                aria-label="Target year"
              >
                {YEARS.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={!isValid}
            className="w-full bg-[#2C3E2D] hover:bg-[#3A5240] active:bg-[#243D25] disabled:bg-[rgba(44,62,45,0.1)] disabled:text-[#8B9B8D] disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
          >
            Add Goal
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * MemberRoadmap — the member's health journey goal tracker.
 *
 * Sections:
 * 1. Header with overall progress bar
 * 2. Active goals with progress, status, and next session
 * 3. Timeline card with goal completion date
 * 4. "Add Goal" button that opens a modal
 */
export function MemberRoadmap() {
  const [goalList, setGoalList] = useState<LocalGoal[]>(
    goals.filter((g) => g.status !== 'completed') as LocalGoal[],
  );
  const [showAddModal, setShowAddModal] = useState(false);

  const overallProgress = calcOverallProgress(goalList);

  const handleAddGoal = useCallback((newGoal: LocalGoal) => {
    setGoalList((prev) => [...prev, newGoal]);
    setShowAddModal(false);
  }, []);

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-8">
      {/* Add goal modal */}
      {showAddModal && (
        <AddGoalModal
          onClose={() => setShowAddModal(false)}
          onAdd={handleAddGoal}
        />
      )}

      {/* Page header */}
      <div>
        <h2 className="text-2xl font-semibold text-[#0077B6]">My Roadmap</h2>
        <p className="text-sm text-[#555555] mt-1">Track your health journey</p>
      </div>

      {/* Overall progress card */}
      <section
        aria-labelledby="overall-progress-heading"
        className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-5"
      >
        <div className="flex items-center justify-between mb-3">
          <h3
            id="overall-progress-heading"
            className="text-sm font-bold text-[#2C3E2D]"
          >
            Overall Progress
          </h3>
          <span className="text-2xl font-bold text-[#6B8F71]">
            {overallProgress}%
          </span>
        </div>
        <ProgressBar
          value={overallProgress}
          label={`Overall health journey progress: ${overallProgress}%`}
          size="md"
        />
        <p className="text-xs text-[#8B9B8D] mt-2">
          {goalList.length} active goal{goalList.length !== 1 ? 's' : ''} in progress
        </p>
      </section>

      {/* Active goals */}
      <section aria-labelledby="active-goals-heading">
        <h3
          id="active-goals-heading"
          className="text-sm font-semibold text-[#2C3E2D] uppercase tracking-wide mb-3"
        >
          Active Goals
        </h3>

        {goalList.length > 0 ? (
          <div className="space-y-3">
            {goalList.map((goal) => (
              <GoalCard key={goal.id} goal={goal} />
            ))}
          </div>
        ) : (
          <div
            className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-10 flex flex-col items-center gap-3 text-center"
            role="status"
          >
            <span className="text-4xl" role="img" aria-label="Target">
              🎯
            </span>
            <p className="text-sm font-semibold text-[#2C3E2D]">No active goals yet</p>
            <p className="text-xs text-[#8B9B8D] max-w-xs">
              Add your first health goal to start tracking your progress.
            </p>
          </div>
        )}
      </section>

      {/* Timeline section */}
      <section aria-labelledby="timeline-heading">
        <h3
          id="timeline-heading"
          className="text-sm font-semibold text-[#2C3E2D] uppercase tracking-wide mb-3"
        >
          Timeline
        </h3>

        <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-[12px] bg-blue-50 border border-blue-100 flex items-center justify-center shrink-0"
              aria-hidden="true"
            >
              <CalendarDays size={18} className="text-[#0077B6]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-[#8B9B8D] uppercase tracking-wide font-medium mb-0.5">
                Projected Completion
              </p>
              <p className="text-sm font-bold text-[#2C3E2D]">
                Goal Completion: December 2026
              </p>
              <p className="text-xs text-[#555555] mt-0.5">
                Based on current session frequency
              </p>
            </div>
          </div>

          {/* Simple milestone strip */}
          <div className="mt-4 pt-4 border-t border-[rgba(44,62,45,0.1)]">
            <div className="flex items-center gap-0 overflow-x-auto pb-1">
              {[
                { label: 'Apr', done: true },
                { label: 'May', done: false },
                { label: 'Jun', done: false },
                { label: 'Jul', done: false },
                { label: 'Aug', done: false },
                { label: 'Sep', done: false },
                { label: 'Dec', done: false, isFinal: true },
              ].map((step, idx) => (
                <div key={idx} className="flex items-center shrink-0">
                  <div className="flex flex-col items-center gap-1">
                    <div
                      className={[
                        'w-3 h-3 rounded-full shrink-0',
                        step.isFinal
                          ? 'bg-[#0077B6] ring-2 ring-[#0077B6]/30'
                          : step.done
                          ? 'bg-[#2C3E2D]'
                          : 'bg-[rgba(44,62,45,0.1)]',
                      ].join(' ')}
                      aria-hidden="true"
                    />
                    <span className="text-[10px] text-[#8B9B8D] font-medium">
                      {step.label}
                    </span>
                  </div>
                  {idx < 6 && (
                    <div
                      className="h-px w-8 sm:w-12 bg-[rgba(44,62,45,0.1)] shrink-0"
                      aria-hidden="true"
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Add Goal CTA */}
      <button
        type="button"
        onClick={() => setShowAddModal(true)}
        className="w-full flex items-center justify-center gap-2 bg-white border-2 border-dashed border-[#6B8F71] text-[#6B8F71] hover:bg-[rgba(107,143,113,0.15)]/20 active:bg-[rgba(107,143,113,0.15)]/40 text-sm font-semibold py-3.5 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
        aria-label="Add a new health goal"
      >
        <Plus size={18} aria-hidden="true" />
        Add Goal
      </button>
    </div>
  );
}
