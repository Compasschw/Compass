import { Smartphone, ArrowRight } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";

const MobileFirst = () => {
  return (
    <section className="py-20 md:py-28 bg-compass-nude">
      <div className="container">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <p className="text-label text-primary uppercase tracking-wider mb-3">Mobile-First Platform</p>
            <h2 className="text-display-md md:text-display-lg text-foreground mb-4">
              Manage your CHW work{" "}
              <span className="text-secondary">from your pocket</span>
            </h2>
            <p className="text-body-lg text-muted-foreground mb-8 max-w-lg">
              Accept requests, log sessions, track earnings, and communicate with members — all from your phone. Compass is built mobile-first because your work happens in the field, not behind a desk.
            </p>

            <div className="space-y-4 mb-8">
              {[
                "Accept member requests in seconds",
                "Log sessions & track your earnings in real time",
                "Secure messaging with members",
                "Access the full resource directory on the go",
              ].map((item) => (
                <div key={item} className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                    <svg className="w-3.5 h-3.5 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <span className="text-body-md text-foreground font-medium">{item}</span>
                </div>
              ))}
            </div>

            <Button variant="hero" size="lg">
              Get the App
              <ArrowRight className="ml-1" />
            </Button>
          </motion.div>

          {/* Phone mockup */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="flex justify-center"
          >
            <div className="relative w-72 h-[580px] bg-compass-dark rounded-[3rem] p-3 shadow-elevated">
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-7 bg-compass-dark rounded-b-2xl z-10" />
              <div className="w-full h-full bg-card rounded-[2.4rem] overflow-hidden flex flex-col">
                {/* Status bar */}
                <div className="px-6 pt-8 pb-3 flex items-center justify-between">
                  <span className="text-body-sm text-muted-foreground">9:41</span>
                  <div className="flex gap-1">
                    <div className="w-4 h-2 bg-foreground/30 rounded-sm" />
                    <div className="w-4 h-2 bg-foreground/30 rounded-sm" />
                    <div className="w-6 h-3 bg-primary rounded-sm" />
                  </div>
                </div>

                {/* App content — CHW dashboard */}
                <div className="px-5 flex-1">
                  <div className="flex items-center gap-2 mb-4">
                    <Smartphone className="w-5 h-5 text-primary" />
                    <span className="font-display font-bold text-foreground">Compass</span>
                  </div>

                  <h3 className="font-display font-bold text-lg text-foreground mb-1">Welcome back, Carlos</h3>
                  <p className="text-body-sm text-muted-foreground mb-5">You have 2 sessions today</p>

                  {/* Session card */}
                  <div className="bg-primary rounded-2xl p-4 mb-4">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <p className="font-display font-bold text-primary-foreground text-body-md">Housing Support</p>
                        <p className="text-body-sm text-primary-foreground/70">w/ Maria G.</p>
                      </div>
                      <span className="text-label bg-primary-foreground text-primary px-2 py-1 rounded-full">2:00 PM</span>
                    </div>
                    <p className="text-body-sm text-primary-foreground/70">Rental assistance application review</p>
                  </div>

                  {/* Quick actions */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-muted rounded-xl p-3 text-center">
                      <p className="text-display-sm text-foreground font-display">$176</p>
                      <p className="text-label text-muted-foreground">This Week</p>
                    </div>
                    <div className="bg-muted rounded-xl p-3 text-center">
                      <p className="text-display-sm text-foreground font-display">24</p>
                      <p className="text-label text-muted-foreground">Sessions Done</p>
                    </div>
                  </div>
                </div>

                {/* Bottom nav */}
                <div className="px-5 py-4 border-t border-border flex justify-around">
                  {["Home", "Requests", "Sessions", "Earnings"].map((item) => (
                    <div key={item} className="flex flex-col items-center gap-1">
                      <div className={`w-5 h-5 rounded-full ${item === "Home" ? "bg-primary" : "bg-muted"}`} />
                      <span className="text-[10px] text-muted-foreground">{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default MobileFirst;
