import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  Compass,
  Menu,
  X,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Handshake,
  Phone,
  Target,
  Quote,
} from 'lucide-react';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface NavItem {
  label: string;
  href: string;
}

interface HowItWorksStep {
  emoji: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}

interface StatItem {
  value: string;
  label: string;
  color: 'green' | 'blue';
}

interface TestimonialItem {
  quote: string;
  name: string;
  role: string;
  initials: string;
  accentColor: 'green' | 'blue';
}

interface ServiceAreaItem {
  emoji: string;
  title: string;
  description: string;
  borderColor: string;
}

interface AudienceFeature {
  text: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const NAV_ITEMS: NavItem[] = [
  { label: 'How It Works', href: '#how-it-works' },
  { label: 'Impact', href: '#impact' },
  { label: 'For CHWs', href: '#for-chws' },
  { label: 'For Members', href: '#for-members' },
];

const STAT_PILLS: string[] = [
  '90% target adherence',
  '5 service areas',
  '$0 cost to members',
];

const HOW_IT_WORKS_STEPS: HowItWorksStep[] = [
  {
    emoji: '📋',
    title: 'Share Your Needs',
    description: 'Tell us about your situation — housing, food, health, or recovery. No referral needed.',
    icon: <ClipboardList size={22} className="text-[#6B8F71]" aria-hidden="true" />,
  },
  {
    emoji: '🤝',
    title: 'Get Matched',
    description: 'We pair you with a local CHW who speaks your language and knows your community.',
    icon: <Handshake size={22} className="text-[#6B8F71]" aria-hidden="true" />,
  },
  {
    emoji: '📞',
    title: 'Connect',
    description: 'Meet in person, by phone, or video — wherever you feel comfortable.',
    icon: <Phone size={22} className="text-[#6B8F71]" aria-hidden="true" />,
  },
  {
    emoji: '🎯',
    title: 'Reach Your Goals',
    description: 'Track your progress on a personalized roadmap. Small steps, lasting change.',
    icon: <Target size={22} className="text-[#6B8F71]" aria-hidden="true" />,
  },
];

const IMPACT_STATS: StatItem[] = [
  { value: '81%', label: 'Target member engagement rate', color: 'green' },
  { value: '$26.66', label: 'Medi-Cal reimbursement per unit', color: 'blue' },
  { value: '5', label: 'Core service verticals', color: 'green' },
  { value: '100%', label: 'Free for Medi-Cal members', color: 'green' },
];

const TESTIMONIALS: TestimonialItem[] = [
  {
    quote: 'My CHW helped me find stable housing and enroll in CalFresh. I didn\'t know these programs existed.',
    name: 'Rosa D.',
    role: 'Community Member',
    initials: 'RD',
    accentColor: 'green',
  },
  {
    quote: 'I love setting my own schedule and knowing I\'m making real impact in my neighborhood.',
    name: 'Maria R.',
    role: 'Community Health Worker',
    initials: 'MR',
    accentColor: 'blue',
  },
  {
    quote: 'After 60 days sober, my CHW connected me with an outpatient program covered by Medi-Cal. It changed my life.',
    name: 'Marcus J.',
    role: 'Community Member',
    initials: 'MJ',
    accentColor: 'green',
  },
];

const MEMBER_FEATURES: AudienceFeature[] = [
  { text: 'Free for all Medi-Cal members' },
  { text: 'CHWs who speak your language' },
  { text: 'In-person, phone, or video sessions' },
  { text: 'Housing, food, health, and recovery support' },
  { text: 'No referral or insurance approval needed' },
];

const CHW_FEATURES: AudienceFeature[] = [
  { text: 'Flexible scheduling — you set your hours' },
  { text: 'Medi-Cal reimbursements per session' },
  { text: 'Build your member panel over time' },
  { text: 'Real-time documentation tools' },
  { text: 'Training and onboarding support' },
];

const SERVICE_AREAS: ServiceAreaItem[] = [
  {
    emoji: '🏠',
    title: 'Housing Assistance',
    description: 'Emergency housing, rental aid, and shelter navigation',
    borderColor: '#6B8F71',
  },
  {
    emoji: '💊',
    title: 'Rehab & Recovery',
    description: 'Substance use programs, sober support, and Medi-Cal coverage',
    borderColor: '#0077B6',
  },
  {
    emoji: '🥗',
    title: 'Food & Pantry',
    description: 'CalFresh enrollment, food banks, and meal programs',
    borderColor: '#6B8F71',
  },
  {
    emoji: '🧠',
    title: 'Mental Health',
    description: 'Counseling referrals, crisis support, and wellness resources',
    borderColor: '#0077B6',
  },
  {
    emoji: '🏥',
    title: 'Healthcare Navigation',
    description: 'Medi-Cal enrollment, appointment scheduling, and care coordination',
    borderColor: '#6B8F71',
  },
];

// ─── Sub-components ─────────────────────────────────────────────────────────────

/**
 * Animated counter that counts up from 0 when the element enters the viewport.
 * Handles numeric strings like "81%", "$26.66", "5", "100%".
 */
function AnimatedStat({ value, label, color }: StatItem) {
  const ref = useRef<HTMLDivElement>(null);
  const [displayed, setDisplayed] = useState('0');
  const [hasAnimated, setHasAnimated] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasAnimated) {
          setHasAnimated(true);
          // Parse the numeric portion for counting
          const prefix = value.startsWith('$') ? '$' : '';
          const suffix = value.endsWith('%') ? '%' : '';
          const raw = value.replace(/[$%]/g, '');
          const target = parseFloat(raw);

          if (isNaN(target)) {
            setDisplayed(value);
            return;
          }

          const duration = 1200;
          const steps = 40;
          const increment = target / steps;
          let current = 0;
          let step = 0;

          const timer = setInterval(() => {
            step += 1;
            current = Math.min(current + increment, target);
            const formatted =
              Number.isInteger(target)
                ? `${prefix}${Math.round(current)}${suffix}`
                : `${prefix}${current.toFixed(2)}${suffix}`;
            setDisplayed(formatted);

            if (step >= steps) {
              clearInterval(timer);
              setDisplayed(value);
            }
          }, duration / steps);
        }
      },
      { threshold: 0.3 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [value, hasAnimated]);

  const colorClass = color === 'green' ? 'text-[#6B8F71]' : 'text-[#0077B6]';

  return (
    <div ref={ref} className="flex flex-col items-center text-center px-6 py-8">
      <span
        className={`text-6xl font-bold tracking-tight tabular-nums ${colorClass}`}
        aria-label={value}
      >
        {displayed}
      </span>
      <p className="mt-3 text-sm text-[#555555] font-medium max-w-[160px] leading-snug">
        {label}
      </p>
    </div>
  );
}

