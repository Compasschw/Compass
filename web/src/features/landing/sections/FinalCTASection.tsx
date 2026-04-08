import { useScrollAnimation } from '../hooks/useScrollAnimation';

const REGISTER_URL = 'https://joincompasschw.com/register';

export function FinalCTASection() {
  const anim = useScrollAnimation();

  return (
    <section
      className="px-6 py-16 text-center min-[901px]:px-12 min-[901px]:py-[100px]"
      style={{ background: 'linear-gradient(165deg, #F5EDE0 0%, #EDE5D8 100%)' }}
    >
      <div
        ref={anim.ref}
        className="mx-auto max-w-[640px] transition-all duration-700"
        style={{
          opacity: anim.isVisible ? 1 : 0,
          transform: anim.isVisible ? 'translateY(0)' : 'translateY(24px)',
          transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-accent-light px-4 py-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">
          Get Started
        </div>
        <div className="mb-4 text-[32px] font-bold leading-[1.1] tracking-[-0.03em] text-primary min-[901px]:text-[40px]">
          Your community is waiting
        </div>
        <div className="mx-auto mb-10 max-w-[520px] text-[17px] leading-[1.6] text-text-secondary">
          Whether you need a health navigator or you are one — Compass connects you to the
          people and resources that matter.
        </div>
        <div className="flex justify-center gap-[14px]">
          <a
            href={REGISTER_URL}
            className="inline-flex items-center gap-2 rounded-[14px] bg-primary px-9 py-4 text-[16px] font-semibold text-[#F5EDE0] no-underline transition-all hover:-translate-y-px hover:bg-primary-hover active:translate-y-px"
          >
            I Need Help &rarr;
          </a>
          <a
            href={REGISTER_URL}
            className="inline-flex items-center gap-2 rounded-[14px] border-[1.5px] border-[rgba(44,62,45,0.18)] bg-transparent px-9 py-4 text-[16px] font-semibold text-primary no-underline transition-all hover:-translate-y-px hover:border-[rgba(44,62,45,0.35)] active:translate-y-px"
          >
            I'm a CHW &rarr;
          </a>
        </div>
      </div>
    </section>
  );
}
