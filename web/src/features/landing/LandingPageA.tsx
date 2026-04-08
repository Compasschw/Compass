import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  Compass,
  Menu,
  X,
  ArrowRight,
  CheckCircle2,
  Home,
  Utensils,
  Brain,
  HeartPulse,
  Repeat2,
  Star,
  Clock,
  Users,
  MapPin,
  Shield,
  Smartphone,
  ChevronRight,
  Building2,
  Globe,
  Share2,
  ExternalLink,
} from 'lucide-react';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface NavItem {
  label: string;
  href: string;
}

interface HowItWorksStep {
  number: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}

interface FeatureItem {
  text: string;
}

interface StatItem {
  value: string;
  label: string;
  sublabel: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const NAV_ITEMS: NavItem[] = [
  { label: 'How It Works', href: '#how-it-works' },
  { label: 'For CHWs', href: '#for-chws' },
  { label: 'For Members', href: '#for-members' },
  { label: 'About', href: '#impact' },
];

const HOW_IT_WORKS_STEPS: HowItWorksStep[] = [
  {
    number: '01',
    title: 'Tell Us What You Need',
    description:
      'Submit your request for housing, food, mental health, healthcare, or recovery support — in minutes, from any device.',
    icon: <Smartphone size={28} className="text-[#6B8F71]" aria-hidden="true" />,
  },
  {
    number: '02',
    title: 'Get Matched with a CHW',
    description:
      'Our algorithm connects you with a certified, local Community Health Worker who speaks your language and knows your community.',
    icon: <Users size={28} className="text-[#6B8F71]" aria-hidden="true" />,
  },
  {
    number: '03',
    title: 'Navigate Together',
    description:
      'Your CHW guides you through resources, applications, and appointments — in-person, virtual, or by phone.',
    icon: <MapPin size={28} className="text-[#6B8F71]" aria-hidden="true" />,
  },
];

const MEMBER_FEATURES: FeatureItem[] = [
  { text: '100% free — covered by your health plan' },
  { text: 'Choose in-person, virtual, or phone sessions' },
  { text: 'Earn rewards for following through on your goals' },
  { text: 'Your CHW speaks your language' },
  { text: 'Track your progress on a personal roadmap' },
];

const CHW_FEATURES: FeatureItem[] = [
  { text: 'Set your own schedule — work when you want' },
  { text: 'Earn $26.66/unit through Medi-Cal reimbursement' },
  { text: 'Get matched with members who need your expertise' },
  { text: 'Track earnings, sessions, and certifications' },
  { text: 'Build ongoing relationships with recurring clients' },
];

const IMPACT_STATS: StatItem[] = [
  {
    value: '81%',
    label: 'Engagement Rate',
    sublabel: 'Target benchmark (CityBlock standard)',
  },
  {
    value: '$26.66',
    label: 'Per-Unit Reimbursement',
    sublabel: 'Medi-Cal rate per 15-minute unit',
  },
  {
    value: '5',
    label: 'Service Verticals',
    sublabel: 'Housing · Food · Mental Health · Rehab · Healthcare',
  },
  {
    value: '24/7',
    label: 'On-Demand Access',
    sublabel: 'Care navigation whenever you need it',
  },
];

const TRUST_ORGS = [
  'LA County DPSS',
  'Medi-Cal',
  'Pear Suite',
  'TENA Health',
  'St. John\'s Well Child',
  'Didi Hirsch Mental Health',
];

// ─── Sub-components ─────────────────────────────────────────────────────────────

/**
 * Sticky navigation bar with scroll-aware background transition.
 * Collapses to a hamburger menu on mobile viewports.
 */
function NavBar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    function handleScroll() {
      setScrolled(window.scrollY > 20);
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  function handleNavClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
    if (href.startsWith('#')) {
      e.preventDefault();
      const target = document.querySelector(href);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth' });
      }
      setMobileOpen(false);
    }
  }

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'bg-white/95 backdrop-blur-md shadow-[0_1px_20px_rgba(0,0,0,0.08)] border-b border-[rgba(44,62,45,0.1)]'
          : 'bg-transparent'
      }`}
      role="banner"
    >
      <nav
        className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between"
        aria-label="Main navigation"
      >
        {/* Logo */}
        <Link
          to="/"
          className="flex items-center gap-2.5 shrink-0"
          aria-label="CompassCHW home"
        >
          <div className="w-9 h-9 rounded-xl bg-[#2C3E2D] flex items-center justify-center shadow-sm">
            <Compass size={20} className="text-white" aria-hidden="true" />
          </div>
          <span
            className={`text-lg font-bold tracking-tight transition-colors duration-300 ${
              scrolled ? 'text-[#2C3E2D]' : 'text-white'
            }`}
          >
            CompassCHW
          </span>
        </Link>

        {/* Desktop center links */}
        <ul className="hidden md:flex items-center gap-8" role="list">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                onClick={(e) => handleNavClick(e, item.href)}
                className={`text-sm font-medium transition-colors duration-200 hover:text-[#6B8F71] ${
                  scrolled ? 'text-[#555555]' : 'text-white/80'
                }`}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>

        {/* Desktop right actions */}
        <div className="hidden md:flex items-center gap-4">
          <Link
            to="/login"
            className={`text-sm font-medium transition-colors duration-200 hover:text-[#6B8F71] ${
              scrolled ? 'text-[#555555]' : 'text-white/80'
            }`}
          >
            Log In
          </Link>
          <Link
            to="/register"
            className="text-sm font-semibold bg-[#2C3E2D] hover:bg-[#3A5240] text-white px-5 py-2 rounded-full transition-colors duration-200 shadow-sm"
          >
            Get Started
          </Link>
        </div>

        {/* Mobile hamburger */}
        <button
          className={`md:hidden p-2 rounded-lg transition-colors ${
            scrolled
              ? 'text-[#2C3E2D] hover:bg-[#FBF7F0]'
              : 'text-white hover:bg-white/10'
          }`}
          onClick={() => setMobileOpen((prev) => !prev)}
          aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav"
        >
          {mobileOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </nav>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div
          id="mobile-nav"
          className="md:hidden bg-white border-t border-[rgba(44,62,45,0.1)] shadow-lg"
          role="dialog"
          aria-label="Mobile navigation"
        >
          <ul className="flex flex-col px-4 py-4 gap-1" role="list">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  onClick={(e) => handleNavClick(e, item.href)}
                  className="block px-3 py-2.5 text-sm font-medium text-[#555555] hover:text-[#6B8F71] hover:bg-[#FBF7F0] rounded-lg transition-colors"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-2 px-4 pb-4 border-t border-[rgba(44,62,45,0.1)] pt-3">
            <Link
              to="/login"
              className="text-center text-sm font-medium text-[#555555] hover:text-[#6B8F71] py-2.5 rounded-lg hover:bg-[#FBF7F0] transition-colors"
              onClick={() => setMobileOpen(false)}
            >
              Log In
            </Link>
            <Link
              to="/register"
              className="text-center text-sm font-semibold bg-[#2C3E2D] hover:bg-[#3A5240] text-white py-2.5 rounded-full transition-colors"
              onClick={() => setMobileOpen(false)}
            >
              Get Started
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

/**
 * Floating app mockup card shown in the hero section — simulates the
 * member dashboard to communicate product value at a glance.
 */
function HeroMockupCard() {
  return (
    <div
      className="relative w-full max-w-sm mx-auto lg:mx-0"
      aria-hidden="true"
    >
      {/* Glow effect */}
      <div className="absolute -inset-4 bg-gradient-to-br from-[#6B8F71]/20 to-[#0077B6]/20 rounded-3xl blur-2xl" />

      {/* Main card */}
      <div className="relative bg-white/10 backdrop-blur-lg border border-white/20 rounded-2xl p-5 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-white/60 text-xs font-medium">Good morning,</p>
            <p className="text-white font-semibold text-sm">Rosa Delgado</p>
          </div>
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#6B8F71] to-[#0077B6] flex items-center justify-center text-white text-xs font-bold">
            RD
          </div>
        </div>

        {/* Rewards strip */}
        <div className="bg-gradient-to-r from-[#6B8F71]/30 to-[#6B8F71]/10 border border-[#6B8F71]/30 rounded-xl p-3 mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Star size={14} className="text-[#6B8F71]" />
            <span className="text-white text-xs font-medium">My Rewards</span>
          </div>
          <span className="text-[#6B8F71] font-bold text-sm">120 pts</span>
        </div>

        {/* Goal cards */}
        <div className="space-y-2 mb-3">
          <p className="text-white/50 text-xs font-medium uppercase tracking-wide">Active Goals</p>

          <div className="bg-white/8 border border-white/15 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Home size={13} className="text-[#6B8F71]" />
                <span className="text-white text-xs font-medium">Secure Stable Housing</span>
              </div>
              <span className="text-white/60 text-xs">35%</span>
            </div>
            <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div className="h-full w-[35%] bg-gradient-to-r from-[#6B8F71] to-[#4A7A50] rounded-full" />
            </div>
          </div>

          <div className="bg-white/8 border border-white/15 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Brain size={13} className="text-[#0077B6]" />
                <span className="text-white text-xs font-medium">Mental Health Support</span>
              </div>
              <span className="text-white/60 text-xs">80%</span>
            </div>
            <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div className="h-full w-[80%] bg-gradient-to-r from-[#0077B6] to-[#005A8C] rounded-full" />
            </div>
          </div>
        </div>

        {/* Next session */}
        <div className="bg-white/8 border border-white/15 rounded-xl p-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#2C3E2D]/20 flex items-center justify-center shrink-0">
            <Clock size={14} className="text-[#6B8F71]" />
          </div>
          <div className="min-w-0">
            <p className="text-white/50 text-xs">Next session</p>
            <p className="text-white text-xs font-medium truncate">Maria G. Reyes · Apr 3, 10:00 AM</p>
          </div>
        </div>
      </div>

      {/* Floating badge — top right */}
      <div className="absolute -top-3 -right-3 bg-[#2C3E2D] text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1.5">
        <Shield size={11} />
        HIPAA Secure
      </div>
    </div>
  );
}

/**
 * Decorative floating orb used in the hero background for depth effect.
 */
function FloatingOrb({
  className,
  style,
}: {
  className: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`absolute rounded-full blur-3xl opacity-30 pointer-events-none ${className}`}
      style={style}
      aria-hidden="true"
    />
  );
}

/**
 * Member home screen mockup card used in the "For Members" section.
 */
function MemberMockupCard() {
  return (
    <div
      className="bg-white border border-[rgba(44,62,45,0.1)] rounded-2xl shadow-xl overflow-hidden max-w-sm mx-auto lg:mx-0"
      aria-hidden="true"
    >
      {/* Header bar */}
      <div className="bg-gradient-to-r from-[#1a1a4e] to-[#3d2066] px-5 py-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-[#2C3E2D] flex items-center justify-center text-white text-sm font-bold shrink-0">
          RD
        </div>
        <div>
          <p className="text-white/70 text-xs">Welcome back,</p>
          <p className="text-white font-semibold text-sm">Rosa Delgado</p>
        </div>
        <div className="ml-auto text-right">
          <p className="text-white/60 text-xs">Rewards</p>
          <p className="text-[#6B8F71] font-bold text-sm">120 pts</p>
        </div>
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-3">
        <p className="text-xs font-semibold text-[#555555] uppercase tracking-wide">My Goals</p>

        {[
          { label: 'Secure Stable Housing', progress: 35, color: '#6B8F71', icon: <Home size={12} /> },
          { label: 'Recovery Milestones', progress: 60, color: '#0077B6', icon: <Repeat2 size={12} /> },
          { label: 'Mental Health Support', progress: 80, color: '#3d2066', icon: <Brain size={12} /> },
        ].map((goal) => (
          <div key={goal.label} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[#2C3E2D]">
                <span style={{ color: goal.color }}>{goal.icon}</span>
                <span className="text-xs font-medium">{goal.label}</span>
              </div>
              <span className="text-xs text-[#8B9B8D]">{goal.progress}%</span>
            </div>
            <div className="h-1.5 bg-[#F0F0F0] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${goal.progress}%`, backgroundColor: goal.color }}
              />
            </div>
          </div>
        ))}

        <div className="pt-1 border-t border-[rgba(44,62,45,0.1)]">
          <div className="flex items-center gap-2.5 bg-[#FBF7F0] rounded-xl p-3">
            <div className="w-8 h-8 rounded-lg bg-[rgba(107,143,113,0.15)] flex items-center justify-center shrink-0">
              <Clock size={14} className="text-[#6B8F71]" />
            </div>
            <div>
              <p className="text-[#8B9B8D] text-xs">Next session</p>
              <p className="text-[#2C3E2D] text-xs font-semibold">Maria G. Reyes · Apr 3</p>
            </div>
            <ChevronRight size={14} className="text-[#8B9B8D] ml-auto" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * CHW earnings dashboard mockup card used in the "For CHWs" section.
 */
