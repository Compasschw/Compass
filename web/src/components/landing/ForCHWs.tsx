import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ArrowRight, DollarSign, Clock, MapPin, Heart } from "lucide-react";
import chwMobileImage from "@/assets/chw-mobile.jpg";

const benefits = [
  { icon: DollarSign, title: "Earn on your schedule", description: "Get reimbursed through Medi-Cal for every session completed." },
  { icon: Clock, title: "Flexible hours", description: "Work when it suits you. No minimums, no commitments." },
  { icon: MapPin, title: "Stay in your neighborhood", description: "Help people in your own community — no long commutes." },
  { icon: Heart, title: "Make real impact", description: "Navigate your neighbors through the services they need most." },
];

const ForCHWs = () => {
  return (
    <section id="for-chws" className="py-20 md:py-28 bg-background">
      <div className="container">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-20 items-center">
          {/* Image side */}
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="relative order-2 lg:order-1"
          >
            <div className="relative rounded-3xl overflow-hidden shadow-elevated max-w-md mx-auto lg:mx-0">
              <img
                src={chwMobileImage}
                alt="Community Health Worker using the Compass app on their phone"
                className="w-full h-auto object-cover"
                loading="lazy"
                width={640}
                height={960}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-compass-dark/50 via-transparent to-transparent" />

              {/* Earnings card overlay */}
              <div className="absolute bottom-6 left-6 right-6 bg-primary/95 backdrop-blur-md rounded-xl p-4">
                <p className="text-label text-primary-foreground/70 uppercase">Avg. Earnings</p>
                <p className="text-display-sm text-primary-foreground">$22<span className="text-body-sm text-primary-foreground/70 font-normal"> / session</span></p>
                <p className="text-body-sm text-secondary mt-1 font-medium">Reimbursed via Medi-Cal</p>
              </div>
            </div>
          </motion.div>

          {/* Content side */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="order-1 lg:order-2"
          >
            <p className="text-label text-primary uppercase tracking-wider mb-3">Why CHWs Choose Compass</p>
            <h2 className="text-display-md md:text-display-lg text-foreground mb-4">
              Earn money helping <span className="text-secondary">your neighbors</span>
            </h2>
            <p className="text-body-lg text-muted-foreground mb-8 max-w-lg">
              Join Compass as a CHW and get reimbursed for every session. Work flexible hours, stay local, and build a career making a real difference in your community.
            </p>

            <div className="grid sm:grid-cols-2 gap-4 mb-8">
              {benefits.map((b) => (
                <div key={b.title} className="flex gap-3 items-start">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <b.icon className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-display font-bold text-foreground text-body-md">{b.title}</p>
                    <p className="text-body-sm text-muted-foreground">{b.description}</p>
                  </div>
                </div>
              ))}
            </div>

            <Button variant="hero" size="lg">
              Start Earning Today
              <ArrowRight className="ml-1" />
            </Button>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default ForCHWs;
