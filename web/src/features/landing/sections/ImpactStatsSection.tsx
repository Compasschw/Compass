import { useScrollAnimation } from '../hooks/useScrollAnimation';

interface Stat {
  value: string;
  label: string;
}

const STATS: Stat[] = [
  { value: '81%', label: 'Member engagement rate with CHW-led navigation' },
  { value: '5', label: 'Social determinants of health covered' },
  { value: '$22', label: 'Per-unit Medi-Cal reimbursement for CHWs' },
  { value: '$0', label: 'Cost to members with qualifying health plans' },
];

export function ImpactStatsSection() {
  const header = useScrollAnimation();
  const grid = useScrollAnimation();

  return (
    <section id="impact" className="bg-primary px-6 py-16 min-[901px]:px-12 min-[901px]:py-20">
      <div className="mx-auto max-w-[1200px] text-center">
        <div
          ref={header.ref}
          className="transition-all duration-700"
          style={{
            opacity: header.isVisible ? 1 : 0,
            transform: header.isVisible ? 'translateY(0)' : 'translateY(24px)',
            transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-[rgba(255,255,255,0.08)] px-4 py-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8FB896]">
            Community Impact
          </div>
          <div className="mb-12 text-[32px] font-bold leading-[1.1] tracking-[-0.03em] text-[#F5EDE0] min-[901px]:text-[40px]">
            Built on real outcomes
          </div>
        </div>

        <div
          ref={grid.ref}
          className="grid grid-cols-2 gap-6 min-[901px]:grid-cols-4"
          style={{
            opacity: grid.isVisible ? 1 : 0,
            transform: grid.isVisible ? 'translateY(0)' : 'translateY(24px)',
            transition: 'opacity 0.7s cubic-bezier(0.22, 1, 0.36, 1), transform 0.7s cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          {STATS.map((stat) => (
            <div
              key={stat.value}
              className="rounded-[20px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.06)] px-5 py-8 transition-all duration-300 hover:-translate-y-[2px] hover:bg-[rgba(255,255,255,0.09)]"
            >
              <div className="mb-2 text-[42px] font-extrabold leading-none tracking-[-0.03em] text-white">
                {stat.value}
              </div>
              <div className="text-[14px] text-[rgba(255,255,255,0.5)]">{stat.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
