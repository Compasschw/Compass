const Footer = () => {
  return (
    <footer className="bg-compass-dark py-12 md:py-16">
      <div className="container">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
          <div className="col-span-2 md:col-span-1">
            <a href="/" className="font-display text-xl font-bold text-primary-foreground tracking-tight">
              Compass<span className="text-secondary">CHW</span>
            </a>
            <p className="text-body-sm text-primary-foreground/60 mt-3 max-w-xs">
              The marketplace connecting Community Health Workers with the neighbors who need them.
            </p>
          </div>

          <div>
            <h4 className="font-display font-bold text-primary-foreground mb-4 text-body-sm">For CHWs</h4>
            <ul className="space-y-2">
              {["Start Earning", "How It Works", "CHW Resources", "FAQs"].map((item) => (
                <li key={item}>
                  <a href="#" className="text-body-sm text-primary-foreground/60 hover:text-primary-foreground transition-colors">{item}</a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-display font-bold text-primary-foreground mb-4 text-body-sm">Company</h4>
            <ul className="space-y-2">
              {["About", "Blog", "Careers", "Contact"].map((item) => (
                <li key={item}>
                  <a href="#" className="text-body-sm text-primary-foreground/60 hover:text-primary-foreground transition-colors">{item}</a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-display font-bold text-primary-foreground mb-4 text-body-sm">Legal</h4>
            <ul className="space-y-2">
              {["Privacy Policy", "Terms of Service", "HIPAA Notice"].map((item) => (
                <li key={item}>
                  <a href="#" className="text-body-sm text-primary-foreground/60 hover:text-primary-foreground transition-colors">{item}</a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="border-t border-primary-foreground/10 pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-body-sm text-primary-foreground/40">
            © {new Date().getFullYear()} Compass CHW. All rights reserved.
          </p>
          <div className="flex gap-6">
            {["Twitter", "LinkedIn", "Instagram"].map((social) => (
              <a key={social} href="#" className="text-body-sm text-primary-foreground/40 hover:text-primary-foreground transition-colors">
                {social}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
