import Hero from "@/components/landing/Hero";
import Services from "@/components/landing/Services";
import HowItWorks from "@/components/landing/HowItWorks";
import ForCHWs from "@/components/landing/ForCHWs";
import MobileFirst from "@/components/landing/MobileFirst";
import CTASection from "@/components/landing/CTASection";
import Footer from "@/components/landing/Footer";

export function NewLandingPage() {
  return (
    <div className="min-h-screen">
      <Hero />
      <Services />
      <HowItWorks />
      <ForCHWs />
      <MobileFirst />
      <CTASection />
      <Footer />
    </div>
  );
}
