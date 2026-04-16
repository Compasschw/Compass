import { useState, useEffect } from 'react';

const REGISTER_URL = 'https://joincompasschw.com/register';

export function NavBar() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-100 flex items-center justify-between px-12 py-[18px] backdrop-blur-[16px]"
      style={{
        background: 'rgba(251,247,240,0.85)',
        borderBottom: isScrolled
          ? '1px solid rgba(44,62,45,0.1)'
          : '1px solid rgba(44,62,45,0.06)',
        WebkitBackdropFilter: 'blur(16px)',
      }}
    >
      <div className="text-[20px] font-bold tracking-[-0.03em] text-primary">
        Compass<span className="font-semibold text-accent">CHW</span>
      </div>
      <div className="flex items-center gap-8">
        <a
          href="#verticals"
          className="hidden text-[14px] font-medium text-text-secondary transition-colors hover:text-primary min-[901px]:inline"
        >
          Services
        </a>
        <a
          href="#how"
          className="hidden text-[14px] font-medium text-text-secondary transition-colors hover:text-primary min-[901px]:inline"
        >
          How It Works
        </a>
        <a
          href="#impact"
          className="hidden text-[14px] font-medium text-text-secondary transition-colors hover:text-primary min-[901px]:inline"
        >
          Impact
        </a>
        <a
          href={REGISTER_URL}
          className="rounded-[10px] bg-primary px-[22px] py-[10px] text-[13px] font-semibold text-[#F5EDE0] transition-all hover:-translate-y-px hover:bg-primary-hover"
        >
          Get Started
        </a>
      </div>
    </nav>
  );
}