/**
 * Single testimonial card with left-border accent and large quote mark.
 */
function TestimonialCard({ quote, name, role, initials, accentColor }: TestimonialItem) {
  const borderColor = accentColor === 'green' ? '#6B8F71' : '#0077B6';
  const avatarBg = accentColor === 'green' ? 'bg-[rgba(107,143,113,0.15)] text-[#6B8F71]' : 'bg-[#DBEAFE] text-[#0077B6]';

  return (
    <article
      className="bg-white rounded-2xl p-7 shadow-sm border border-[rgba(44,62,45,0.1)] flex flex-col gap-5"
      style={{ borderLeft: `4px solid ${borderColor}` }}
    >
      <Quote size={28} className="text-[rgba(44,62,45,0.1)]" aria-hidden="true" />
      <p className="text-[#2C3E2D] text-base leading-relaxed flex-1">
        "{quote}"
      </p>
      <div className="flex items-center gap-3">
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${avatarBg}`}
          aria-hidden="true"
        >
          {initials}
        </div>
        <div>
          <p className="text-sm font-semibold text-[#2C3E2D]">{name}</p>
          <p className="text-xs text-[#8B9B8D]">{role}</p>
        </div>
      </div>
    </article>
  );
}

/**
 * Rotating stat pill that cycles through the STAT_PILLS array with a fade transition.
 */
function RotatingStatPill() {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % STAT_PILLS.length);
    }, 2800);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center justify-center gap-2 mt-6 flex-wrap">
      {STAT_PILLS.map((pill, i) => (
        <span
          key={pill}
          className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-all duration-300 ${
            i === activeIndex
              ? 'bg-[#2C3E2D] text-white border-[#6B8F71] opacity-100 scale-105'
              : 'bg-white text-[#555555] border-[rgba(44,62,45,0.1)] opacity-60'
          }`}
          aria-current={i === activeIndex ? 'true' : undefined}
        >
          {pill}
        </span>
      ))}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

