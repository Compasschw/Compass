import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import neighborhoodImage from "@/assets/neighborhood.jpg";

const CTASection = () => {
  return (
    <section className="py-20 md:py-28 relative overflow-hidden">
      {/* Background image */}
      <div className="absolute inset-0">
        <img
          src={neighborhoodImage}
          alt="Los Angeles neighborhood aerial view"
          className="w-full h-full object-cover"
          loading="lazy"
          width={1280}
          height={720}
        />
        <div className="absolute inset-0 bg-primary/90" />
      </div>

      <div className="container relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center max-w-2xl mx-auto"
        >
          <p className="text-label text-primary-foreground/70 uppercase tracking-wider mb-3">Limited Early Access</p>
          <h2 className="text-display-md md:text-display-lg text-primary-foreground mb-5">
            Ready to start earning as a CHW?
          </h2>
          <p className="text-body-lg text-primary-foreground/70 mb-8">
            We're opening Compass to CHWs in Los Angeles first. Secure your spot, set your availability, and start getting matched with members who need your help.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button variant="hero-outline" size="xl" className="border-primary-foreground/40 text-primary-foreground hover:bg-primary-foreground hover:text-primary">
              Join as a CHW
              <ArrowRight className="ml-1" />
            </Button>
            <Button variant="hero-outline" size="xl" className="border-primary-foreground/20 text-primary-foreground/70 hover:bg-primary-foreground/10 hover:text-primary-foreground">
              I'm a Community Member
            </Button>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default CTASection;
