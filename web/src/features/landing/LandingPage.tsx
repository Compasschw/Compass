import { NavBar } from './sections/NavBar';
import { HeroSection } from './sections/HeroSection';
import { VerticalsSection } from './sections/VerticalsSection';
import { HowItWorksSection } from './sections/HowItWorksSection';
import { ImpactStatsSection } from './sections/ImpactStatsSection';
import { TestimonialsSection } from './sections/TestimonialsSection';
import { FinalCTASection } from './sections/FinalCTASection';
import { WaitlistSection } from './sections/WaitlistSection';
import { FooterSection } from './sections/FooterSection';

export function LandingPage() {
  return (
    <div className="min-h-[100dvh]">
      <NavBar />
      <HeroSection />
      <VerticalsSection />
      <HowItWorksSection />
      <ImpactStatsSection />
      <TestimonialsSection />
      <FinalCTASection />
      <WaitlistSection />
      <FooterSection />
    </div>
  );
}
