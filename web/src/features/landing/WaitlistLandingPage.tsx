import { useState, type FormEvent } from 'react';
import { submitWaitlist } from '../../api/waitlist';
import { useScrollAnimation } from './hooks/useScrollAnimation';

// ─── Types ────────────────────────────────────────────────────────────────────

type UserRole = 'member' | 'chw' | 'organization' | 'other';

interface WaitlistFormData {
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole | '';
}

// ─── Nav ──────────────────────────────────────────────────────────────────────

function Nav() {
  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50"
      style={{
        background: 'rgba(251,247,240,0.85)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(44,62,45,0.06)',
      }}
    >
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <a href="/" className="text-xl font-bold tracking-tight text-primary no-underline">
          Compass<span className="text-accent">CHW</span>
        </a>

        {/* Nav links — hidden on mobile */}
        <div className="hidden md:flex items-center gap-8">
          <a
            href="#services"
            className="text-sm font-medium text-text-secondary hover:text-primary transition-colors no-underline"
          >
            Services
          </a>
          <a
            href="#how"
            className="text-sm font-medium text-text-secondary hover:text-primary transition-colors no-underline"
          >
            How It Works
          </a>
        </div>

        {/* CTA */}
        <a
          href="#waitlist"
          className="px-4 py-2 rounded-[12px] text-sm font-semibold text-white no-underline transition-colors"
          style={{ background: '#2C3E2D' }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.background = '#3A5240')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.background = '#2C3E2D')}
        >
          Join Waitlist
        </a>
      </div>
    </nav>
  );
}

// ─── Pulse Dot ────────────────────────────────────────────────────────────────

function PulseDot({ color = '#6B8F71' }: { color?: string }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full"
      style={{
        background: color,
        animation: 'pulse-dot 2s ease-in-out infinite',
      }}
    />
  );
}

// ─── Waitlist Form ────────────────────────────────────────────────────────────

