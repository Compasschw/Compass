const REGISTER_URL = 'https://joincompasschw.com/register';

export function HeroSection() {
  return (
    <section
      className="relative flex min-h-[92vh] items-center overflow-hidden px-6 pt-[120px] pb-16 min-[901px]:px-12 min-[901px]:pt-[140px] min-[901px]:pb-[100px]"
      style={{
        background: 'linear-gradient(165deg, #FBF7F0 0%, #F3EDE4 60%, #EDE5D8 100%)',
      }}
    >
      {/* Decorative radial overlays */}
      <div
        className="pointer-events-none absolute -top-[200px] -right-[100px] h-[600px] w-[600px] rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(107,143,113,0.06) 0%, transparent 65%)' }}
      />
      <div
        className="pointer-events-none absolute -bottom-[150px] -left-[50px] h-[400px] w-[400px] rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(212,184,150,0.08) 0%, transparent 65%)' }}
      />

      <div className="relative z-1 mx-auto grid w-full max-w-[1200px] items-center gap-10 min-[901px]:grid-cols-2 min-[901px]:gap-16">
        {/* Left: Headline */}
        <div className="max-w-[480px]">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full bg-accent-light px-4 py-[7px] text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">
            <span className="h-[6px] w-[6px] rounded-full bg-accent" style={{ animation: 'pulse-dot 2s ease-in-out infinite' }} />
            Community Health Workers
          </div>
          <h1 className="mb-5 text-[36px] font-bold leading-[1.06] tracking-[-0.03em] text-primary min-[901px]:text-[52px]">
            Community health,<br />
            <span className="text-accent">connected.</span>
          </h1>
          <p className="mb-9 max-w-[420px] text-[17px] leading-[1.6] text-text-secondary">
            Whether you need help navigating housing, food, or healthcare — or you're a CHW
            ready to serve your neighborhood — Compass is your starting point.
          </p>
          <div className="flex flex-wrap gap-5">
            <TrustItem label="HIPAA Compliant" />
            <TrustItem label="Medi-Cal Certified" />
            <TrustItem label="No Cost to Members" />
          </div>
        </div>

        {/* Right: Path Cards */}
        <div className="flex flex-col gap-4">
          <PathCard
            variant="member"
            icon={'\u{1F64B}'}
            heading="I Need Help"
            description="Find a certified health worker from your neighborhood who speaks your language and knows your community."
            ctaLabel="Get Matched"
            hint="Free with your health plan"
          />
          <PathCard
            variant="chw"
            icon={'\u{1F4BC}'}
            heading="I'm a CHW"
            description="Accept work on your schedule. Bill through Medi-Cal. Grow your member panel at your own pace."
            ctaLabel="Start Earning"
            hint="$22/unit \u00B7 Flexible hours"
          />
        </div>
      </div>
    </section>
  );
}

function TrustItem({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] font-medium text-[#999]">
      <div className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-light text-[10px] font-bold text-accent">
        &#10003;
      </div>
      {label}
    </div>
  );
}

function PathCard({
  variant,
  icon,
  heading,
  description,
  ctaLabel,
  hint,
}: {
  variant: 'member' | 'chw';
  icon: string;
  heading: string;
  description: string;
  ctaLabel: string;
  hint: string;
}) {
  const isMember = variant === 'member';
  const accentBar = isMember
    ? 'linear-gradient(90deg, #6B8F71, #8FB896)'
    : 'linear-gradient(90deg, #D4B896, #C4A882)';
  const iconBg = isMember
    ? 'linear-gradient(135deg, #E8F0E9, #D8E8DA)'
    : 'linear-gradient(135deg, #F0EBE3, #E8E0D4)';

  return (
    <a
      href={REGISTER_URL}
      className="group relative block cursor-pointer overflow-hidden rounded-[20px] bg-card p-7 no-underline shadow-[0_4px_24px_rgba(44,62,45,0.05),0_1px_3px_rgba(44,62,45,0.04)] transition-all duration-300 hover:-translate-y-[3px] hover:shadow-[0_12px_40px_rgba(44,62,45,0.08)]"
      style={{ transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }}
    >
      {/* Top accent bar */}
      <div
        className="absolute top-0 right-0 left-0 h-[3px] rounded-t-[20px]"
        style={{ background: accentBar }}
      />

      <div className="mb-4 flex items-start gap-4">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] text-[22px]"
          style={{ background: iconBg }}
        >
          {icon}
        </div>
        <div>
          <div className="mb-1 text-[22px] font-bold tracking-[-0.02em] text-primary">
            {heading}
          </div>
          <div className="text-[14px] leading-[1.5] text-text-secondary">{description}</div>
        </div>
      </div>
      <div className="flex items-center justify-between">
        {isMember ? (
          <span className="inline-flex items-center gap-2 rounded-[12px] bg-primary px-[26px] py-[13px] text-[14px] font-semibold text-[#F5EDE0] transition-all group-hover:-translate-y-px group-hover:bg-primary-hover">
            {ctaLabel} &rarr;
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-[12px] border-[1.5px] border-[rgba(44,62,45,0.18)] bg-transparent px-[26px] py-[13px] text-[14px] font-semibold text-primary transition-all group-hover:-translate-y-px group-hover:border-[rgba(44,62,45,0.35)]">
            {ctaLabel} &rarr;
          </span>
        )}
        <span className="text-[12px] text-text-muted">{hint}</span>
      </div>
    </a>
  );
}
