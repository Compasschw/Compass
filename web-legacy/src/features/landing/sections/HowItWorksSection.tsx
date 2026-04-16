import { useScrollAnimation } from '../hooks/useScrollAnimation';

interface Step {
  number: number;
  title: string;
  description: string;
}

const MEMBER_STEPS: Step[] = [
  {
    number: 1,
    title: 'Tell us what you need',
    description:
      'Select your area of need \u2014 housing, food, rehab, mental health, or healthcare. Share your ZIP and preferred language.',
  },
  {
    number: 2,
    title: 'Get matched with a CHW',
    description:
      "We'll find a certified health worker in your neighborhood who specializes in exactly what you need.",
  },
  {
    number: 3,
    title: 'Start your health journey',
    description:
      'Meet with your CHW, set goals together, and get connected to the right resources. No cost with your Medi-Cal plan.',
  },
];

const CHW_STEPS: Step[] = [
  {
    number: 1,
    title: 'Create your profile',
    description:
      'Upload your CHW certification, set your specializations, availability, service radius, and languages.',
  },
  {
    number: 2,
    title: 'Browse community requests',
    description:
      'See real-time demand in your area. Filter by vertical, urgency, and distance. Accept work that fits your schedule.',
  },
  {
    number: 3,
    title: 'Document & get paid',
    description:
      'Complete sessions, log notes with ICD-10 codes, and bill directly through Medi-Cal at $22 per unit.',
  },
];

export function HowItWorksSection() {
  const header = useScrollAnimation();
  const memberCol = useScrollAnimation();
  const chwCol = useScrollAnimation();

  return (
    <section
      id="how"
      className="px-6 py-16 min-[901px]:px-12 min-[901px]:py-[100px]"
      style={{ background: 'linear-gradient(180deg, #F5EDE0 0%, #FBF7F0 100%)' }}
    >
      <div className="mx-auto max-w-[1200px]">
        <FadeIn anim={header}>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-accent-light px-4 py-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">
            How It Works
          </div>
          <div className="mb-[14px] text-[32px] font-bold leading-[1.1] tracking-[-0.03em] text-primary min-[901px]:text-[40px]">
            Simple for everyone
          </div>
          <div className="mb-12 max-w-[520px] text-[17px] leading-[1.6] text-text-secondary">
            Two paths, one platform. Whether you need support or you provide it — getting
            started takes minutes.
          </div>
        </FadeIn>

        <div className="grid gap-12 min-[901px]:grid-cols-2 min-[901px]:gap-16">
          <FadeIn anim={memberCol}>
            <StepColumn
              variant="member"
              label="Member"
              heading="Need help?"
              steps={MEMBER_STEPS}
            />
          </FadeIn>
          <FadeIn anim={chwCol}>
            <StepColumn
              variant="chw"
              label="CHW"
              heading="Ready to serve?"
              steps={CHW_STEPS}
            />
          </FadeIn>
        </div>
      </div>
    </section>
  );
}

function FadeIn({
  anim,
  children,
}: {
  anim: { ref: React.RefObject<HTMLDivElement | null>; isVisible: boolean };
  children: React.ReactNode;
}) {
  return (
    <div
      ref={anim.ref}
      className="transition-all duration-700"
      style={{
        opacity: anim.isVisible ? 1 : 0,
        transform: anim.isVisible ? 'translateY(0)' : 'translateY(24px)',
        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {children}
    </div>
  );
}

function StepColumn({
  variant,
  label,
  heading,
  steps,
}: {
  variant: 'member' | 'chw';
  label: string;
  heading: string;
  steps: Step[];
}) {
  const isMember = variant === 'member';
  const pillClass = isMember
    ? 'bg-[rgba(107,143,113,0.12)] text-accent'
    : 'bg-[rgba(212,184,150,0.25)] text-[#A08060]';
  const numClass = isMember
    ? 'bg-[rgba(107,143,113,0.1)] text-accent'
    : 'bg-[rgba(212,184,150,0.2)] text-[#A08060]';
  const lineColor = isMember
    ? 'rgba(107,143,113,0.1)'
    : 'rgba(212,184,150,0.2)';

  return (
    <div>
      <h3 className="mb-8 text-[22px] font-bold tracking-[-0.02em] text-primary">
        <span
          className={`mr-[10px] inline-block rounded-[6px] px-3 py-1 align-middle text-[11px] font-semibold uppercase tracking-[0.06em] ${pillClass}`}
        >
          {label}
        </span>
        {heading}
      </h3>
      <div className="flex flex-col gap-7">
        {steps.map((step, i) => (
          <div key={step.number} className="relative flex gap-[18px]">
            {/* Connector line */}
            {i < steps.length - 1 && (
              <div
                className="absolute left-[19px] top-[44px] bottom-[-24px] w-[2px]"
                style={{ background: lineColor }}
              />
            )}
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] text-[16px] font-bold ${numClass}`}
            >
              {step.number}
            </div>
            <div>
              <div className="mb-1 text-[16px] font-semibold text-primary">{step.title}</div>
              <div className="text-[14px] leading-[1.5] text-text-secondary">
                {step.description}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
