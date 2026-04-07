import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Compass,
  Menu,
  X,
  ChevronDown,
  Shield,
  Calendar,
  Zap,
  DollarSign,
  MapPin,
  ArrowRight,
  CheckCircle2,
  Home,
  Utensils,
  Brain,
  HeartPulse,
  Repeat2,
} from 'lucide-react';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface NavItem {
  label: string;
  href: string;
}

interface BentoCard {
  id: string;
  title: string;
  description: string;
  colSpan: 'col-span-2' | 'col-span-1';
  rowSpan: 'row-span-2' | 'row-span-1';
  variant: 'green-gradient' | 'dark' | 'white' | 'minimal';
}

interface TimelineStep {
  number: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}

interface ImpactStat {
  value: string;
  label: string;
  prefix: string;
  suffix: string;
  numeric: number;
  isDecimal: boolean;
}

interface AudienceFeature {
  text: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const NAV_ITEMS: NavItem[] = [
  { label: 'How It Works', href: '#how-it-works' },
  { label: 'Features', href: '#features' },
  { label: 'Impact', href: '#impact' },
  { label: 'Join', href: '#join' },
];

const TIMELINE_STEPS: TimelineStep[] = [
  {
    number: '01',
    title: 'Request',
    description:
      'Member submits their need — housing, food, mental health, or healthcare. Takes less than 3 minutes.',
    icon: <MapPin size={22} className="text-[#00B050]" aria-hidden="true" />,
  },
  {
    number: '02',
    title: 'Match',
    description:
      'Our algorithm instantly finds a CHW who speaks your language and knows your neighborhood.',
    icon: <Zap size={22} className="text-[#00B050]" aria-hidden="true" />,
  },
  {
    number: '03',
    title: 'Navigate',
    description:
      'Your CHW guides you through the system, tracks your goals, and stays with you until you succeed.',
    icon: <Compass size={22} className="text-[#00B050]" aria-hidden="true" />,
  },
];

const IMPACT_STATS: ImpactStat[] = [
  { value: '81%', label: 'member engagement target', prefix: '', suffix: '%', numeric: 81, isDecimal: false },
  { value: '$26.66', label: 'per unit Medi-Cal rate', prefix: '$', suffix: '', numeric: 26.66, isDecimal: true },
  { value: '24/7', label: 'on-demand access', prefix: '', suffix: '', numeric: 0, isDecimal: false },
  { value: '100%', label: 'free for members', prefix: '', suffix: '%', numeric: 100, isDecimal: false },
];

const MEMBER_FEATURES: AudienceFeature[] = [
  { text: 'Free for all Medi-Cal members' },
  { text: 'CHWs who speak your language' },
  { text: 'In-person, phone, or video sessions' },
  { text: 'No referral or insurance approval needed' },
];

const CHW_FEATURES: AudienceFeature[] = [
  { text: 'Flexible scheduling — your hours, your rules' },
  { text: '$26.66/unit Medi-Cal reimbursement' },
  { text: 'Build and grow your member panel' },
  { text: 'Real-time documentation tools' },
];

// ─── Hooks ────────────────────────────────────────────────────────────────────

/**
 * Returns a ref and a boolean indicating whether the element has ever
 * entered the viewport. Fires once and stays true.
 */
function useInView(threshold = 0.15): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return [ref, inView];
}

// ─── Sub-components ─────────────────────────────────────────────────────────────

/**
 * Animated count-up stat with glow text. Used in the dark Impact section.
 * Non-numeric values (like "24/7") are displayed immediately without counting.
 */
function GlowStat({ stat }: { stat: ImpactStat }) {
  const [ref, inView] = useInView(0.3);
  const [displayed, setDisplayed] = useState('0');
  const hasAnimated = useRef(false);

  useEffect(() => {
    if (!inView || hasAnimated.current) return;
    if (stat.numeric === 0) {
      setDisplayed(stat.value);
      hasAnimated.current = true;
      return;
    }

    hasAnimated.current = true;
    const duration = 1400;
    const steps = 50;
    const increment = stat.numeric / steps;
    let current = 0;
    let step = 0;

    const timer = setInterval(() => {
      step += 1;
      current = Math.min(current + increment, stat.numeric);
      const formatted = stat.isDecimal
        ? `${stat.prefix}${current.toFixed(2)}${stat.suffix}`
        : `${stat.prefix}${Math.round(current)}${stat.suffix}`;
      setDisplayed(formatted);
      if (step >= steps) {
        clearInterval(timer);
        setDisplayed(stat.value);
      }
    }, duration / steps);

    return () => clearInterval(timer);
  }, [inView, stat]);

  return (
    <div ref={ref} className="flex flex-col items-center text-center px-4 py-6">
      <span
        className="text-5xl md:text-6xl font-bold tabular-nums"
        style={{
          color: '#00B050',
          textShadow: '0 0 40px rgba(0,176,80,0.5), 0 0 80px rgba(0,176,80,0.2)',
        }}
        aria-label={stat.value}
      >
        {displayed}
      </span>
      <p className="mt-3 text-sm text-[#AAAAAA] font-medium max-w-[140px] leading-snug">
        {stat.label}
      </p>
    </div>
  );
}

