import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

const PAGES: Record<string, { title: string; content: string[] }> = {
  privacy: {
    title: 'Privacy Policy',
    content: ['Compass CHW is committed to protecting your privacy. We collect only the information necessary to connect you with Community Health Workers and process Medi-Cal reimbursements. We never sell your data to third parties.', 'All personal health information (PHI) is encrypted and handled in accordance with HIPAA regulations. For questions, contact privacy@joincompasschw.com.'],
  },
  terms: {
    title: 'Terms of Service',
    content: ['By using Compass CHW, you agree to these terms. Compass CHW is a marketplace connecting community members with trained Community Health Workers. We are not a medical provider and do not provide medical advice, diagnosis, or treatment.', 'CHW services are reimbursed through Medi-Cal at no cost to eligible members. Compass CHW reserves the right to modify these terms at any time.'],
  },
  hipaa: {
    title: 'HIPAA Notice',
    content: ['Compass CHW maintains strict compliance with the Health Insurance Portability and Accountability Act (HIPAA). All protected health information (PHI) is encrypted at rest and in transit.', 'Access to PHI is restricted to authorized personnel on a minimum-necessary basis. We maintain audit logs of all PHI access. Our infrastructure partners maintain signed Business Associate Agreements (BAAs).', 'To report a privacy concern, contact hipaa@joincompasschw.com.'],
  },
  contact: {
    title: 'Contact Us',
    content: ['We would love to hear from you.', 'General inquiries: hello@joincompasschw.com', 'Partnership opportunities: partnerships@joincompasschw.com', 'HIPAA and privacy: hipaa@joincompasschw.com', 'Based in Los Angeles, California.'],
  },
};

export function LegalPage({ page }: { page: string }) {
  const info = PAGES[page] || PAGES.privacy;
  return (
    <div style={{ minHeight: "100vh", background: "#FBF7F0", fontFamily: "Outfit, Inter, system-ui" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "3rem 1.5rem" }}>
        <Link to="/landing" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, color: "#6B8F71", textDecoration: "none", marginBottom: 32 }}>
          <ArrowLeft size={16} /> Back to home
        </Link>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: "#2C3E2D", marginBottom: 16 }}>{info.title}</h1>
        {info.content.map((p, i) => (
          <p key={i} style={{ fontSize: 15, lineHeight: 1.7, color: "#555", marginBottom: 16 }}>{p}</p>
        ))}
        <p style={{ fontSize: 12, color: "#8B9B8D", marginTop: 48 }}>Last updated: April 2026. Compass CHW. All rights reserved.</p>
      </div>
    </div>
  );
}