function WaitlistForm() {
  const [form, setForm] = useState<WaitlistFormData>({
    firstName: '',
    lastName: '',
    email: '',
    role: '',
  });
  const [submitted, setSubmitted] = useState(false);

  function handleChange(field: keyof WaitlistFormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await submitWaitlist({
        first_name: form.firstName,
        last_name: form.lastName,
        email: form.email,
        role: form.role,
      });
    } catch {
      // Still show success even if backend is down -- localStorage fallback
      const entry = { ...form, submittedAt: new Date().toISOString() };
      const existing = JSON.parse(localStorage.getItem('compass_waitlist') || '[]') as Record<string, unknown>[];
      existing.push(entry);
      localStorage.setItem('compass_waitlist', JSON.stringify(existing));
    }
    setSubmitted(true);
  }

  const inputClass =
    'w-full px-4 py-3 rounded-[12px] text-sm text-primary placeholder:text-text-muted outline-none transition-all border';
  const inputStyle = {
    borderColor: 'rgba(44,62,45,0.15)',
    background: '#FAFAFA',
  };
  const inputFocusStyle = {
    borderColor: '#6B8F71',
    boxShadow: '0 0 0 3px rgba(107,143,113,0.12)',
  };

  if (submitted) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-8 text-center">
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(107,143,113,0.12)' }}
        >
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <path
              d="M6 16L13 23L26 10"
              stroke="#6B8F71"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div>
          <p className="text-lg font-bold text-primary">You're on the list!</p>
          <p className="text-sm text-text-secondary mt-1 max-w-xs">
            We'll email you the moment Compass launches in your area. Thank you for joining the
            community.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <PulseDot />
          <span>247 people have already joined</span>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* First + Last Name row */}
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-xs font-semibold text-text-secondary mb-1.5">
            First Name
          </label>
          <input
            type="text"
            required
            placeholder="Maria"
            value={form.firstName}
            onChange={(e) => handleChange('firstName', e.target.value)}
            className={inputClass}
            style={inputStyle}
            onFocus={(e) => Object.assign(e.currentTarget.style, inputFocusStyle)}
            onBlur={(e) => Object.assign(e.currentTarget.style, inputStyle)}
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs font-semibold text-text-secondary mb-1.5">
            Last Name
          </label>
          <input
            type="text"
            required
            placeholder="Garcia"
            value={form.lastName}
            onChange={(e) => handleChange('lastName', e.target.value)}
            className={inputClass}
            style={inputStyle}
            onFocus={(e) => Object.assign(e.currentTarget.style, inputFocusStyle)}
            onBlur={(e) => Object.assign(e.currentTarget.style, inputStyle)}
          />
        </div>
      </div>

      {/* Email */}
      <div>
        <label className="block text-xs font-semibold text-text-secondary mb-1.5">
          Email Address
        </label>
        <input
          type="email"
          required
          placeholder="maria@example.com"
          value={form.email}
          onChange={(e) => handleChange('email', e.target.value)}
          className={inputClass}
          style={inputStyle}
          onFocus={(e) => Object.assign(e.currentTarget.style, inputFocusStyle)}
          onBlur={(e) => Object.assign(e.currentTarget.style, inputStyle)}
        />
      </div>

      {/* Role */}
      <div>
        <label className="block text-xs font-semibold text-text-secondary mb-1.5">I am a…</label>
        <select
          required
          value={form.role}
          onChange={(e) => handleChange('role', e.target.value)}
          className={inputClass}
          style={{ ...inputStyle, cursor: 'pointer', appearance: 'none' }}
          onFocus={(e) => Object.assign(e.currentTarget.style, { ...inputFocusStyle })}
          onBlur={(e) => Object.assign(e.currentTarget.style, inputStyle)}
        >
          <option value="" disabled>
            Select your role
          </option>
          <option value="member">Member — I need support</option>
          <option value="chw">CHW — I want to provide care</option>
          <option value="organization">Organization — We employ CHWs</option>
          <option value="other">Other</option>
        </select>
      </div>

      {/* Submit */}
      <button
        type="submit"
        className="w-full py-3.5 rounded-[12px] text-sm font-bold text-white transition-all mt-1"
        style={{ background: '#2C3E2D' }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = '#3A5240')}
        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = '#2C3E2D')}
      >
        Join the Waitlist →
      </button>

      {/* Anti-spam + social proof */}
      <p className="text-center text-xs text-text-muted">
        No spam, ever. Unsubscribe anytime.
      </p>
      <div className="flex items-center justify-center gap-2 text-xs text-text-secondary">
        <PulseDot />
        <span>247 people have already joined</span>
      </div>
    </form>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section
      id="waitlist"
      className="min-h-[100dvh] flex items-center pt-16"
      style={{ background: '#FBF7F0' }}
    >
      <div className="max-w-6xl mx-auto px-6 py-16 w-full">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Left column: messaging */}
          <div className="flex flex-col gap-6">
            {/* Eyebrow */}
            <div className="flex items-center gap-2">
              <PulseDot />
              <span className="text-xs font-semibold tracking-widest uppercase text-text-secondary">
                Launching Soon in Los Angeles
              </span>
            </div>

            {/* Headline */}
            <h1
              className="text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.1] text-primary"
              style={{ letterSpacing: '-0.02em' }}
            >
              Community health,{' '}
              <span className="text-accent">connected.</span>
            </h1>

            {/* Subtitle */}
            <p className="text-lg text-text-secondary leading-relaxed max-w-lg">
              Compass CHW is a marketplace connecting Los Angeles residents with trusted Community
              Health Workers — neighbors trained to help with housing, recovery, food, mental
              health, and healthcare navigation.
            </p>

            {/* Trust strip */}
            <div className="flex flex-wrap gap-3 mt-2">
              {[
                { label: 'HIPAA Compliant', icon: '🔒' },
                { label: 'Medi-Cal Accepted', icon: '✓' },
                { label: 'No Cost to Members', icon: '★' },
              ].map((badge) => (
                <div
                  key={badge.label}
                  className="flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold text-primary"
                  style={{
                    background: 'rgba(107,143,113,0.1)',
                    border: '1px solid rgba(107,143,113,0.2)',
                  }}
                >
                  <span>{badge.icon}</span>
                  <span>{badge.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Right column: waitlist card */}
          <div className="w-full max-w-md mx-auto lg:ml-auto">
            <div
              className="rounded-[20px] bg-card overflow-hidden"
              style={{
                boxShadow:
                  '0 4px 6px -1px rgba(44,62,45,0.06), 0 20px 60px -10px rgba(44,62,45,0.15)',
              }}
            >
              {/* Gradient accent bar */}
              <div
                className="h-1.5 w-full"
                style={{ background: 'linear-gradient(90deg, #6B8F71 0%, #D4B896 100%)' }}
              />

              <div className="p-7 md:p-8">
                {/* Card header */}
                <div className="mb-6">
                  <h2 className="text-xl font-bold text-primary">Get early access</h2>
                  <p className="text-sm text-text-secondary mt-1 leading-relaxed">
                    Be the first to know when Compass launches in your area. Join the waitlist — it
                    takes 10 seconds.
                  </p>
                </div>

                <WaitlistForm />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Verticals ────────────────────────────────────────────────────────────────

const VERTICALS = [
  {
    emoji: '🏠',
    title: 'Housing',
    description: 'Rental assistance, shelter navigation, and housing stability support.',
  },
  {
    emoji: '💊',
    title: 'Rehab & Recovery',
    description: 'Substance use recovery resources, sober living, and peer support connections.',
  },
  {
    emoji: '🥗',
    title: 'Food & Pantry',
    description: 'Food pantry access, CalFresh enrollment, and nutrition program navigation.',
  },
  {
    emoji: '🧠',
    title: 'Mental Health',
    description: 'Counseling referrals, crisis support resources, and wellness check-ins.',
  },
  {
    emoji: '🏥',
    title: 'Healthcare',
    description: 'Medi-Cal enrollment, appointment scheduling, and care coordination.',
  },
];

function Verticals() {
  const { ref, isVisible } = useScrollAnimation<HTMLDivElement>();

  return (
    <section id="services" className="bg-card py-24 px-6">
      <div
        ref={ref}
        className="max-w-6xl mx-auto transition-all duration-700"
        style={{
          opacity: isVisible ? 1 : 0,
          transform: isVisible ? 'translateY(0)' : 'translateY(32px)',
        }}
      >
        {/* Section header */}
        <div className="text-center mb-14">
          <p className="text-xs font-semibold tracking-widest uppercase text-accent mb-3">
            What We Cover
          </p>
          <h2 className="text-3xl md:text-4xl font-bold text-primary" style={{ letterSpacing: '-0.02em' }}>
            Five areas where your neighbors can help
          </h2>
        </div>

        {/* Cards grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-5">
          {VERTICALS.map((v) => (
            <div
              key={v.title}
              className="rounded-[20px] p-6 flex flex-col gap-4 transition-transform hover:-translate-y-1"
              style={{
                background: '#FAFAFA',
                border: '1px solid rgba(44,62,45,0.06)',
                boxShadow: '0 2px 8px rgba(44,62,45,0.04)',
              }}
            >
              {/* Icon container */}
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl"
                style={{ background: 'rgba(107,143,113,0.1)' }}
              >
                {v.emoji}
              </div>
              <div>
                <h3 className="text-sm font-bold text-primary">{v.title}</h3>
                <p className="text-xs text-text-secondary mt-1 leading-relaxed">{v.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Stats Bar ────────────────────────────────────────────────────────────────

const STATS = [
  { value: '81%', label: 'CHW engagement rate' },
  { value: '5', label: 'Service verticals' },
  { value: '$22/unit', label: 'Average cost of service' },
  { value: '$0', label: 'Cost to members' },
];

function StatsBar() {
  const { ref, isVisible } = useScrollAnimation<HTMLDivElement>();

  return (
    <section style={{ background: '#2C3E2D' }} className="py-16 px-6">
      <div
        ref={ref}
        className="max-w-6xl mx-auto grid grid-cols-2 lg:grid-cols-4 gap-8 transition-all duration-700"
        style={{
          opacity: isVisible ? 1 : 0,
          transform: isVisible ? 'translateY(0)' : 'translateY(24px)',
        }}
      >
        {STATS.map((stat) => (
          <div key={stat.label} className="text-center">
            <p className="text-3xl md:text-4xl font-bold text-white">{stat.value}</p>
            <p className="text-xs mt-2" style={{ color: 'rgba(251,247,240,0.6)' }}>
              {stat.label}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── How It Works ─────────────────────────────────────────────────────────────

const STEPS = [
  {
    number: '01',
    title: 'Tell us what you need',
    description:
      'Share your situation — housing, food, recovery, or healthcare. No judgment, just help.',
  },
  {
    number: '02',
    title: 'Get matched',
    description:
      'We connect you with a trained Community Health Worker in your neighborhood who fits your needs.',
  },
  {
    number: '03',
    title: 'Start your journey',
    description:
      'Meet with your CHW, get referrals, and track your progress — at no cost to you.',
  },
];

function HowItWorks() {
  const { ref, isVisible } = useScrollAnimation<HTMLDivElement>();

  return (
    <section
      id="how"
      className="py-24 px-6"
      style={{ background: 'linear-gradient(135deg, #FBF7F0 0%, #EDE5D8 100%)' }}
    >
      <div
        ref={ref}
        className="max-w-6xl mx-auto transition-all duration-700"
        style={{
          opacity: isVisible ? 1 : 0,
          transform: isVisible ? 'translateY(0)' : 'translateY(32px)',
        }}
      >
        {/* Header */}
        <div className="text-center mb-14">
          <p className="text-xs font-semibold tracking-widest uppercase text-accent mb-3">
            How It Works
          </p>
          <h2
            className="text-3xl md:text-4xl font-bold text-primary"
            style={{ letterSpacing: '-0.02em' }}
          >
            Three steps to better health
          </h2>
        </div>

        {/* Steps */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {STEPS.map((step, idx) => (
            <div key={step.number} className="relative flex flex-col gap-4">
              {/* Connector line between steps */}
              {idx < STEPS.length - 1 && (
                <div
                  className="hidden md:block absolute top-6 left-[calc(50%+28px)] right-0 h-px"
                  style={{ background: 'rgba(107,143,113,0.25)' }}
                />
              )}

              {/* Step circle */}
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold text-white mx-auto md:mx-0"
                style={{ background: '#6B8F71' }}
              >
                {step.number}
              </div>

              <div className="text-center md:text-left">
                <h3 className="text-base font-bold text-primary">{step.title}</h3>
                <p className="text-sm text-text-secondary mt-2 leading-relaxed">
                  {step.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Bottom CTA ───────────────────────────────────────────────────────────────

function BottomCTA() {
  const { ref, isVisible } = useScrollAnimation<HTMLDivElement>();
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await submitWaitlist({
        first_name: 'N/A',
        last_name: 'N/A',
        email,
        role: 'other',
      });
    } catch {
      // Still show success even if backend is down -- localStorage fallback
      const entry = { email, submittedAt: new Date().toISOString() };
      const existing = JSON.parse(localStorage.getItem('compass_waitlist') || '[]') as Record<string, unknown>[];
      existing.push(entry);
      localStorage.setItem('compass_waitlist', JSON.stringify(existing));
    }
    setSubmitted(true);
  }

  return (
    <section className="bg-card py-24 px-6">
      <div
        ref={ref}
        className="max-w-2xl mx-auto text-center transition-all duration-700"
        style={{
          opacity: isVisible ? 1 : 0,
          transform: isVisible ? 'translateY(0)' : 'translateY(32px)',
        }}
      >
        <p className="text-xs font-semibold tracking-widest uppercase text-accent mb-3">
          Limited Early Access
        </p>
        <h2
          className="text-3xl md:text-4xl font-bold text-primary mb-4"
          style={{ letterSpacing: '-0.02em' }}
        >
          Don't miss the launch
        </h2>
        <p className="text-text-secondary mb-8">
          We're opening Compass to early users in Los Angeles first. Secure your spot now.
        </p>

        {submitted ? (
          <div className="flex items-center justify-center gap-2 text-accent font-semibold">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M4 10L8.5 14.5L16 7"
                stroke="#6B8F71"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            You're on the list!
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto"
          >
            <input
              type="email"
              required
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1 px-4 py-3 rounded-[12px] text-sm text-primary placeholder:text-text-muted outline-none border"
              style={{
                borderColor: 'rgba(44,62,45,0.15)',
                background: '#FAFAFA',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = '#6B8F71';
                e.currentTarget.style.boxShadow = '0 0 0 3px rgba(107,143,113,0.12)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(44,62,45,0.15)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
            <button
              type="submit"
              className="px-6 py-3 rounded-[12px] text-sm font-bold text-white whitespace-nowrap transition-colors"
              style={{ background: '#2C3E2D' }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.background = '#3A5240')
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.background = '#2C3E2D')
              }
            >
              Join Waitlist
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="py-12 px-6" style={{ background: '#2C3E2D' }}>
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
        {/* Logo + tagline */}
        <div>
          <p className="text-lg font-bold text-white">
            Compass<span style={{ color: '#6B8F71' }}>CHW</span>
          </p>
          <p className="text-xs mt-1" style={{ color: 'rgba(251,247,240,0.5)' }}>
            Community health, connected.
          </p>
        </div>

        {/* Links */}
        <div className="flex flex-wrap gap-6">
          {[['Privacy','/privacy'],['Terms','/terms'],['HIPAA','/hipaa'],['Contact','/contact']].map(([link, href]) => (
            <a
              key={link}
              href={href}
              className="text-xs no-underline transition-colors"
              style={{ color: 'rgba(251,247,240,0.5)' }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLAnchorElement).style.color = 'rgba(251,247,240,0.9)')
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLAnchorElement).style.color = 'rgba(251,247,240,0.5)')
              }
            >
              {link}
            </a>
          ))}
        </div>
      </div>

      <div
        className="max-w-6xl mx-auto mt-8 pt-6 text-xs"
        style={{
          borderTop: '1px solid rgba(251,247,240,0.08)',
          color: 'rgba(251,247,240,0.3)',
        }}
      >
        © {new Date().getFullYear()} Compass CHW. All rights reserved. Not a medical provider.
      </div>
    </footer>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Waitlist-first landing page for joincompasschw.com.
 * Captures name + email from interested visitors while the full
 * platform is under construction.
 */
export function WaitlistLandingPage() {
  return (
    <div className="min-h-[100dvh]">
      <Nav />
      <Hero />
      <Verticals />
      <StatsBar />
      <HowItWorks />
      <BottomCTA />
      <Footer />
    </div>
  );
}
