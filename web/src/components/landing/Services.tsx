import { motion } from "framer-motion";
import { Home, Pill, Apple, Brain, HeartPulse } from "lucide-react";

const services = [
  {
    icon: Home,
    title: "Housing",
    description: "Help members find rental assistance, shelter, and housing stability resources.",
  },
  {
    icon: Pill,
    title: "Rehab & Recovery",
    description: "Connect members to substance use recovery, sober living, and peer support.",
  },
  {
    icon: Apple,
    title: "Food & Pantry",
    description: "Navigate CalFresh enrollment, food pantries, and nutrition programs.",
  },
  {
    icon: Brain,
    title: "Mental Health",
    description: "Refer members to counseling, crisis support, and wellness check-ins.",
  },
  {
    icon: HeartPulse,
    title: "Healthcare",
    description: "Assist with Medi-Cal enrollment, appointments, and care coordination.",
  },
];

const stats = [
  { value: "81%", label: "CHW session completion" },
  { value: "5", label: "Service verticals" },
  { value: "$22", label: "Avg. earning / session" },
  { value: "$0", label: "Cost to members" },
];

const Services = () => {
  return (
    <section id="services" className="py-20 md:py-28 bg-background">
      <div className="container">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5 }}
          className="text-center mb-14"
        >
          <p className="text-label text-primary uppercase tracking-wider mb-3">Service Areas</p>
          <h2 className="text-display-md md:text-display-lg text-foreground">
            Five verticals where <strong>CHWs make an impact</strong>
          </h2>
          <p className="text-body-lg text-muted-foreground mt-3 max-w-2xl mx-auto">
            As a Compass CHW, you'll guide members through these critical service areas — and get reimbursed for each session.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {services.map((service, i) => (
            <motion.div
              key={service.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: i * 0.08 }}
              className="group bg-card rounded-2xl p-6 border border-border hover:bg-primary hover:border-primary transition-all duration-300 cursor-default"
            >
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4 bg-primary/10 group-hover:bg-primary-foreground/20 transition-colors">
                <service.icon className="w-6 h-6 text-primary group-hover:text-primary-foreground transition-colors" />
              </div>
              <h3 className="font-display font-bold text-foreground group-hover:text-primary-foreground mb-2 transition-colors">{service.title}</h3>
              <p className="text-body-sm text-muted-foreground group-hover:text-primary-foreground/80 leading-relaxed transition-colors">{service.description}</p>
            </motion.div>
          ))}
        </div>

        {/* Stats Bar */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="mt-16 bg-primary rounded-2xl p-8 md:p-10"
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {stats.map((stat) => (
              <div key={stat.label} className="text-center">
                <p className="text-display-md md:text-display-lg text-primary-foreground font-display">{stat.value}</p>
                <p className="text-body-sm text-primary-foreground/70 mt-1">{stat.label}</p>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default Services;