function CHWMockupCard() {
  return (
    <div
      className="bg-white border border-[rgba(44,62,45,0.1)] rounded-2xl shadow-xl overflow-hidden max-w-sm mx-auto lg:ml-0 lg:mr-auto"
      aria-hidden="true"
    >
      {/* Header */}
      <div className="bg-gradient-to-r from-[#0077B6] to-[#005A8C] px-5 py-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-white text-sm font-bold shrink-0">
          MR
        </div>
        <div>
          <p className="text-white/70 text-xs">CHW Dashboard</p>
          <p className="text-white font-semibold text-sm">Maria G. Reyes</p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#2C3E2D] inline-block" />
          <span className="text-white/70 text-xs">Available</span>
        </div>
      </div>

      {/* Earnings summary */}
      <div className="px-5 py-4">
        <div className="grid grid-cols-3 gap-3 mb-4">
          {[
            { label: 'This Week', value: '$181', sublabel: '2 sessions' },
            { label: 'This Month', value: '$724', sublabel: 'On track' },
            { label: 'All Time', value: '$8.3K', sublabel: 'Total earned' },
          ].map((stat) => (
            <div key={stat.label} className="bg-[#FBF7F0] rounded-xl p-3 text-center">
              <p className="text-xs text-[#8B9B8D] mb-0.5">{stat.label}</p>
              <p className="text-sm font-bold text-[#0077B6]">{stat.value}</p>
              <p className="text-xs text-[#8B9B8D]">{stat.sublabel}</p>
            </div>
          ))}
        </div>

        {/* Pending requests */}
        <p className="text-xs font-semibold text-[#555555] uppercase tracking-wide mb-2">New Requests</p>
        <div className="space-y-2">
          {[
            { name: 'Rosa Delgado', type: 'Housing', urgency: 'Urgent', urgencyColor: '#DC2626' },
            { name: 'Marcus Johnson', type: 'Rehab', urgency: 'Soon', urgencyColor: '#F59E0B' },
          ].map((req) => (
            <div
              key={req.name}
              className="flex items-center gap-3 bg-[#FBF7F0] rounded-xl p-3"
            >
              <div className="w-7 h-7 rounded-full bg-[#E0F0FF] flex items-center justify-center text-[#0077B6] text-xs font-bold shrink-0">
                {req.name.split(' ').map((n) => n[0]).join('')}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-[#2C3E2D] truncate">{req.name}</p>
                <p className="text-xs text-[#8B9B8D]">{req.type}</p>
              </div>
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full"
                style={{
                  color: req.urgencyColor,
                  backgroundColor: `${req.urgencyColor}15`,
                }}
              >
                {req.urgency}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-[#8B9B8D] border-t border-[rgba(44,62,45,0.1)] pt-3">
          <span>Avg Rating</span>
          <div className="flex items-center gap-1">
            <Star size={11} className="text-[#F59E0B] fill-[#F59E0B]" />
            <span className="font-semibold text-[#2C3E2D]">4.9</span>
            <span>(312 sessions)</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

/**
 * Landing Page Variant A — "Enterprise Healthcare Meets Modern Platform"
 *
 * Inspired by the Chorus (joinchorus.com) aesthetic: deep navy-to-purple
 * gradient hero, clean white content sections, generous whitespace, and
 * a professional enterprise-grade feel targeting investors and health plan
 * partners.
 *
 * Self-contained: no Layout/Sidebar/BottomNav chrome. Public marketing page.
 */
export function LandingPageA() {
  const heroRef = useRef<HTMLElement>(null);

  return (
    <div className="min-h-screen bg-white font-sans antialiased" style={{ scrollBehavior: 'smooth' }}>
      {/* ── Navigation ──────────────────────────────────────────────────── */}
      <NavBar />

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section
        ref={heroRef}
        id="hero"
        aria-labelledby="hero-heading"
        className="relative min-h-screen flex items-center overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, #0d0d3d 0%, #1a1a4e 20%, #2d1060 45%, #3d2066 65%, #004d7a 85%, #0077B6 100%)',
        }}
      >
        {/* Animated gradient orbs */}
        <FloatingOrb className="w-96 h-96 bg-[#2C3E2D] top-1/4 -left-24 animate-pulse" />
        <FloatingOrb className="w-80 h-80 bg-[#0077B6] bottom-1/4 -right-16 animate-pulse" style={{ animationDelay: '1s' } as React.CSSProperties} />
        <FloatingOrb className="w-64 h-64 bg-[#3d2066] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" style={{ animationDelay: '2s' } as React.CSSProperties} />

        {/* Grid overlay for texture */}
        <div
          className="absolute inset-0 opacity-5 pointer-events-none"
          aria-hidden="true"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)',
            backgroundSize: '60px 60px',
          }}
        />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-24 pb-16 lg:py-32 w-full">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            {/* Left — copy */}
            <div>
              {/* Eyebrow pill */}
              <div className="inline-flex items-center gap-2 bg-white/10 border border-white/20 rounded-full px-4 py-1.5 mb-6">
                <span className="w-2 h-2 rounded-full bg-[#2C3E2D] animate-pulse" />
                <span className="text-white/80 text-xs font-medium tracking-wide uppercase">
                  Now live in Los Angeles
                </span>
              </div>

              <h1
                id="hero-heading"
                className="text-5xl sm:text-6xl lg:text-[64px] font-extrabold text-white leading-[1.05] tracking-tight mb-6"
              >
                Care Navigation.
                <br />
                <span className="bg-gradient-to-r from-[#6B8F71] to-[#40e080] bg-clip-text text-transparent">
                  On Demand.
                </span>
              </h1>

              <p className="text-lg sm:text-xl text-white/75 leading-relaxed mb-8 max-w-lg">
                CompassCHW connects community members with certified Community
                Health Workers — for housing, food, mental health, and
                healthcare navigation.
              </p>

              {/* CTA buttons */}
              <div className="flex flex-col sm:flex-row gap-3 mb-8">
                <Link
                  to="/register"
                  className="inline-flex items-center justify-center gap-2 bg-[#2C3E2D] hover:bg-[#3A5240] text-white font-semibold px-8 py-4 rounded-full text-base transition-all duration-200 shadow-lg shadow-[#6B8F71]/30 hover:shadow-xl hover:shadow-[#6B8F71]/40 hover:-translate-y-0.5"
                >
                  I Need Help
                  <ArrowRight size={18} />
                </Link>
                <Link
                  to="/register"
                  className="inline-flex items-center justify-center gap-2 border-2 border-white/40 hover:border-white/70 text-white font-semibold px-8 py-4 rounded-full text-base transition-all duration-200 hover:bg-white/10 hover:-translate-y-0.5"
                >
                  I'm a CHW
                  <ChevronRight size={18} />
                </Link>
              </div>

              {/* Trust line */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-white/50 text-sm">
                <div className="flex items-center gap-1.5">
                  <Shield size={13} className="text-[#6B8F71]" />
                  <span>Powered by Medi-Cal</span>
                </div>
                <span className="w-px h-4 bg-white/20" aria-hidden="true" />
                <div className="flex items-center gap-1.5">
                  <Shield size={13} className="text-[#6B8F71]" />
                  <span>HIPAA Compliant</span>
                </div>
                <span className="w-px h-4 bg-white/20" aria-hidden="true" />
                <div className="flex items-center gap-1.5">
                  <Star size={13} className="text-[#6B8F71]" />
                  <span>Free for Members</span>
                </div>
              </div>
            </div>

            {/* Right — app mockup */}
            <div className="flex justify-center lg:justify-end">
              <HeroMockupCard />
            </div>
          </div>
        </div>

        {/* Bottom fade to white */}
        <div
          className="absolute bottom-0 left-0 right-0 h-24 pointer-events-none"
          aria-hidden="true"
          style={{
            background: 'linear-gradient(to bottom, transparent, rgba(248,250,251,0.15))',
          }}
        />
      </section>

      {/* ── Trust Bar ───────────────────────────────────────────────────── */}
      <section
        aria-label="Trusted partners"
        className="bg-[#F4F6F8] border-y border-[rgba(44,62,45,0.1)] py-10"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-center text-xs font-semibold text-[#8B9B8D] uppercase tracking-widest mb-6">
            Trusted by community health organizations across LA
          </p>
          <div className="flex flex-wrap justify-center items-center gap-6 lg:gap-10">
            {TRUST_ORGS.map((org) => (
              <div
                key={org}
                className="flex items-center gap-2 text-[#555555] text-sm font-semibold bg-white border border-[rgba(44,62,45,0.1)] rounded-xl px-4 py-2.5 shadow-sm"
              >
                <Building2 size={14} className="text-[#8B9B8D]" aria-hidden="true" />
                {org}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How It Works ────────────────────────────────────────────────── */}
      <section
        id="how-it-works"
        aria-labelledby="how-it-works-heading"
        className="py-24 lg:py-32 bg-white"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Section header */}
          <div className="text-center mb-16 lg:mb-20">
            <p className="text-[#6B8F71] text-sm font-semibold uppercase tracking-widest mb-3">
              The Process
            </p>
            <h2
              id="how-it-works-heading"
              className="text-4xl lg:text-5xl font-extrabold text-[#2C3E2D] tracking-tight mb-4"
            >
              How CompassCHW Works
            </h2>
            <p className="text-lg text-[#555555] max-w-xl mx-auto">
              Getting connected with a Community Health Worker is simple,
              fast, and completely free.
            </p>
          </div>

          {/* Steps */}
          <div className="relative grid md:grid-cols-3 gap-8 lg:gap-12">
            {/* Connecting line — desktop only */}
            <div
              className="hidden md:block absolute top-[52px] left-[calc(16.67%+16px)] right-[calc(16.67%+16px)] h-0.5 bg-gradient-to-r from-[rgba(44,62,45,0.1)] via-[#6B8F71]/40 to-[rgba(44,62,45,0.1)]"
              aria-hidden="true"
            />

            {HOW_IT_WORKS_STEPS.map((step, index) => (
              <div
                key={step.number}
                className="flex flex-col items-center text-center relative"
              >
                {/* Number circle */}
                <div className="relative mb-6">
                  <div
                    className={`w-[104px] h-[104px] rounded-full flex flex-col items-center justify-center shadow-lg ${
                      index === 1
                        ? 'bg-gradient-to-br from-[#6B8F71] to-[#4A7A50] shadow-[#6B8F71]/30'
                        : 'bg-white border-2 border-[rgba(44,62,45,0.1)]'
                    }`}
                  >
                    <span
                      className={`text-2xl font-black leading-none ${
                        index === 1 ? 'text-white' : 'text-[#6B8F71]'
                      }`}
                    >
                      {step.number}
                    </span>
                  </div>
                </div>

                {/* Icon */}
                <div className="mb-4">
                  {step.icon}
                </div>

                <h3 className="text-xl font-bold text-[#2C3E2D] mb-3">
                  {step.title}
                </h3>
                <p className="text-[#555555] leading-relaxed text-sm">
                  {step.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── For Community Members ──────────────────────────────────────── */}
      <section
        id="for-members"
        aria-labelledby="for-members-heading"
        className="py-24 lg:py-32 bg-[#FBF7F0]"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-20 items-center">
            {/* Left — features */}
            <div>
              <p className="text-[#6B8F71] text-sm font-semibold uppercase tracking-widest mb-3">
                For Community Members
              </p>
              <h2
                id="for-members-heading"
                className="text-4xl lg:text-5xl font-extrabold text-[#2C3E2D] tracking-tight mb-5"
              >
                Help that comes
                <br />
                <span className="text-[#6B8F71]">to you.</span>
              </h2>
              <p className="text-lg text-[#555555] mb-8 leading-relaxed">
                Whether you need help with housing, food, mental health, or
                healthcare — a certified CHW will meet you where you are and
                guide you every step of the way.
              </p>

              <ul className="space-y-4" role="list" aria-label="Member benefits">
                {MEMBER_FEATURES.map((feature) => (
                  <li key={feature.text} className="flex items-start gap-3">
                    <CheckCircle2
                      size={20}
                      className="text-[#6B8F71] shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                    <span className="text-[#2C3E2D] font-medium">{feature.text}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-10 flex flex-col sm:flex-row gap-3">
                <Link
                  to="/register"
                  className="inline-flex items-center justify-center gap-2 bg-[#2C3E2D] hover:bg-[#3A5240] text-white font-semibold px-7 py-3.5 rounded-full text-sm transition-all duration-200 shadow-md hover:shadow-lg hover:-translate-y-0.5"
                >
                  Get Started as a Member
                  <ArrowRight size={16} />
                </Link>
              </div>
            </div>

            {/* Right — mockup */}
            <div>
              <MemberMockupCard />
            </div>
          </div>
        </div>
      </section>

      {/* ── For Community Health Workers ─────────────────────────────── */}
      <section
        id="for-chws"
        aria-labelledby="for-chws-heading"
        className="py-24 lg:py-32 bg-white"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-20 items-center">
            {/* Left — mockup (order-2 on mobile so copy reads first) */}
            <div className="order-2 lg:order-1">
              <CHWMockupCard />
            </div>

            {/* Right — features */}
            <div className="order-1 lg:order-2">
              <p className="text-[#0077B6] text-sm font-semibold uppercase tracking-widest mb-3">
                For Community Health Workers
              </p>
              <h2
                id="for-chws-heading"
                className="text-4xl lg:text-5xl font-extrabold text-[#2C3E2D] tracking-tight mb-5"
              >
                Build a career
                <br />
                <span className="text-[#0077B6]">doing good work.</span>
              </h2>
              <p className="text-lg text-[#555555] mb-8 leading-relaxed">
                CompassCHW gives certified Community Health Workers a platform
                to earn meaningful income, grow their practice, and make a
                real difference in their community.
              </p>

              <ul className="space-y-4" role="list" aria-label="CHW benefits">
                {CHW_FEATURES.map((feature) => (
                  <li key={feature.text} className="flex items-start gap-3">
                    <CheckCircle2
                      size={20}
                      className="text-[#0077B6] shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                    <span className="text-[#2C3E2D] font-medium">{feature.text}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-10">
                <Link
                  to="/register"
                  className="inline-flex items-center justify-center gap-2 bg-[#0077B6] hover:bg-[#005A8C] text-white font-semibold px-7 py-3.5 rounded-full text-sm transition-all duration-200 shadow-md hover:shadow-lg hover:-translate-y-0.5"
                >
                  Apply as a CHW
                  <ArrowRight size={16} />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Vertical icons strip ─────────────────────────────────────── */}
      <section
        aria-label="Service verticals"
        className="bg-[#FBF7F0] border-y border-[rgba(44,62,45,0.1)] py-12"
      >
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-center text-xs font-semibold text-[#8B9B8D] uppercase tracking-widest mb-8">
            5 service verticals — one unified platform
          </p>
          <div className="grid grid-cols-5 gap-4">
            {[
              { label: 'Housing', icon: <Home size={22} />, color: '#6B8F71' },
              { label: 'Food Security', icon: <Utensils size={22} />, color: '#F59E0B' },
              { label: 'Mental Health', icon: <Brain size={22} />, color: '#8B5CF6' },
              { label: 'Rehab & Recovery', icon: <Repeat2 size={22} />, color: '#EF4444' },
              { label: 'Healthcare', icon: <HeartPulse size={22} />, color: '#0077B6' },
            ].map((v) => (
              <div key={v.label} className="flex flex-col items-center text-center gap-2">
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm"
                  style={{ backgroundColor: `${v.color}18` }}
                  aria-hidden="true"
                >
                  <span style={{ color: v.color }}>{v.icon}</span>
                </div>
                <span className="text-xs font-semibold text-[#555555] leading-tight">{v.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Impact Stats ────────────────────────────────────────────────── */}
      <section
        id="impact"
        aria-labelledby="impact-heading"
        className="py-24 lg:py-32"
        style={{
          background: 'linear-gradient(135deg, #0d0d3d 0%, #1a1a4e 40%, #0d2840 70%, #003d5c 100%)',
        }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <p className="text-[#6B8F71] text-sm font-semibold uppercase tracking-widest mb-3">
              By the Numbers
            </p>
            <h2
              id="impact-heading"
              className="text-4xl lg:text-5xl font-extrabold text-white tracking-tight"
            >
              Built for real impact.
            </h2>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {IMPACT_STATS.map((stat) => (
              <div
                key={stat.value}
                className="bg-white/8 border border-white/12 rounded-2xl p-7 text-center backdrop-blur-sm hover:bg-white/12 transition-colors duration-200"
              >
                <p className="text-5xl font-black text-white mb-2 leading-none">
                  {stat.value}
                </p>
                <p className="text-[#6B8F71] font-semibold text-sm mb-1.5">
                  {stat.label}
                </p>
                <p className="text-white/50 text-xs leading-relaxed">
                  {stat.sublabel}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA Section ─────────────────────────────────────────────────── */}
      <section
        aria-labelledby="cta-heading"
        className="py-24 lg:py-32 relative overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, #006630 0%, #6B8F71 50%, #4A7A50 100%)',
        }}
      >
        {/* Orbs */}
        <FloatingOrb className="w-72 h-72 bg-white top-0 -left-16" />
        <FloatingOrb className="w-64 h-64 bg-white bottom-0 -right-12" />

        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2
            id="cta-heading"
            className="text-4xl lg:text-5xl font-extrabold text-white tracking-tight mb-5"
          >
            Ready to make a difference?
          </h2>
          <p className="text-xl text-white/80 mb-10 max-w-2xl mx-auto leading-relaxed">
            Whether you need help navigating healthcare or want to help others
            — CompassCHW is here.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              to="/register"
              className="inline-flex items-center justify-center gap-2 bg-white hover:bg-[#FBF7F0] text-[#6B8F71] font-bold px-8 py-4 rounded-full text-base transition-all duration-200 shadow-lg hover:shadow-xl hover:-translate-y-0.5"
            >
              Get Started as a Member
              <ArrowRight size={18} />
            </Link>
            <Link
              to="/register"
              className="inline-flex items-center justify-center gap-2 border-2 border-white/50 hover:border-white text-white font-semibold px-8 py-4 rounded-full text-base transition-all duration-200 hover:bg-white/10 hover:-translate-y-0.5"
            >
              Apply as a CHW
              <ChevronRight size={18} />
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer
        className="text-white"
        style={{ backgroundColor: '#0d0d3d' }}
        role="contentinfo"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 pb-10">
          {/* Top row */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-10 mb-14">
            {/* Brand column */}
            <div className="sm:col-span-2 lg:col-span-1">
              <Link
                to="/"
                className="flex items-center gap-2.5 mb-4"
                aria-label="CompassCHW home"
              >
                <div className="w-9 h-9 rounded-xl bg-[#2C3E2D] flex items-center justify-center shadow-sm">
                  <Compass size={20} className="text-white" aria-hidden="true" />
                </div>
                <span className="text-lg font-bold text-white tracking-tight">CompassCHW</span>
              </Link>
              <p className="text-white/50 text-sm leading-relaxed mb-4 max-w-xs">
                Care navigation connecting community members with certified
                Community Health Workers across Los Angeles.
              </p>
              <p className="text-white/30 text-xs flex items-center gap-1.5">
                <MapPin size={12} />
                Built in Los Angeles, CA
              </p>
            </div>

            {/* Product links */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40 mb-4">
                Product
              </h3>
              <ul className="space-y-3" role="list">
                {[
                  { label: 'How It Works', href: '#how-it-works' },
                  { label: 'For Members', href: '#for-members' },
                  { label: 'For CHWs', href: '#for-chws' },
                  { label: 'Rewards Program', href: '#for-members' },
                ].map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      onClick={(e) => {
                        if (link.href.startsWith('#')) {
                          e.preventDefault();
                          document.querySelector(link.href)?.scrollIntoView({ behavior: 'smooth' });
                        }
                      }}
                      className="text-sm text-white/55 hover:text-white transition-colors"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            {/* Company links */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40 mb-4">
                Company
              </h3>
              <ul className="space-y-3" role="list">
                {['About', 'Careers', 'Contact', 'Blog'].map((label) => (
                  <li key={label}>
                    <a
                      href="#"
                      className="text-sm text-white/55 hover:text-white transition-colors"
                    >
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            {/* Legal links */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40 mb-4">
                Legal
              </h3>
              <ul className="space-y-3" role="list">
                {['Privacy Policy', 'Terms of Service', 'HIPAA Notice', 'Accessibility'].map(
                  (label) => (
                    <li key={label}>
                      <a
                        href="#"
                        className="text-sm text-white/55 hover:text-white transition-colors"
                      >
                        {label}
                      </a>
                    </li>
                  ),
                )}
              </ul>
            </div>
          </div>

          {/* Bottom bar */}
          <div className="border-t border-white/10 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-white/35 text-sm">
              &copy; 2026 CompassCHW. Care Navigation. On Demand.
            </p>
            <div className="flex items-center gap-4">
              <a
                href="#"
                className="text-white/35 hover:text-white/70 transition-colors"
                aria-label="CompassCHW on X / Twitter"
              >
                <Globe size={18} />
              </a>
              <a
                href="#"
                className="text-white/35 hover:text-white/70 transition-colors"
                aria-label="CompassCHW on LinkedIn"
              >
                <Share2 size={18} />
              </a>
              <a
                href="#"
                className="text-white/35 hover:text-white/70 transition-colors"
                aria-label="CompassCHW press kit"
              >
                <ExternalLink size={18} />
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
