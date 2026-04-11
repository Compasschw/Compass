import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowRight, Shield, CheckCircle, DollarSign } from "lucide-react";
import heroImage from "@/assets/hero-chw.jpg";

const Hero = () => {
  const navigate = useNavigate();
  return (
    <section className="relative overflow-hidden bg-background">
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-lg border-b border-border">
        <div className="container flex items-center justify-between h-16">
          <a href="/" className="font-display text-xl font-bold text-foreground tracking-tight">
            Compass<span className="text-secondary">CHW</span>
          </a>
          <div className="hidden md:flex items-center gap-8">
            <a href="#" className="text-body-sm text-muted-foreground hover:text-foreground transition-colors">Home</a>
            <a href="#services" className="text-body-sm text-muted-foreground hover:text-foreground transition-colors">Services</a>
            <a href="#how-it-works" className="text-body-sm text-muted-foreground hover:text-foreground transition-colors">How It Works</a>
            <a href="#for-chws" className="text-body-sm text-muted-foreground hover:text-foreground transition-colors">For CHWs</a>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="default" size="sm" className="text-primary-foreground" onClick={() => navigate("/waitlist")}>Join Waitlist</Button>
          </div>
        </div>
      </nav>

      {/* Hero Content */}
      <div className="container pt-32 pb-16 md:pt-40 md:pb-24">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Left */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 mb-6">
              <div className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
              <span className="text-label text-primary uppercase">Launching in Los Angeles</span>
            </div>

            <h1 className="text-display-lg md:text-display-xl tracking-tight text-foreground">
              Your CHW career,{" "}
              <span className="text-secondary">on your terms.</span>
            </h1>

            <p className="mt-5 text-body-lg text-muted-foreground max-w-lg">
              Compass connects <strong className="text-foreground">Community Health Workers</strong> with residents who need help navigating housing, food, recovery, and healthcare — and <strong className="text-foreground">pays you for every session</strong> through Medi-Cal.
            </p>

            <div className="mt-8 flex flex-col sm:flex-row gap-3">
              <Button variant="hero" size="xl" className="text-primary-foreground">
                Start Earning as a CHW
                <ArrowRight className="ml-1" />
              </Button>
              <Button variant="outline" size="xl">
                I Need Help
              </Button>
            </div>

            {/* Trust badges */}
            <div className="mt-8 flex flex-wrap gap-3">
              {[
                { icon: Shield, label: "HIPAA Compliant" },
                { icon: CheckCircle, label: "Medi-Cal Reimbursed" },
                { icon: DollarSign, label: "$0 Cost to Members" },
              ].map(({ icon: Icon, label }) => (
                <div key={label} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-card border border-border shadow-card">
                  <Icon className="w-4 h-4 text-primary" />
                  <span className="text-body-sm font-medium text-foreground">{label}</span>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Right - Hero Image */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.7, delay: 0.2 }}
            className="relative hidden lg:block"
          >
            <div className="relative rounded-3xl overflow-hidden shadow-elevated">
              <img
                src={heroImage}
                alt="Community Health Worker helping a community member navigate healthcare paperwork"
                className="w-full h-auto object-cover aspect-[4/3]"
                width={1280}
                height={854}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-compass-dark/40 via-transparent to-transparent" />
              
              {/* Floating stat card */}
              <div className="absolute bottom-6 left-6 right-6 bg-primary/95 backdrop-blur-md rounded-2xl p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-label text-primary-foreground/70 uppercase">Active CHWs</p>
                    <p className="text-display-sm text-primary-foreground">200+</p>
                  </div>
                  <div className="h-10 w-px bg-primary-foreground/20" />
                  <div>
                    <p className="text-label text-primary-foreground/70 uppercase">Avg. Earnings</p>
                    <p className="text-display-sm text-primary-foreground">$22<span className="text-body-sm text-primary-foreground/70">/session</span></p>
                  </div>
                  <div className="h-10 w-px bg-primary-foreground/20" />
                  <div>
                    <p className="text-label text-primary-foreground/70 uppercase">Member Cost</p>
                    <p className="text-display-sm text-primary-foreground">$0</p>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default Hero;
