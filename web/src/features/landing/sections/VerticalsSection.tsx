import { useScrollAnimation } from '../hooks/useScrollAnimation';

interface Vertical {
  icon: string;
  title: string;
  description: string;
  iconBg: string;
}

const VERTICALS: Vertical[] = [
  {
    icon: '🏠',
    title: 'Housing',
    description: 'Shelter access, rental assistance, eviction prevention, transitional housing',
    iconBg: 'linear-gradient(135deg, #E8D8C4, #DBC8AE)',
  },
  {
    icon: '💚',
    title: 'Rehab & Recovery',
    description: 'Substance use treatment navigation, recovery support, program referrals',
    iconBg: 'linear-gradient(135deg, #D4E4D6, #C0D8C4)',
  },
  {
    icon: '🍎',
    title: 'Food & Pantry',
    description: 'SNAP & WIC enrollment, food bank navigation, nutrition programs',
    iconBg: 'linear-gradient(135deg, #F0E4D0, #E8D8BC)',
  },
  {
    icon: '🧠',
    title: 'Mental Health',
    description: 'Therapy referrals, crisis support, counseling navigation, wellness resources',
    iconBg: 'linear-gradient(135deg, #D8E8F0, #C4DCE8)',
  },
  {
    icon: '🏥',
    title: 'Healthcare',
    description: 'Insurance enrollment, preventive care access, specialist referrals',
    iconBg: 'linear-gradient(135deg, #E0E8E0, #D0DCD0)',
  },
];

export function VerticalsSection() {
  const header = useScrollAnimation();

  return (
    <section id="verticals" className="bg-card px-6 py-16 min-[901px]:px-12 min-[901px]:py-[100px]">
      <div className="mx-auto max-w-[1200px]">
        <div
          ref={header.ref}
          className="transition-all duration-700"
          style={{
            opacity: header.isVisible ? 1 : 0,
            transform: header.isVisible ? 'translateY(0)' : 'translateY(24px)',
            transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-accent-light px-4 py-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">
            5 Service Verticals
          </div>
          <div className="mb-[14px] text-[32px] font-bold leading-[1.1] tracking-[-0.03em] text-primary min-[901px]:text-[40px]">
            Navigate what matters most
          </div>
          <div className="mb-12 max-w-[520px] text-[17px] leading-[1.6] text-text-secondary">
            Our CHWs specialize across the five core social determinants of health — matching
            you with someone who understands exactly what you're going through.
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 min-[901px]:grid-cols-5">
          {VERTICALS.map((v) => (
            <VerticalCard key={v.title} vertical={v} />
          ))}
        </div>
      </div>
    </section>
  );
}

function VerticalCard({ vertical }: { vertical: Vertical }) {
  const anim = useScrollAnimation();

  return (
    <div
      ref={anim.ref}
      className="cursor-default rounded-[20px] bg-warm-bg p-7 text-center transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_12px_32px_rgba(44,62,45,0.06)]"
      style={{
        opacity: anim.isVisible ? 1 : 0,
        transform: anim.isVisible ? 'translateY(0)' : 'translateY(24px)',
        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <div
        className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[16px] text-[26px]"
        style={{ background: vertical.iconBg }}
      >
        {vertical.icon}
      </div>
      <div className="mb-[6px] text-[16px] font-bold tracking-[-0.01em] text-primary">
        {vertical.title}
      </div>
      <div className="text-[13px] leading-[1.5] text-text-secondary">{vertical.description}</div>
    </div>
  );
}
