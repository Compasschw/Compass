import { useScrollAnimation } from '../hooks/useScrollAnimation';

interface Testimonial {
  quote: string;
  name: string;
  initials: string;
  location: string;
  role: 'member' | 'chw';
  avatarBg: string;
}

const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      "When I was facing eviction, I didn't know where to turn. My CHW Maria helped me find emergency rental assistance in two days. She spoke my language, she knew my neighborhood \u2014 she felt like family.",
    name: 'Rosa Delgado',
    initials: 'RD',
    location: 'Boyle Heights, Los Angeles',
    role: 'member',
    avatarBg: 'linear-gradient(135deg, #D4B896, #C4A882)',
  },
  {
    quote:
      "I've been a community health worker for seven years, but I was always limited to one organization. Compass lets me serve more people across different needs \u2014 on my own time, and I actually earn more.",
    name: 'Darnell Washington',
    initials: 'DW',
    location: 'South LA, Los Angeles',
    role: 'chw',
    avatarBg: 'linear-gradient(135deg, #8BA5B5, #7090A0)',
  },
  {
    quote:
      "After my husband's accident, I needed help understanding our insurance options and finding a therapist who spoke Arabic. Fatima at Compass guided me through everything step by step.",
    name: 'Nadia Al-Rashid',
    initials: 'NA',
    location: 'Alhambra, Los Angeles',
    role: 'member',
    avatarBg: 'linear-gradient(135deg, #B8A0C8, #A090B8)',
  },
  {
    quote:
      'The billing is seamless \u2014 I document the session, add the ICD-10 codes, and Compass handles the Medi-Cal claim. I used to spend hours on paperwork. Now I spend that time with my members.',
    name: 'Linh Tran Nguyen',
    initials: 'LT',
    location: 'Alhambra, Los Angeles',
    role: 'chw',
    avatarBg: 'linear-gradient(135deg, #A0C4B0, #88B098)',
  },
];

export function TestimonialsSection() {
  const header = useScrollAnimation();
  const grid = useScrollAnimation();

  return (
    <section className="bg-card px-6 py-16 min-[901px]:px-12 min-[901px]:py-[100px]">
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
            Stories
          </div>
          <div className="mb-[14px] text-[32px] font-bold leading-[1.1] tracking-[-0.03em] text-primary min-[901px]:text-[40px]">
            From our community
          </div>
          <div className="mb-12 max-w-[520px] text-[17px] leading-[1.6] text-text-secondary">
            Real people navigating real challenges — with a little help from their neighbors.
          </div>
        </div>

        <div
          ref={grid.ref}
          className="grid gap-6 min-[901px]:grid-cols-2"
          style={{
            opacity: grid.isVisible ? 1 : 0,
            transform: grid.isVisible ? 'translateY(0)' : 'translateY(24px)',
            transition: 'opacity 0.7s cubic-bezier(0.22, 1, 0.36, 1), transform 0.7s cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          {TESTIMONIALS.map((t) => (
            <TestimonialCard key={t.name} testimonial={t} />
          ))}
        </div>
      </div>
    </section>
  );
}

function TestimonialCard({ testimonial }: { testimonial: Testimonial }) {
  const isMember = testimonial.role === 'member';
  const badgeClass = isMember
    ? 'bg-accent-light text-accent'
    : 'bg-[rgba(212,184,150,0.2)] text-[#A08060]';

  return (
    <div className="relative rounded-[20px] bg-warm-bg px-8 py-9">
      <div className="absolute top-6 left-7 text-[48px] font-extrabold leading-none text-[rgba(107,143,113,0.15)]">
        &ldquo;
      </div>
      <div className="mb-6 pt-5 text-[16px] leading-[1.65] text-primary">
        {testimonial.quote}
      </div>
      <div className="flex items-center gap-[14px]">
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] text-[15px] font-bold text-white"
          style={{ background: testimonial.avatarBg }}
        >
          {testimonial.initials}
        </div>
        <div>
          <div className="text-[14px] font-semibold text-primary">{testimonial.name}</div>
          <div className="text-[12px] text-[#999]">{testimonial.location}</div>
          <span
            className={`mt-1 inline-block rounded-[6px] px-[10px] py-[3px] text-[10px] font-semibold uppercase tracking-[0.05em] ${badgeClass}`}
          >
            {testimonial.role === 'member' ? 'Member' : 'CHW'}
          </span>
        </div>
      </div>
    </div>
  );
}
