import { motion } from "framer-motion";
import { Briefcase, Users, DollarSign } from "lucide-react";

const steps = [
  {
    number: "01",
    icon: Briefcase,
    title: "Sign up as a CHW",
    description: "Create your profile, verify your training, and set your availability. It takes under 5 minutes.",
  },
  {
    number: "02",
    icon: Users,
    title: "Get matched with members",
    description: "Compass connects you with community members in your neighborhood who need support — housing, food, recovery, or healthcare.",
  },
  {
    number: "03",
    icon: DollarSign,
    title: "Complete sessions & get paid",
    description: "Meet with members, log your sessions, and get reimbursed through Medi-Cal. Track your earnings in real time.",
  },
];

const HowItWorks = () => {
  return (
    <section id="how-it-works" className="py-20 md:py-28 bg-primary">
      <div className="container">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <p className="text-label text-primary-foreground/70 uppercase tracking-wider mb-3">How It Works</p>
          <h2 className="text-display-md md:text-display-lg text-primary-foreground">
            Three steps to <strong>start earning</strong>
          </h2>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-8 relative">
          {/* Connector line */}
          <div className="hidden md:block absolute top-16 left-[20%] right-[20%] h-px bg-primary-foreground/20" />

          {steps.map((step, i) => (
            <motion.div
              key={step.number}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.15 }}
              className="relative text-center"
            >
              <div className="relative z-10 w-14 h-14 rounded-full bg-primary-foreground flex items-center justify-center mx-auto mb-6 shadow-glow">
                <step.icon className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-display text-xl font-bold text-primary-foreground mb-3">{step.title}</h3>
              <p className="text-body-md text-primary-foreground/70 max-w-xs mx-auto">{step.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default HowItWorks;