/**
 * Wrapper that fades + slides an element in when it enters the viewport.
 * direction: 'up' (default), 'left', 'right'
 */
function AnimateIn({
  children,
  className = '',
  direction = 'up',
  delay = 0,
  threshold = 0.1,
}: {
  children: React.ReactNode;
  className?: string;
  direction?: 'up' | 'left' | 'right';
  delay?: number;
  threshold?: number;
}) {
  const [ref, inView] = useInView(threshold);

  const translate = {
    up: 'translateY(28px)',
    left: 'translateX(-28px)',
    right: 'translateX(28px)',
  }[direction];

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? 'none' : translate,
        transition: `opacity 0.6s ease ${delay}ms, transform 0.6s ease ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Horizontal animated timeline — the connecting line fills green via
 * CSS transition when the section scrolls into view.
 */
function HowItWorksTimeline() {
  const [sectionRef, sectionInView] = useInView(0.2);

  return (
    <div ref={sectionRef} className="relative">
      {/* Desktop connecting track */}
      <div
        className="hidden lg:block absolute top-[52px] left-[calc(16.67%)] right-[calc(16.67%)] h-[2px] bg-[#E5E7EB] overflow-hidden"
        aria-hidden="true"
      >
        <div
          className="h-full bg-[#00B050] origin-left"
          style={{
            transform: sectionInView ? 'scaleX(1)' : 'scaleX(0)',
            transition: 'transform 1.2s cubic-bezier(0.4, 0, 0.2, 1) 400ms',
          }}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {TIMELINE_STEPS.map((step, index) => (
          <AnimateIn key={step.title} direction="up" delay={index * 150}>
            <div className="flex flex-col items-center text-center">
              {/* Node */}
              <div className="relative z-10 w-[52px] h-[52px] rounded-full border-2 border-[#00B050] bg-white flex items-center justify-center mb-6 shadow-[0_0_0_6px_rgba(0,176,80,0.08)]">
                <span className="text-sm font-bold text-[#00B050]">{step.number}</span>
              </div>

              <div className="bg-white rounded-2xl border border-[#E5E7EB] p-7 shadow-sm hover:shadow-md transition-shadow w-full">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-[#F0FBF4] mb-4 mx-auto">
                  {step.icon}
                </div>
                <h3 className="text-xl font-bold text-[#1A1A1A] mb-3">{step.title}</h3>
                <p className="text-sm text-[#555555] leading-relaxed">{step.description}</p>
              </div>
            </div>
          </AnimateIn>
        ))}
      </div>
    </div>
  );
}

/**
 * Bento grid card — size and visual style vary per card variant.
 */
function BentoCard({ card }: { card: BentoCard }) {
  const [ref, inView] = useInView(0.1);

  const baseStyles = 'rounded-2xl overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:shadow-xl';

  const variantStyles: Record<BentoCard['variant'], string> = {
    'green-gradient': 'bg-gradient-to-br from-[#00B050] to-[#008F40] text-white',
    'dark': 'bg-[#1A1A1A] text-white',
    'white': 'bg-white border border-[#E5E7EB] text-[#1A1A1A]',
    'minimal': 'bg-[#F8FAFB] border border-[#E5E7EB] text-[#1A1A1A]',
  };

  return (
    <div
      ref={ref}
      className={`${baseStyles} ${variantStyles[card.variant]} ${card.colSpan} ${card.rowSpan} p-7 flex flex-col`}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? 'none' : 'translateY(20px)',
        transition: 'opacity 0.5s ease, transform 0.5s ease',
      }}
    >
      {card.id === 'smart-matching' && <SmartMatchingContent />}
      {card.id === 'earn-while-help' && <EarnWhileHelpContent />}
      {card.id === 'goal-roadmap' && <GoalRoadmapContent />}
      {card.id === 'hipaa' && <HipaaContent />}
      {card.id === 'calendar' && <CalendarContent />}
      {card.id === 'verticals' && <VerticalsContent />}
    </div>
  );
}

function SmartMatchingContent() {
  return (
    <>
      <div className="flex items-center gap-2 mb-2">
        <Zap size={18} className="text-white/70" aria-hidden="true" />
        <span className="text-xs font-semibold uppercase tracking-widest text-white/60">Smart Matching</span>
      </div>
      <h3 className="text-2xl font-bold leading-snug mb-3">
        The right CHW, every time.
      </h3>
      <p className="text-white/80 text-sm leading-relaxed flex-1">
        Our algorithm pairs you with a CHW who speaks your language, knows your
        neighborhood, and specializes in your exact needs. No guesswork, no waiting.
      </p>
      <div className="mt-5 flex gap-2 flex-wrap">
        {['Language match', 'Neighborhood aware', 'Specialty fit'].map((tag) => (
          <span
            key={tag}
            className="text-xs px-3 py-1 rounded-full bg-white/20 text-white font-medium"
          >
            {tag}
          </span>
        ))}
      </div>
    </>
  );
}

function EarnWhileHelpContent() {
  return (
    <>
      <div className="flex items-center gap-2 mb-2">
        <DollarSign size={18} className="text-[#00B050]" aria-hidden="true" />
        <span className="text-xs font-semibold uppercase tracking-widest text-[#AAAAAA]">Earn While You Help</span>
      </div>
      <h3 className="text-xl font-bold text-[#1A1A1A] mb-3">
        $26.66/unit Medi-Cal reimbursement.
      </h3>
      <p className="text-sm text-[#555555] leading-relaxed mb-5">
        Set your own schedule. Grow your member panel over time.
        The more you help, the more you earn.
      </p>
      {/* Mini earnings preview */}
      <div className="rounded-xl bg-[#F0FBF4] border border-[#D0F0D0] p-4 mt-auto">
        <p className="text-xs font-semibold text-[#AAAAAA] mb-3">This Week</p>
        <div className="flex items-end justify-between gap-1.5">
          {[6, 9, 5, 12, 8, 11, 7].map((h, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div
                className="w-full rounded-t-sm bg-[#00B050]"
                style={{ height: `${h * 4}px`, opacity: 0.6 + (h / 40) }}
              />
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-[#555555]">7 sessions</span>
          <span className="text-sm font-bold text-[#00B050]">$186.62</span>
        </div>
      </div>
    </>
  );
}

function GoalRoadmapContent() {
  const goals = [
    { label: 'Housing Application', pct: 78 },
    { label: 'CalFresh Enrollment', pct: 100 },
    { label: 'Mental Health Intake', pct: 40 },
  ];

  return (
    <>
      <div className="flex items-center gap-2 mb-2">
        <MapPin size={18} className="text-white/70" aria-hidden="true" />
        <span className="text-xs font-semibold uppercase tracking-widest text-white/60">Goal Roadmap</span>
      </div>
      <h3 className="text-xl font-bold mb-4">Track every milestone.</h3>
      <div className="space-y-4 flex-1">
        {goals.map((g) => (
          <div key={g.label}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-white/80">{g.label}</span>
              <span className="text-xs font-bold text-white">{g.pct}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/20 overflow-hidden">
              <div
                className="h-full rounded-full bg-[#00B050]"
                style={{ width: `${g.pct}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function HipaaContent() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-3">
      <div className="w-12 h-12 rounded-xl bg-[#F0FBF4] flex items-center justify-center">
        <Shield size={22} className="text-[#00B050]" aria-hidden="true" />
      </div>
      <p className="text-base font-bold text-[#1A1A1A]">HIPAA Compliant</p>
      <div className="flex items-center gap-1.5">
        <CheckCircle2 size={14} className="text-[#00B050]" aria-hidden="true" />
        <span className="text-xs text-[#555555]">End-to-end encrypted</span>
      </div>
    </div>
  );
}

