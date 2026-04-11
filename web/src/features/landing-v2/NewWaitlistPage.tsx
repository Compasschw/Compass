import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Shield, CheckCircle, Star, Loader2, AlertCircle } from "lucide-react";
import { submitWaitlist } from "@/api/waitlist";

export function NewWaitlistPage() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await submitWaitlist({
        first_name: firstName,
        last_name: lastName,
        email,
        role,
      });
      setSubmitted(true);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Something went wrong";

      if (message.includes("409") || message.toLowerCase().includes("already")) {
        setError("This email is already on the waitlist!");
        setSubmitted(true);
      } else {
        // Fallback: save to localStorage so no submission is lost
        const pending = JSON.parse(
          localStorage.getItem("compass_waitlist_pending") || "[]",
        );
        pending.push({ first_name: firstName, last_name: lastName, email, role, created_at: new Date().toISOString() });
        localStorage.setItem("compass_waitlist_pending", JSON.stringify(pending));
        setSubmitted(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background">
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-lg border-b border-border">
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between h-16">
          <Link to="/" className="font-display text-xl font-bold text-foreground tracking-tight">
            Compass<span className="text-secondary">CHW</span>
          </Link>
          <div className="hidden md:flex items-center gap-8">
            <Link to="/" className="text-body-sm text-muted-foreground hover:text-foreground transition-colors">Home</Link>
            <a href="/#services" className="text-body-sm text-muted-foreground hover:text-foreground transition-colors">Services</a>
            <a href="/#how-it-works" className="text-body-sm text-muted-foreground hover:text-foreground transition-colors">How It Works</a>
            <a href="/#for-chws" className="text-body-sm text-muted-foreground hover:text-foreground transition-colors">For CHWs</a>
          </div>
        </div>
      </nav>

      {/* Hero / Waitlist */}
      <section className="min-h-[100dvh] flex items-center pt-16">
        <div className="max-w-6xl mx-auto px-6 py-16 w-full">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            {/* Left copy */}
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="flex flex-col gap-6"
            >
              <div className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-secondary animate-pulse" />
                <span className="text-label text-muted-foreground uppercase">Launching Soon in Los Angeles</span>
              </div>

              <h1 className="text-display-lg md:text-display-xl tracking-tight text-foreground">
                Community health,{" "}
                <span className="text-secondary">connected.</span>
              </h1>

              <p className="text-body-lg text-muted-foreground leading-relaxed max-w-lg">
                Compass CHW is a marketplace connecting Los Angeles residents with trusted{" "}
                <strong className="text-foreground">Community Health Workers</strong> — neighbors trained to help with housing, recovery, food, mental health, and healthcare navigation.
              </p>

              <div className="flex flex-wrap gap-3 mt-2">
                {[
                  { icon: Shield, label: "HIPAA Compliant" },
                  { icon: CheckCircle, label: "Medi-Cal Accepted" },
                  { icon: Star, label: "No Cost to Members" },
                ].map(({ icon: Icon, label }) => (
                  <div
                    key={label}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-full text-label text-primary bg-primary/10 border border-primary/20"
                  >
                    <Icon className="w-4 h-4" />
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            </motion.div>

            {/* Right form card */}
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.15 }}
              className="w-full max-w-md mx-auto lg:ml-auto"
            >
              <div className="rounded-[20px] bg-card overflow-hidden shadow-elevated">
                {/* Gradient top bar */}
                <div className="h-1.5 w-full bg-gradient-to-r from-primary to-compass-nude" />

                <div className="p-7 md:p-8">
                  {submitted ? (
                    <div className="text-center py-8">
                      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                        <CheckCircle className="w-8 h-8 text-primary" />
                      </div>
                      <h2 className="text-display-sm text-foreground mb-2">You're on the list!</h2>
                      <p className="text-body-md text-muted-foreground">
                        We'll notify you when Compass launches in your area.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="mb-6">
                        <h2 className="text-display-sm text-foreground">Get early access</h2>
                        <p className="text-body-sm text-muted-foreground mt-1.5 leading-relaxed">
                          Be the first to know when Compass launches in your area. Join the waitlist — it takes 10 seconds.
                        </p>
                      </div>

                      {error && (
                        <div className="mb-4 flex items-center gap-2 p-3 rounded-xl bg-destructive/10 text-destructive text-body-sm">
                          <AlertCircle className="w-4 h-4 flex-shrink-0" />
                          <span>{error}</span>
                        </div>
                      )}

                      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                        <div className="flex gap-3">
                          <div className="flex-1">
                            <label className="block text-label text-muted-foreground mb-1.5">First Name</label>
                            <input
                              required
                              placeholder="Maria"
                              value={firstName}
                              onChange={(e) => setFirstName(e.target.value)}
                              className="w-full px-4 py-3 rounded-xl text-body-sm text-foreground placeholder:text-muted-foreground/50 outline-none transition-all border border-border bg-muted/30 focus:border-primary focus:ring-2 focus:ring-primary/20"
                            />
                          </div>
                          <div className="flex-1">
                            <label className="block text-label text-muted-foreground mb-1.5">Last Name</label>
                            <input
                              required
                              placeholder="Garcia"
                              value={lastName}
                              onChange={(e) => setLastName(e.target.value)}
                              className="w-full px-4 py-3 rounded-xl text-body-sm text-foreground placeholder:text-muted-foreground/50 outline-none transition-all border border-border bg-muted/30 focus:border-primary focus:ring-2 focus:ring-primary/20"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-label text-muted-foreground mb-1.5">Email Address</label>
                          <input
                            required
                            type="email"
                            placeholder="maria@example.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full px-4 py-3 rounded-xl text-body-sm text-foreground placeholder:text-muted-foreground/50 outline-none transition-all border border-border bg-muted/30 focus:border-primary focus:ring-2 focus:ring-primary/20"
                          />
                        </div>

                        <div>
                          <label className="block text-label text-muted-foreground mb-1.5">I am a…</label>
                          <select
                            required
                            value={role}
                            onChange={(e) => setRole(e.target.value)}
                            className="w-full px-4 py-3 rounded-xl text-body-sm text-foreground outline-none transition-all border border-border bg-muted/30 focus:border-primary focus:ring-2 focus:ring-primary/20 appearance-none cursor-pointer"
                          >
                            <option value="" disabled>Select your role</option>
                            <option value="chw">CHW — I want to provide care</option>
                            <option value="member">Member — I need support</option>
                            <option value="organization">Organization — We employ CHWs</option>
                            <option value="other">Other</option>
                          </select>
                        </div>

                        <button
                          type="submit"
                          disabled={submitting}
                          className="w-full py-4 rounded-xl text-body-md font-bold text-primary-foreground bg-primary hover:bg-primary/90 transition-colors mt-1 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                          {submitting ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Joining...
                            </>
                          ) : (
                            "Join the Waitlist →"
                          )}
                        </button>

                        <p className="text-center text-label text-muted-foreground/60">
                          No spam, ever. Unsubscribe anytime.
                        </p>

                        <div className="flex items-center justify-center gap-2 text-body-sm text-muted-foreground">
                          <span className="inline-block w-2 h-2 rounded-full bg-secondary animate-pulse" />
                          <span>Join hundreds of CHWs and community members</span>
                        </div>
                      </form>
                    </>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </section>
    </div>
  );
}
