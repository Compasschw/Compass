import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Compass, CheckCircle2 } from 'lucide-react';
import { useAuth } from './AuthContext';
import type { UserRole } from '../../data/mock';

// ─── Step types ───────────────────────────────────────────────────────────────

type Step = 'role' | 'details';

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Two-step registration flow:
 *   Step 1 — Role selection (CHW vs Member)
 *   Step 2 — Basic details form (name, email, password)
 *
 * On submit, the user is redirected to the relevant onboarding page.
 */
export function RegisterPage() {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [step, setStep] = useState<Step>('role');
  const [selectedRole, setSelectedRole] = useState<UserRole | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  function handleRoleSelect(role: UserRole) {
    setSelectedRole(role);
    setStep('details');
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedRole || !name || !email || !password) return;

    setIsLoading(true);
    setTimeout(() => {
      login(selectedRole, name);
      navigate(
        selectedRole === 'chw' ? '/onboarding/chw' : '/onboarding/member',
      );
    }, 600);
  }

  return (
    <div className="min-h-screen bg-[#F8FAFB] flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-[#00B050] flex items-center justify-center mb-3">
            <Compass size={24} className="text-white" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold text-[#1A1A1A]">Join CompassCHW</h1>
          <p className="text-sm text-[#555555] mt-1">
            {step === 'role' ? 'Choose your account type' : 'Create your account'}
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 justify-center mb-8">
          <div
            className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${
              step === 'role'
                ? 'bg-[#00B050] text-white'
                : 'bg-[#D0F0D0] text-[#00B050]'
            }`}
          >
            {step === 'details' ? <CheckCircle2 size={14} /> : '1'}
          </div>
          <div className="w-8 h-0.5 bg-[#E5E7EB]" />
          <div
            className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${
              step === 'details'
                ? 'bg-[#00B050] text-white'
                : 'bg-[#E5E7EB] text-[#AAAAAA]'
            }`}
          >
            2
          </div>
        </div>

        {/* Step 1 — Role selection */}
        {step === 'role' && (
          <div className="space-y-3">
            <RoleCard
              role="chw"
              title="Community Health Worker"
              description="I provide navigation services, earn Medi-Cal reimbursements, and support members in my community."
              emoji="🩺"
              onSelect={handleRoleSelect}
            />
            <RoleCard
              role="member"
              title="Community Member"
              description="I need help accessing housing, healthcare, food, mental health, or recovery resources."
              emoji="🌱"
              onSelect={handleRoleSelect}
            />

            <p className="text-center text-xs text-[#555555] mt-4">
              Already have an account?{' '}
              <Link
                to="/login"
                className="text-[#0077B6] font-medium hover:underline"
              >
                Log in
              </Link>
            </p>
          </div>
        )}

        {/* Step 2 — Details form */}
        {step === 'details' && selectedRole && (
          <div className="bg-white rounded-[12px] shadow-sm border border-[#E5E7EB] px-8 py-8">
            <div className="flex items-center gap-2 mb-6">
              <span className="text-sm text-[#555555]">Registering as</span>
              <span className="text-sm font-semibold text-[#00B050]">
                {selectedRole === 'chw' ? 'Community Health Worker' : 'Community Member'}
              </span>
              <button
                type="button"
                onClick={() => setStep('role')}
                className="ml-auto text-xs text-[#0077B6] hover:underline"
              >
                Change
              </button>
            </div>

            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div>
                <label
                  htmlFor="reg-name"
                  className="block text-sm font-medium text-[#1A1A1A] mb-1.5"
                >
                  Full name
                </label>
                <input
                  id="reg-name"
                  type="text"
                  autoComplete="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your full name"
                  className="w-full rounded-[8px] border border-[#E5E7EB] px-3.5 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#AAAAAA] focus:outline-none focus:ring-2 focus:ring-[#00B050] focus:border-transparent transition"
                />
              </div>

              <div>
                <label
                  htmlFor="reg-email"
                  className="block text-sm font-medium text-[#1A1A1A] mb-1.5"
                >
                  Email address
                </label>
                <input
                  id="reg-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-[8px] border border-[#E5E7EB] px-3.5 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#AAAAAA] focus:outline-none focus:ring-2 focus:ring-[#00B050] focus:border-transparent transition"
                />
              </div>

              <div>
                <label
                  htmlFor="reg-password"
                  className="block text-sm font-medium text-[#1A1A1A] mb-1.5"
                >
                  Password
                </label>
                <input
                  id="reg-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full rounded-[8px] border border-[#E5E7EB] px-3.5 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#AAAAAA] focus:outline-none focus:ring-2 focus:ring-[#00B050] focus:border-transparent transition"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full bg-[#00B050] hover:bg-[#008F40] disabled:bg-[#D0F0D0] text-white font-semibold py-2.5 rounded-[8px] text-sm transition-colors mt-2 flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    Creating account...
                  </>
                ) : (
                  'Create Account'
                )}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Role card sub-component ──────────────────────────────────────────────────

interface RoleCardProps {
  role: UserRole;
  title: string;
  description: string;
  emoji: string;
  onSelect: (role: UserRole) => void;
}

function RoleCard({ role, title, description, emoji, onSelect }: RoleCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(role)}
      className="w-full bg-white border border-[#E5E7EB] hover:border-[#00B050] hover:bg-[#F8FAFB] rounded-[12px] p-5 text-left transition-colors group"
    >
      <div className="flex items-start gap-4">
        <span className="text-3xl leading-none" role="img" aria-hidden="true">
          {emoji}
        </span>
        <div>
          <p className="text-sm font-semibold text-[#1A1A1A] group-hover:text-[#00B050] transition-colors">
            {title}
          </p>
          <p className="text-xs text-[#555555] mt-1 leading-relaxed">{description}</p>
        </div>
      </div>
    </button>
  );
}