function CalendarContent() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-3">
      <div className="w-12 h-12 rounded-xl bg-[#EFF6FF] flex items-center justify-center">
        <Calendar size={22} className="text-[#0077B6]" aria-hidden="true" />
      </div>
      <p className="text-base font-bold text-[#1A1A1A]">Calendar Sync</p>
      <p className="text-xs text-[#555555] leading-snug max-w-[140px]">
        Google Calendar, Apple, Outlook
      </p>
    </div>
  );
}

function VerticalsContent() {
  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-semibold uppercase tracking-widest text-[#AAAAAA]">5 Service Verticals</span>
      </div>
      <h3 className="text-2xl font-bold text-[#1A1A1A] mb-4">
        Every need, covered.
      </h3>
      <div className="flex flex-wrap gap-2.5 flex-1 content-start">
        {[
          { label: 'Housing', icon: <Home size={13} />, color: '#00B050', bg: '#F0FBF4' },
          { label: 'Food', icon: <Utensils size={13} />, color: '#F59E0B', bg: '#FFFBEB' },
          { label: 'Mental Health', icon: <Brain size={13} />, color: '#8B5CF6', bg: '#F5F3FF' },
          { label: 'Rehab', icon: <Repeat2 size={13} />, color: '#0077B6', bg: '#EFF6FF' },
          { label: 'Healthcare', icon: <HeartPulse size={13} />, color: '#EC4899', bg: '#FDF2F8' },
        ].map((v) => (
          <span
            key={v.label}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full"
            style={{ color: v.color, backgroundColor: v.bg }}
          >
            {v.icon}
            {v.label}
          </span>
        ))}
      </div>
      <p className="text-sm text-[#555555] leading-relaxed mt-4">
        One platform covers all five social determinants of health — so no need ever falls through the cracks.
      </p>
    </>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

/**
 * Landing Page Variant C — "Bold Modern Startup Meets Healthcare"
 *
 * Dark hero (near-black) with bright green accents, bento grid features,
 * horizontal scroll-animated timeline, cinematic impact section, and
 * a two-audience split. Inspired by Linear, Vercel, and Arc Browser.
 *
 * Scroll-triggered animations via IntersectionObserver (no external libs).
 * Fully responsive — Tailwind v4 utilities throughout.
 */
export function LandingPageC() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [heroPast, setHeroPast] = useState(false);
  const heroRef = useRef<HTMLDivElement>(null);

  // Track when viewport scrolls past the hero to flip nav appearance
  useEffect(() => {
    function handleScroll() {
      const hero = heroRef.current;
      if (!hero) return;
      setHeroPast(window.scrollY > hero.offsetHeight - 80);
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleAnchorClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
      if (!href.startsWith('#')) return;
      e.preventDefault();
      const target = document.querySelector(href);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setMobileMenuOpen(false);
    },
    [],
  );

  // Bento card definitions — layout driven by col/row span
  const BENTO_CARDS: BentoCard[] = [
    { id: 'smart-matching', title: '', description: '', colSpan: 'col-span-2', rowSpan: 'row-span-1', variant: 'green-gradient' },
    { id: 'earn-while-help', title: '', description: '', colSpan: 'col-span-1', rowSpan: 'row-span-2', variant: 'white' },
    { id: 'hipaa', title: '', description: '', colSpan: 'col-span-1', rowSpan: 'row-span-1', variant: 'minimal' },
    { id: 'calendar', title: '', description: '', colSpan: 'col-span-1', rowSpan: 'row-span-1', variant: 'minimal' },
    { id: 'goal-roadmap', title: '', description: '', colSpan: 'col-span-1', rowSpan: 'row-span-1', variant: 'dark' },
    { id: 'verticals', title: '', description: '', colSpan: 'col-span-2', rowSpan: 'row-span-1', variant: 'white' },
  ];

  return (
    <div className="min-h-screen bg-[#0A0A0A] font-sans antialiased overflow-x-hidden">

      {/* ─── Navigation ──────────────────────────────────────────────────────────── */}
      <header
        className="fixed top-0 left-0 right-0 z-50 transition-all duration-300"
        style={{
          backgroundColor: heroPast ? 'rgba(255,255,255,0.97)' : 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderBottom: heroPast ? '1px solid #E5E7EB' : '1px solid rgba(255,255,255,0.08)',
        }}
        role="banner"
      >
        <nav
          className="max-w-7xl mx-auto px-5 h-16 flex items-center justify-between"
          aria-label="Main navigation"
        >
          {/* Logo */}
          <Link
            to="/landing"
            className="flex items-center gap-2.5 shrink-0"
            aria-label="CompassCHW home"
          >
            <div className="w-8 h-8 rounded-lg bg-[#00B050] flex items-center justify-center shadow-[0_0_12px_rgba(0,176,80,0.4)]">
              <Compass size={17} className="text-white" aria-hidden="true" />
            </div>
            <span
              className="text-[17px] font-bold transition-colors duration-300"
              style={{ color: heroPast ? '#1A1A1A' : '#FFFFFF' }}
            >
              <span className="text-[#00B050]">Compass</span>CHW
            </span>
          </Link>

          {/* Desktop nav links */}
          <ul className="hidden md:flex items-center gap-7 list-none m-0 p-0" role="list">
            {NAV_ITEMS.map((item) => (
              <li key={item.label}>
                <a
                  href={item.href}
                  onClick={(e) => handleAnchorClick(e, item.href)}
                  className="text-sm font-medium transition-colors duration-300"
                  style={{ color: heroPast ? '#555555' : 'rgba(255,255,255,0.7)' }}
                  onMouseEnter={(e) => {
                    (e.target as HTMLElement).style.color = heroPast ? '#1A1A1A' : '#FFFFFF';
                  }}
                  onMouseLeave={(e) => {
                    (e.target as HTMLElement).style.color = heroPast ? '#555555' : 'rgba(255,255,255,0.7)';
                  }}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>

          {/* Desktop CTAs */}
          <div className="hidden md:flex items-center gap-3">
            <Link
              to="/login"
              className="text-sm font-medium transition-colors duration-300 px-3 py-1.5 rounded-lg"
              style={{ color: heroPast ? '#555555' : 'rgba(255,255,255,0.8)' }}
            >
              Log In
            </Link>
            <Link
              to="/register"
              className="text-sm font-semibold bg-[#00B050] hover:bg-[#008F40] text-white px-5 py-2 rounded-lg transition-all duration-200"
              style={{
                boxShadow: heroPast
                  ? '0 1px 3px rgba(0,0,0,0.1)'
                  : '0 0 20px rgba(0,176,80,0.3)',
              }}
            >
              Get Started
            </Link>
          </div>

          {/* Mobile hamburger */}
          <button
            type="button"
            className="md:hidden p-2 rounded-lg transition-colors"
            style={{ color: heroPast ? '#1A1A1A' : 'rgba(255,255,255,0.8)' }}
            aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-nav"
            onClick={() => setMobileMenuOpen((s) => !s)}
          >
            {mobileMenuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </nav>

        {/* Mobile slide-out */}
        {mobileMenuOpen && (
          <div
            id="mobile-nav"
            className="md:hidden px-5 py-5 flex flex-col gap-4"
            style={{
              backgroundColor: heroPast ? '#FFFFFF' : '#0A0A0A',
              borderTop: heroPast ? '1px solid #E5E7EB' : '1px solid rgba(255,255,255,0.08)',
            }}
            role="dialog"
            aria-label="Mobile navigation menu"
          >
            {NAV_ITEMS.map((item) => (
              <a
                key={item.label}
                href={item.href}
                onClick={(e) => handleAnchorClick(e, item.href)}
                className="text-base font-medium py-1 transition-colors"
                style={{ color: heroPast ? '#1A1A1A' : '#FFFFFF' }}
              >
                {item.label}
              </a>
            ))}
            <div
              className="pt-4 flex flex-col gap-3"
              style={{ borderTop: heroPast ? '1px solid #E5E7EB' : '1px solid rgba(255,255,255,0.1)' }}
            >
              <Link
                to="/login"
                className="text-sm font-medium py-1"
                style={{ color: heroPast ? '#555555' : 'rgba(255,255,255,0.7)' }}
                onClick={() => setMobileMenuOpen(false)}
              >
                Log In
              </Link>
              <Link
                to="/register"
                className="text-sm font-semibold bg-[#00B050] hover:bg-[#008F40] text-white px-5 py-2.5 rounded-lg text-center transition-colors shadow-[0_0_20px_rgba(0,176,80,0.3)]"
                onClick={() => setMobileMenuOpen(false)}
              >
                Get Started
              </Link>
            </div>
          </div>
        )}
      </header>

      <main id="main-content">

        {/* ─── Hero ──────────────────────────────────────────────────────────────── */}
        <section
          ref={heroRef}
          className="relative min-h-screen flex flex-col items-center justify-center px-5 text-center overflow-hidden"
          style={{ background: '#0A0A0A' }}
          aria-labelledby="hero-headline"
        >
          {/* Radial green glow behind headline */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: 'radial-gradient(ellipse 80% 60% at 50% 40%, rgba(0,176,80,0.12) 0%, transparent 70%)',
            }}
            aria-hidden="true"
          />

          {/* Dot-grid texture */}
          <div
            className="absolute inset-0 pointer-events-none opacity-20"
            style={{
              backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.15) 1px, transparent 1px)',
              backgroundSize: '32px 32px',
            }}
            aria-hidden="true"
          />

          {/* Floating glass stat — top right */}
          <div
            className="absolute top-28 right-6 md:right-16 lg:right-24 hidden sm:flex flex-col items-start px-4 py-3 rounded-xl z-10"
            style={{
              background: 'rgba(255,255,255,0.08)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              border: '1px solid rgba(255,255,255,0.15)',
            }}
            aria-label="81% engagement target"
          >
            <span className="text-2xl font-bold text-white">81%</span>
            <span className="text-xs text-[#AAAAAA] mt-0.5">engagement target</span>
          </div>

          {/* Floating glass stat — bottom left */}
          <div
            className="absolute bottom-32 left-6 md:left-16 lg:left-24 hidden sm:flex flex-col items-start px-4 py-3 rounded-xl z-10"
            style={{
              background: 'rgba(255,255,255,0.08)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              border: '1px solid rgba(255,255,255,0.15)',
            }}
            aria-label="$26.66 per unit rate"
          >
            <span className="text-2xl font-bold text-white">$26.66</span>
            <span className="text-xs text-[#AAAAAA] mt-0.5">per unit rate</span>
          </div>

          {/* Main hero content */}
          <div className="relative z-10 max-w-4xl mx-auto">
            {/* Eyebrow */}
            <div
              className="inline-flex items-center gap-2 text-xs font-semibold px-4 py-1.5 rounded-full mb-10"
              style={{
                background: 'rgba(0,176,80,0.12)',
                border: '1px solid rgba(0,176,80,0.3)',
                color: '#00B050',
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#00B050] animate-pulse" aria-hidden="true" />
              Now available in Los Angeles, CA
            </div>

            {/* Headline */}
            <h1
              id="hero-headline"
              className="text-6xl sm:text-7xl md:text-8xl font-bold leading-[1.0] tracking-tight"
            >
              <span className="block text-white">Navigate Health.</span>
              <span
                className="block"
                style={{
                  color: '#00B050',
                  textShadow: '0 0 60px rgba(0,176,80,0.4)',
                }}
              >
                Navigate Life.
              </span>
            </h1>

            {/* Sub-copy */}
            <p className="mt-7 text-lg md:text-xl text-[#AAAAAA] leading-relaxed max-w-2xl mx-auto">
              The first gig-economy marketplace connecting Community Health Workers
              with people who need help navigating housing, food, mental health, and
              healthcare systems.
            </p>

            {/* CTA */}
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link
                to="/register"
                className="group relative inline-flex items-center gap-2 text-base font-semibold text-white px-8 py-4 rounded-xl transition-all duration-200 hover:-translate-y-0.5"
                style={{
                  background: '#00B050',
                  boxShadow: '0 0 0 0 rgba(0,176,80,0.4)',
                  animation: 'glow-pulse 2.5s ease-in-out infinite',
                }}
              >
                Get Started — It's Free
                <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
            </div>

            {/* Scroll indicator */}
            <div className="mt-16 flex flex-col items-center gap-2" aria-hidden="true">
              <span className="text-xs text-[#555555] tracking-widest uppercase">Scroll</span>
              <ChevronDown
                size={20}
                className="text-[#555555]"
                style={{ animation: 'bounce-y 1.4s ease-in-out infinite' }}
              />
            </div>
          </div>

          {/* Keyframe styles injected via style tag */}
          <style>{`
            @keyframes glow-pulse {
              0%, 100% { box-shadow: 0 0 20px rgba(0,176,80,0.3), 0 4px 14px rgba(0,0,0,0.3); }
              50%       { box-shadow: 0 0 40px rgba(0,176,80,0.5), 0 4px 14px rgba(0,0,0,0.3); }
            }
            @keyframes bounce-y {
              0%, 100% { transform: translateY(0); }
              50%       { transform: translateY(6px); }
            }
          `}</style>
        </section>

        {/* ─── Bento Grid Features ──────────────────────────────────────────────── */}
        <section
          id="features"
          className="py-24 px-5 bg-white scroll-mt-16"
          aria-labelledby="features-heading"
        >
          <div className="max-w-6xl mx-auto">
            <AnimateIn className="mb-14 text-center">
              <p className="text-xs font-semibold uppercase tracking-widest text-[#00B050] mb-3">
                Platform
              </p>
              <h2
                id="features-heading"
                className="text-5xl font-bold text-[#1A1A1A] tracking-tight"
              >
                Everything you need.
              </h2>
            </AnimateIn>

            {/* Bento grid — 4 cols on desktop, collapses on mobile */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 auto-rows-[220px]">
              {BENTO_CARDS.map((card) => (
                // On mobile, all cards are single col/row
                <div
                  key={card.id}
                  className={`${card.colSpan === 'col-span-2' ? 'lg:col-span-2' : ''} ${card.rowSpan === 'row-span-2' ? 'lg:row-span-2' : ''}`}
                >
                  <BentoCard card={card} />
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ─── How It Works ─────────────────────────────────────────────────────── */}
        <section
          id="how-it-works"
          className="py-24 px-5 scroll-mt-16"
          style={{ background: '#F8FAFB' }}
          aria-labelledby="how-it-works-heading"
        >
          <div className="max-w-5xl mx-auto">
            <AnimateIn className="mb-16 text-center">
              <p className="text-xs font-semibold uppercase tracking-widest text-[#00B050] mb-3">
                The Process
              </p>
              <h2
                id="how-it-works-heading"
                className="text-5xl font-bold text-[#1A1A1A] tracking-tight"
              >
                How CompassCHW Works
              </h2>
            </AnimateIn>

            <HowItWorksTimeline />
          </div>
        </section>

        {/* ─── Two Audiences ───────────────────────────────────────────────────── */}
        <section
          id="join"
          className="py-24 px-5 bg-white scroll-mt-16"
          aria-labelledby="audiences-heading"
        >
          <h2 id="audiences-heading" className="sr-only">
            CompassCHW for Members and Community Health Workers
          </h2>
          <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* Members card — dark */}
            <AnimateIn direction="left">
              <article
                className="rounded-2xl p-9 flex flex-col h-full"
                style={{ background: '#1A1A1A' }}
                aria-label="For Community Members"
              >
                <span
                  className="inline-flex items-center self-start text-xs font-semibold px-3 py-1 rounded-full mb-6"
                  style={{ background: 'rgba(0,176,80,0.15)', color: '#00B050' }}
                >
                  For Community Members
                </span>
                <h3 className="text-2xl font-bold text-white leading-snug mb-3">
                  Free healthcare navigation, covered by your health plan.
                </h3>
                <p className="text-sm text-[#AAAAAA] leading-relaxed mb-7">
                  A dedicated CHW guides you through the system —
                  housing, food, healthcare, and more. At zero cost to you.
                </p>
                <ul className="space-y-3 mb-8 flex-1" role="list">
                  {MEMBER_FEATURES.map((f) => (
                    <li key={f.text} className="flex items-start gap-3">
                      <div
                        className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
                        style={{ background: '#00B050' }}
                        aria-hidden="true"
                      />
                      <span className="text-sm text-[#CCCCCC]">{f.text}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  to="/register"
                  className="inline-flex items-center justify-center gap-2 text-sm font-semibold text-[#1A1A1A] bg-white hover:bg-[#F0FBF4] px-6 py-3 rounded-xl transition-colors self-start"
                >
                  Find Help
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
              </article>
            </AnimateIn>

            {/* CHW card — white with blue accents */}
            <AnimateIn direction="right">
              <article
                className="rounded-2xl p-9 flex flex-col h-full border"
                style={{ background: '#FFFFFF', borderColor: '#E5E7EB' }}
                aria-label="For Community Health Workers"
              >
                <span
                  className="inline-flex items-center self-start text-xs font-semibold px-3 py-1 rounded-full mb-6"
                  style={{ background: 'rgba(0,119,182,0.1)', color: '#0077B6' }}
                >
                  For CHWs
                </span>
                <h3 className="text-2xl font-bold text-[#1A1A1A] leading-snug mb-3">
                  Flexible work, Medi-Cal reimbursement, meaningful impact.
                </h3>
                <p className="text-sm text-[#555555] leading-relaxed mb-7">
                  Set your own hours, grow your panel, and earn Medi-Cal
                  reimbursements doing work that genuinely changes lives.
                </p>
                <ul className="space-y-3 mb-8 flex-1" role="list">
                  {CHW_FEATURES.map((f) => (
                    <li key={f.text} className="flex items-start gap-3">
                      <div
                        className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
                        style={{ background: '#0077B6' }}
                        aria-hidden="true"
                      />
                      <span className="text-sm text-[#555555]">{f.text}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  to="/register"
                  className="inline-flex items-center justify-center gap-2 text-sm font-semibold text-white px-6 py-3 rounded-xl transition-colors self-start"
                  style={{ background: '#0077B6' }}
                  onMouseEnter={(e) => ((e.target as HTMLElement).style.background = '#005A8C')}
                  onMouseLeave={(e) => ((e.target as HTMLElement).style.background = '#0077B6')}
                >
                  Start Earning
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
              </article>
            </AnimateIn>
          </div>
        </section>

        {/* ─── Impact Section (dark, cinematic) ────────────────────────────────── */}
        <section
          id="impact"
          className="relative py-28 px-5 scroll-mt-16 overflow-hidden"
          style={{ background: '#0A0A0A' }}
          aria-labelledby="impact-heading"
        >
          {/* Dot-grid background texture */}
          <div
            className="absolute inset-0 pointer-events-none opacity-15"
            style={{
              backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.2) 1px, transparent 1px)',
              backgroundSize: '28px 28px',
            }}
            aria-hidden="true"
          />

          {/* Subtle radial glow */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: 'radial-gradient(ellipse 70% 50% at 50% 50%, rgba(0,176,80,0.06) 0%, transparent 70%)',
            }}
            aria-hidden="true"
          />

          <div className="relative z-10 max-w-5xl mx-auto text-center">
            <AnimateIn>
              <p className="text-xs font-semibold uppercase tracking-widest text-[#00B050] mb-3">
                By the Numbers
              </p>
              <h2
                id="impact-heading"
                className="text-5xl font-bold text-white tracking-tight mb-16"
              >
                Impact
              </h2>
            </AnimateIn>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-0 divide-x divide-y lg:divide-y-0 divide-white/10 rounded-2xl overflow-hidden"
              style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)' }}
            >
              {IMPACT_STATS.map((stat) => (
                <GlowStat key={stat.value} stat={stat} />
              ))}
            </div>

            <p className="text-xs text-[#555555] mt-8 max-w-lg mx-auto leading-relaxed">
              Modeled on CityBlock Health's 81% engagement benchmark for Medicaid populations.
              Reimbursement rates based on current Medi-Cal CHW billing codes.
            </p>
          </div>
        </section>

        {/* ─── Final CTA ───────────────────────────────────────────────────────── */}
        <section
          className="relative py-28 px-5 overflow-hidden"
          aria-labelledby="cta-heading"
          style={{ background: 'linear-gradient(135deg, #00B050 0%, #008F40 50%, #007A35 100%)' }}
        >
          {/* Noise/texture overlay */}
          <div
            className="absolute inset-0 pointer-events-none opacity-10"
            style={{
              backgroundImage: 'radial-gradient(circle at 20% 80%, rgba(0,0,0,0.3) 0%, transparent 50%), radial-gradient(circle at 80% 20%, rgba(255,255,255,0.15) 0%, transparent 50%)',
            }}
            aria-hidden="true"
          />

          <div className="relative z-10 max-w-3xl mx-auto text-center">
            <AnimateIn>
              <h2
                id="cta-heading"
                className="text-4xl md:text-5xl font-bold text-white leading-snug mb-4"
              >
                Ready to change how healthcare navigation works?
              </h2>
              <p className="text-white/80 text-lg mb-10">
                Join the first CHW marketplace in Los Angeles.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <Link
                  to="/register"
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 font-semibold text-[#00B050] bg-white hover:bg-[#F0FBF4] px-8 py-4 rounded-xl text-base transition-colors shadow-lg"
                >
                  Get Started Free
                </Link>
                <a
                  href="#how-it-works"
                  onClick={(e) => handleAnchorClick(e, '#how-it-works')}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 font-semibold text-white border-2 border-white/40 hover:border-white hover:bg-white/10 px-8 py-4 rounded-xl text-base transition-colors"
                >
                  Learn More
                </a>
              </div>
            </AnimateIn>
          </div>
        </section>

      </main>

      {/* ─── Footer ──────────────────────────────────────────────────────────────── */}
      <footer
        className="px-5 py-8"
        style={{ background: '#0A0A0A', borderTop: '1px solid rgba(255,255,255,0.08)' }}
        role="contentinfo"
      >
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">

          {/* Logo + tagline */}
          <Link
            to="/landing"
            className="flex items-center gap-2 shrink-0"
            aria-label="CompassCHW home"
          >
            <div className="w-7 h-7 rounded-lg bg-[#00B050] flex items-center justify-center">
              <Compass size={14} className="text-white" aria-hidden="true" />
            </div>
            <span className="text-sm font-bold text-white">
              <span className="text-[#00B050]">Compass</span>CHW
            </span>
          </Link>

          {/* Center tagline */}
          <p className="text-xs text-[#555555] text-center">
            © 2026 CompassCHW · Built in Los Angeles · Care Navigation. On Demand.
          </p>

          {/* Legal links */}
          <nav aria-label="Legal links" className="flex items-center gap-4">
            {[
              { label: 'Privacy', href: '#' },
              { label: 'Terms', href: '#' },
              { label: 'HIPAA', href: '#' },
            ].map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="text-xs text-[#555555] hover:text-[#AAAAAA] transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>
      </footer>

    </div>
  );
}
