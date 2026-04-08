import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Eye, EyeOff, Compass } from 'lucide-react';
import { useAuth } from './AuthContext';
import type { UserRole } from '../../data/mock';

// ─── Demo quick-login helpers ─────────────────────────────────────────────────

const DEMO_ACCOUNTS: { role: UserRole; name: string; label: string }[] = [
  { role: 'chw', name: 'Maria Guadalupe Reyes', label: 'Demo as CHW' },
  { role: 'member', name: 'Rosa Delgado', label: 'Demo as Member' },
];

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Login page — matches the "Welcome Back" aesthetic from the design slides.
 * In mockup mode there is no real auth; pressing Log In with any credentials
 * will route to the CHW dashboard. The demo buttons let reviewers jump
 * directly into either role without typing.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email || !password) return;

    setIsLoading(true);
    // Simulate a brief network delay for realism
    setTimeout(() => {
      // Default to CHW when form is submitted without a demo selection
      login('chw', 'Maria Guadalupe Reyes');
      navigate('/chw/dashboard');
    }, 600);
  }

  function handleDemoLogin(role: UserRole, name: string, destination: string) {
    login(role, name);
    navigate(destination);
  }

  return (
    <div className="min-h-screen bg-[#FBF7F0] flex flex-col items-center justify-center px-4 py-12">
      {/* Card */}
      <div className="w-full max-w-sm bg-white rounded-[20px] shadow-sm border border-[rgba(44,62,45,0.1)] px-8 py-10">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-[#2C3E2D] flex items-center justify-center mb-3">
            <Compass size={24} className="text-white" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold text-[#2C3E2D]">Welcome Back</h1>
          <p className="text-sm text-[#6B7B6D] mt-1">Sign in to CompassCHW</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-[#2C3E2D] mb-1.5"
            >
              Email address
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-[20px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-[#2C3E2D] mb-1.5"
            >
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-[20px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 pr-10 text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-[#8B9B8D] hover:text-[#6B7B6D] transition-colors"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-[#2C3E2D] hover:bg-[#3A5240] disabled:bg-[rgba(44,62,45,0.2)] text-white font-semibold py-2.5 rounded-[12px] text-sm transition-colors mt-2 flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                Signing in...
              </>
            ) : (
              'Log In'
            )}
          </button>
        </form>

        {/* Divider */}
        <div className="flex items-center gap-3 my-6">
          <div className="flex-1 border-t border-[rgba(44,62,45,0.1)]" />
          <span className="text-xs text-[#8B9B8D] font-medium">or try a demo</span>
          <div className="flex-1 border-t border-[rgba(44,62,45,0.1)]" />
        </div>

        {/* Demo quick-login buttons */}
        <div className="space-y-2">
          {DEMO_ACCOUNTS.map(({ role, name, label }) => (
            <button
              key={role}
              type="button"
              onClick={() =>
                handleDemoLogin(
                  role,
                  name,
                  role === 'chw' ? '/chw/dashboard' : '/member/home',
                )
              }
              className="w-full border border-[rgba(44,62,45,0.1)] hover:border-[#6B8F71] hover:bg-[#FBF7F0] text-[#6B7B6D] hover:text-[#6B8F71] font-medium py-2.5 rounded-[12px] text-sm transition-colors"
            >
              {label}
            </button>
          ))}
        </div>

        {/* Register link */}
        <p className="text-center text-xs text-[#6B7B6D] mt-6">
          New to CompassCHW?{' '}
          <Link
            to="/register"
            className="text-[#0077B6] font-medium hover:underline"
          >
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