/**
 * Landing Page Variant B — "Warm Healthcare Data + Human Stories"
 *
 * Inspired by Wellth: clean white backgrounds, large confident typography,
 * stats as the primary trust mechanism, and emotional testimonials.
 * Fully responsive; uses Tailwind v4 utility classes throughout.
 */
export function LandingPageB() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  // Track scroll to add subtle border to nav
  useEffect(() => {
    function handleScroll() {
      setScrolled(window.scrollY > 8);
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Smooth scroll for anchor links
  function handleAnchorClick(
    e: React.MouseEvent<HTMLAnchorElement>,
    href: string,
  ) {
    if (!href.startsWith('#')) return;
    e.preventDefault();
    const target = document.querySelector(href);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setMobileMenuOpen(false);
  }

  return (
    <div className="min-h-screen bg-white text-[#2C3E2D] font-sans antialiased">

      {/* ─── Navigation ────────────────────────────────────────────────────────── */}
      <header
        className={`fixed top-0 left-0 right-0 z-50 bg-white transition-all duration-200 ${
          scrolled ? 'border-b border-[rgba(44,62,45,0.1)]' : 'border-b border-transparent'
        }`}
        role="banner"
      >
        <nav
          className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between"
          aria-label="Main navigation"
        >
          {/* Wordmark */}
          <Link
            to="/landing"
            className="flex items-center gap-2 shrink-0"
            aria-label="CompassCHW home"
          >
            <div className="w-8 h-8 rounded-lg bg-[#2C3E2D] flex items-center justify-center">
              <Compass size={18} className="text-white" aria-hidden="true" />
            </div>
            <span className="text-[17px] font-bold">
              <span className="text-[#6B8F71]">Compass</span>
              <span className="text-[#2C3E2D]">CHW</span>
            </span>
          </Link>

          {/* Desktop center nav */}
          <ul className="hidden md:flex items-center gap-7 list-none m-0 p-0" role="list">
            {NAV_ITEMS.map((item) => (
              <li key={item.label}>
                <a
                  href={item.href}
                  onClick={(e) => handleAnchorClick(e, item.href)}
                  className="text-sm text-[#555555] hover:text-[#2C3E2D] font-medium transition-colors"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>

          {/* Desktop right CTAs */}
          <div className="hidden md:flex items-center gap-4">
            <Link
              to="/login"
              className="text-sm font-medium text-[#555555] hover:text-[#2C3E2D] transition-colors"
            >
              Sign In
            </Link>
            <Link
              to="/register"
              className="text-sm font-semibold bg-[#2C3E2D] hover:bg-[#3A5240] text-white px-5 py-2 rounded-full transition-colors"
            >
              Join CompassCHW
            </Link>
          </div>

          {/* Mobile hamburger */}
          <button
            type="button"
            className="md:hidden p-2 text-[#555555] hover:text-[#2C3E2D] transition-colors"
            aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-menu"
            onClick={() => setMobileMenuOpen((s) => !s)}
          >
            {mobileMenuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </nav>

        {/* Mobile menu drawer */}
        {mobileMenuOpen && (
          <div
            id="mobile-menu"
            className="md:hidden bg-white border-t border-[rgba(44,62,45,0.1)] px-5 py-5 flex flex-col gap-4"
            role="dialog"
            aria-label="Mobile navigation menu"
          >
            {NAV_ITEMS.map((item) => (
              <a
                key={item.label}
                href={item.href}
                onClick={(e) => handleAnchorClick(e, item.href)}
                className="text-base font-medium text-[#2C3E2D] py-1"
              >
                {item.label}
              </a>
            ))}
            <div className="pt-2 border-t border-[rgba(44,62,45,0.1)] flex flex-col gap-3">
              <Link
                to="/login"
                className="text-sm font-medium text-[#555555] py-1"
                onClick={() => setMobileMenuOpen(false)}
              >
                Sign In
              </Link>
              <Link
                to="/register"
                className="text-sm font-semibold bg-[#2C3E2D] text-white px-5 py-2.5 rounded-full text-center"
                onClick={() => setMobileMenuOpen(false)}
              >
                Join CompassCHW
              </Link>
            </div>
          </div>
        )}
      </header>

      <main id="main-content">

        {/* ─── Hero ──────────────────────────────────────────────────────────────── */}
        <section
          className="pt-32 pb-24 px-5 flex flex-col items-center text-center"
          aria-labelledby="hero-headline"
        >
          <div className="max-w-3xl mx-auto">
            {/* Eyebrow badge */}
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#6B8F71] bg-[rgba(107,143,113,0.08)] px-3 py-1 rounded-full mb-8">
              <span className="w-1.5 h-1.5 rounded-full bg-[#2C3E2D]" aria-hidden="true" />
              Free for Medi-Cal Members — Los Angeles, CA
            </span>

            {/* Stacked headline — Wellth cadence */}
            <h1
              id="hero-headline"
              className="text-5xl sm:text-6xl lg:text-7xl font-bold leading-[1.07] tracking-tight"
            >
              <span className="block text-[#8B9B8D] font-semibold">Daily motivation.</span>
              <span className="block text-[#8B9B8D] font-semibold mt-1">Lasting impact.</span>
              <span className="block text-[#2C3E2D] mt-2">
                It pays to be{' '}
                <em className="not-italic text-[#6B8F71] italic">healthy.</em>
              </span>
            </h1>

            {/* Sub-copy */}
            <p className="mt-7 text-lg text-[#555555] leading-relaxed max-w-2xl mx-auto">
              CompassCHW connects you with a Community Health Worker who navigates
              housing, food, healthcare, and mental health resources —
              <strong className="text-[#2C3E2D] font-semibold"> at no cost to you.</strong>
            </p>

            {/* CTA */}
            <div className="mt-9">
              <a
                href="#how-it-works"
                onClick={(e) => handleAnchorClick(e, '#how-it-works')}
                className="inline-flex items-center gap-2 bg-[#2C3E2D] hover:bg-[#3A5240] text-white font-semibold px-7 py-3.5 rounded-full text-base transition-colors shadow-sm"
                aria-label="See how CompassCHW works"
              >
                See How It Works
                <ArrowRight size={17} aria-hidden="true" />
              </a>
            </div>

            {/* Rotating stat pills */}
            <RotatingStatPill />
          </div>
        </section>

        {/* ─── How It Works ──────────────────────────────────────────────────────── */}
        <section
          id="how-it-works"
          className="py-24 px-5 bg-white scroll-mt-16"
          aria-labelledby="how-it-works-heading"
        >
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-14">
              <p className="text-xs font-semibold uppercase tracking-widest text-[#6B8F71] mb-3">
                The Process
              </p>
              <h2
                id="how-it-works-heading"
                className="text-4xl font-bold text-[#2C3E2D]"
              >
                How It Works
              </h2>
            </div>

            {/* Steps grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 relative">
              {/* Connecting line — visible on large screens only */}
              <div
                className="hidden lg:block absolute top-[52px] left-[calc(12.5%+32px)] right-[calc(12.5%+32px)] h-px bg-[rgba(107,143,113,0.15)]"
                aria-hidden="true"
              />

              {HOW_IT_WORKS_STEPS.map((step, index) => (
                <div
                  key={step.title}
                  className="relative flex flex-col items-center text-center bg-white rounded-2xl border border-[rgba(44,62,45,0.1)] p-7 shadow-sm hover:shadow-md transition-shadow"
                >
                  {/* Step number badge */}
                  <div className="w-10 h-10 rounded-full bg-[rgba(107,143,113,0.08)] border-2 border-[#D0F0D0] flex items-center justify-center mb-4 z-10 relative">
                    <span className="text-sm font-bold text-[#6B8F71]">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                  </div>

                  {/* Emoji */}
                  <span className="text-3xl mb-3" role="img" aria-hidden="true">
                    {step.emoji}
                  </span>

                  <h3 className="text-base font-semibold text-[#2C3E2D] mb-2">
                    {step.title}
                  </h3>
                  <p className="text-sm text-[#555555] leading-relaxed">
                    {step.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ─── Impact Numbers ────────────────────────────────────────────────────── */}
        <section
          id="impact"
          className="py-24 px-5 bg-[rgba(107,143,113,0.08)] scroll-mt-16"
          aria-labelledby="impact-heading"
        >
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-14">
              <p className="text-xs font-semibold uppercase tracking-widest text-[#6B8F71] mb-3">
                By the Numbers
              </p>
              <h2
                id="impact-heading"
                className="text-4xl font-bold text-[#2C3E2D]"
              >
                Real Impact. Real Numbers.
              </h2>
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-[#D0F0D0] bg-white rounded-2xl border border-[#D0F0D0] overflow-hidden shadow-sm">
              {IMPACT_STATS.map((stat) => (
                <AnimatedStat key={stat.value} {...stat} />
              ))}
            </div>

            {/* Attribution */}
            <p className="text-center text-xs text-[#8B9B8D] mt-6 max-w-xl mx-auto leading-relaxed">
              Modeled on CityBlock Health's 81% engagement benchmark for Medicaid populations.
              Reimbursement rates based on current Medi-Cal CHW billing codes.
            </p>
          </div>
        </section>

        {/* ─── Testimonials ──────────────────────────────────────────────────────── */}
        <section
          className="py-24 px-5 bg-white"
          aria-labelledby="testimonials-heading"
        >
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-14">
              <p className="text-xs font-semibold uppercase tracking-widest text-[#0077B6] mb-3">
                Community Voices
              </p>
              <h2
                id="testimonials-heading"
                className="text-4xl font-bold text-[#2C3E2D]"
              >
                Stories From Our Community
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {TESTIMONIALS.map((t) => (
                <TestimonialCard key={t.name} {...t} />
              ))}
            </div>
          </div>
        </section>

        {/* ─── Two-Audience Split ────────────────────────────────────────────────── */}
        <section
          id="for-members"
          className="scroll-mt-16"
          aria-labelledby="audience-split-heading"
        >
          {/* Hidden heading for screen readers */}
          <h2 id="audience-split-heading" className="sr-only">
            CompassCHW for Members and Community Health Workers
          </h2>

          <div className="grid grid-cols-1 lg:grid-cols-2">
            {/* Left — Members */}
            <div
              id="for-members"
              className="bg-[rgba(107,143,113,0.08)] px-10 py-16 lg:px-14 lg:py-20"
            >
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#6B8F71] bg-white px-3 py-1 rounded-full mb-6">
                For Community Members
              </span>
              <h3 className="text-3xl font-bold text-[#2C3E2D] leading-snug mb-5">
                Get the support you deserve — at no cost.
              </h3>
              <p className="text-base text-[#555555] leading-relaxed mb-8">
                Get matched with a CHW who speaks your language, knows your
                community, and navigates resources for you.
              </p>

              <ul className="space-y-3 mb-9" role="list">
                {MEMBER_FEATURES.map((f) => (
                  <li key={f.text} className="flex items-start gap-3">
                    <CheckCircle2
                      size={18}
                      className="text-[#6B8F71] mt-0.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="text-sm text-[#2C3E2D]">{f.text}</span>
                  </li>
                ))}
              </ul>

              <Link
                to="/register"
                className="inline-flex items-center gap-2 bg-[#2C3E2D] hover:bg-[#3A5240] text-white font-semibold px-6 py-3 rounded-full text-sm transition-colors"
              >
                Find Help Now
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
            </div>

            {/* Right — CHWs */}
            <div
              id="for-chws"
              className="bg-[#EFF6FF] px-10 py-16 lg:px-14 lg:py-20 scroll-mt-16"
            >
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0077B6] bg-white px-3 py-1 rounded-full mb-6">
                For Community Health Workers
              </span>
              <h3 className="text-3xl font-bold text-[#2C3E2D] leading-snug mb-5">
                Earn Medi-Cal reimbursements. Make real impact.
              </h3>
              <p className="text-base text-[#555555] leading-relaxed mb-8">
                Set your schedule, grow your member panel, and earn Medi-Cal
                reimbursements through our platform.
              </p>

              <ul className="space-y-3 mb-9" role="list">
                {CHW_FEATURES.map((f) => (
                  <li key={f.text} className="flex items-start gap-3">
                    <CheckCircle2
                      size={18}
                      className="text-[#0077B6] mt-0.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="text-sm text-[#2C3E2D]">{f.text}</span>
                  </li>
                ))}
              </ul>

              <Link
                to="/register"
                className="inline-flex items-center gap-2 bg-[#0077B6] hover:bg-[#005A8C] text-white font-semibold px-6 py-3 rounded-full text-sm transition-colors"
              >
                Apply to Join
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>

        {/* ─── Service Areas ─────────────────────────────────────────────────────── */}
        <section
          className="py-24 px-5 bg-white"
          aria-labelledby="services-heading"
        >
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-14">
              <p className="text-xs font-semibold uppercase tracking-widest text-[#6B8F71] mb-3">
                Our Services
              </p>
              <h2
                id="services-heading"
                className="text-4xl font-bold text-[#2C3E2D]"
              >
                What We Help With
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-5">
              {SERVICE_AREAS.map((area) => (
                <article
                  key={area.title}
                  className="flex flex-col bg-white rounded-2xl border border-[rgba(44,62,45,0.1)] p-6 shadow-sm hover:shadow-md transition-shadow overflow-hidden"
                  style={{ borderTop: `3px solid ${area.borderColor}` }}
                >
                  <span
                    className="text-3xl mb-4"
                    role="img"
                    aria-hidden="true"
                  >
                    {area.emoji}
                  </span>
                  <h3 className="text-sm font-semibold text-[#2C3E2D] mb-2">
                    {area.title}
                  </h3>
                  <p className="text-xs text-[#555555] leading-relaxed">
                    {area.description}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ─── Final CTA ─────────────────────────────────────────────────────────── */}
        <section
          className="py-24 px-5 bg-white"
          aria-labelledby="final-cta-heading"
        >
          <div className="max-w-2xl mx-auto text-center">
            <h2
              id="final-cta-heading"
              className="text-4xl font-bold text-[#2C3E2D] mb-4"
            >
              Ready to get started?
            </h2>
            <p className="text-base text-[#555555] mb-9 leading-relaxed">
              CompassCHW is free for Medi-Cal members.
              CHWs can start earning today.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link
                to="/register"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#2C3E2D] hover:bg-[#3A5240] text-white font-semibold px-8 py-3.5 rounded-full text-base transition-colors shadow-sm"
              >
                I Need Help
              </Link>
              <Link
                to="/register"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 border-2 border-[#0077B6] text-[#0077B6] hover:bg-[#EFF6FF] font-semibold px-8 py-3.5 rounded-full text-base transition-colors"
              >
                I'm a CHW
              </Link>
            </div>
          </div>
        </section>

      </main>

      {/* ─── Footer ────────────────────────────────────────────────────────────── */}
      <footer
        className="bg-[#FAFAFA] border-t border-[rgba(44,62,45,0.1)] px-5 pt-14 pb-8"
        role="contentinfo"
      >
        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10 mb-12">

            {/* Brand column */}
            <div className="lg:col-span-1">
              <Link
                to="/landing"
                className="flex items-center gap-2 mb-4"
                aria-label="CompassCHW home"
              >
                <div className="w-8 h-8 rounded-lg bg-[#2C3E2D] flex items-center justify-center">
                  <Compass size={17} className="text-white" aria-hidden="true" />
                </div>
                <span className="text-[16px] font-bold">
                  <span className="text-[#6B8F71]">Compass</span>
                  <span className="text-[#2C3E2D]">CHW</span>
                </span>
              </Link>
              <p className="text-sm text-[#555555] leading-relaxed mb-2">
                Care Navigation. On Demand.
              </p>
              <p className="text-xs text-[#8B9B8D]">Built in Los Angeles, CA</p>
            </div>

            {/* Product links */}
            <nav aria-label="Product links">
              <p className="text-xs font-semibold uppercase tracking-widest text-[#8B9B8D] mb-4">
                Product
              </p>
              <ul className="space-y-3 list-none p-0 m-0" role="list">
                {[
                  { label: 'How It Works', href: '#how-it-works' },
                  { label: 'Impact', href: '#impact' },
                  { label: 'For Members', href: '#for-members' },
                  { label: 'For CHWs', href: '#for-chws' },
                ].map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      onClick={(e) => handleAnchorClick(e, link.href)}
                      className="text-sm text-[#555555] hover:text-[#2C3E2D] transition-colors"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>

            {/* Company links */}
            <nav aria-label="Company links">
              <p className="text-xs font-semibold uppercase tracking-widest text-[#8B9B8D] mb-4">
                Company
              </p>
              <ul className="space-y-3 list-none p-0 m-0" role="list">
                {[
                  { label: 'About Us', href: '#' },
                  { label: 'Careers', href: '#' },
                  { label: 'Press', href: '#' },
                  { label: 'Contact', href: '#' },
                ].map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-sm text-[#555555] hover:text-[#2C3E2D] transition-colors"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>

            {/* Tagline column */}
            <div className="flex flex-col justify-between">
              <p className="text-lg text-[#8B9B8D] italic leading-snug font-medium">
                "It pays to be healthy."
              </p>
              <div className="flex gap-3 mt-6">
                <Link
                  to="/login"
                  className="text-sm font-medium text-[#555555] hover:text-[#2C3E2D] transition-colors"
                >
                  Sign In
                </Link>
                <span className="text-[rgba(44,62,45,0.1)]">·</span>
                <Link
                  to="/register"
                  className="text-sm font-semibold text-[#6B8F71] hover:text-[#008F40] transition-colors"
                >
                  Get Started
                </Link>
              </div>
            </div>
          </div>

          {/* Bottom bar */}
          <div className="border-t border-[rgba(44,62,45,0.1)] pt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-xs text-[#8B9B8D]">
              © 2026 CompassCHW, Inc. All rights reserved.
            </p>
            <div className="flex items-center gap-5">
              {[
                { label: 'Privacy', href: '#' },
                { label: 'Terms', href: '#' },
                { label: 'HIPAA Compliance', href: '#' },
              ].map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  className="text-xs text-[#8B9B8D] hover:text-[#555555] transition-colors"
                >
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        </div>
      </footer>

    </div>
  );
}
