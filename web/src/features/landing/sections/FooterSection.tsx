const REGISTER_URL = 'https://joincompasschw.com/register';

interface FooterColumn {
  title: string;
  links: { label: string; href: string }[];
}

const COLUMNS: FooterColumn[] = [
  {
    title: 'Platform',
    links: [
      { label: 'For Members', href: REGISTER_URL },
      { label: 'For CHWs', href: REGISTER_URL },
      { label: 'How It Works', href: '#how' },
      { label: 'Service Areas', href: '#verticals' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '#' },
      { label: 'Careers', href: '#' },
      { label: 'Blog', href: '#' },
      { label: 'Contact', href: '#' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy Policy', href: '#' },
      { label: 'Terms of Service', href: '#' },
      { label: 'HIPAA Notice', href: '#' },
      { label: 'Accessibility', href: '#' },
    ],
  },
];

export function FooterSection() {
  return (
    <footer className="bg-primary px-6 pt-16 pb-10 min-[901px]:px-12">
      <div className="mx-auto grid max-w-[1200px] grid-cols-1 gap-8 min-[901px]:grid-cols-[2fr_1fr_1fr_1fr] min-[901px]:gap-12">
        {/* Brand column */}
        <div>
          <div className="mb-3 text-[22px] font-bold text-[#F5EDE0]">
            Compass<span className="font-semibold text-[#8FB896]">CHW</span>
          </div>
          <p className="max-w-[280px] text-[14px] leading-[1.6] text-[rgba(255,255,255,0.4)]">
            The first gig-economy marketplace for community health workers. Connecting
            neighborhoods to the care they deserve.
          </p>
        </div>

        {/* Link columns */}
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <h4 className="mb-4 text-[12px] font-semibold uppercase tracking-[0.08em] text-[rgba(255,255,255,0.35)]">
              {col.title}
            </h4>
            {col.links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="mb-[10px] block text-[14px] text-[rgba(255,255,255,0.6)] no-underline transition-colors hover:text-[#F5EDE0]"
              >
                {link.label}
              </a>
            ))}
          </div>
        ))}
      </div>

      {/* Bottom bar */}
      <div className="mx-auto mt-10 flex max-w-[1200px] items-center justify-between border-t border-[rgba(255,255,255,0.08)] pt-6 text-[13px] text-[rgba(255,255,255,0.3)]">
        <span>&copy; 2026 CompassCHW. All rights reserved.</span>
        <span>Los Angeles, California</span>
      </div>
    </footer>
  );
}
