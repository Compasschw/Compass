import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Eye, EyeOff } from 'lucide-react';
import { ADMIN_KEY_STORAGE, validateAdminKey, AdminApiError } from './adminApi';

/**
 * Admin key login page.
 *
 * The ADMIN_KEY is a shared secret (not a user JWT).
 * It is stored in sessionStorage — cleared automatically when the browser closes.
 *
 * On submit:
 *   1. Calls /api/v1/admin/stats to validate the key.
 *   2. On 200 → stores key + navigates to /admin.
 *   3. On 401 → shows "Invalid admin key" error.
 *   4. On other errors → shows the API error message.
 */
export function AdminLogin() {
  const navigate = useNavigate();

  const [keyValue, setKeyValue] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = keyValue.trim();
    if (!trimmed) return;

    setIsLoading(true);
    setError(null);

    try {
      const isValid = await validateAdminKey(trimmed);
      if (!isValid) {
        setError('Invalid admin key. Check your credentials and try again.');
        return;
      }
      sessionStorage.setItem(ADMIN_KEY_STORAGE, trimmed);
      navigate('/admin', { replace: true });
    } catch (err) {
      if (err instanceof AdminApiError) {
        setError(`Server error (${err.status}): ${err.message}`);
      } else {
        setError('Unable to reach the server. Check your connection.');
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#FBF7F0] flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm bg-white rounded-[20px] shadow-sm border border-[rgba(44,62,45,0.1)] px-8 py-10">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-[#2C3E2D] flex items-center justify-center mb-3">
            <ShieldCheck size={24} className="text-white" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold text-[#2C3E2D]">Admin Access</h1>
          <p className="text-sm text-[#6B7B6D] mt-1">CompassCHW dashboard</p>
        </div>

        {/* Error message */}
        {error !== null && (
          <div
            role="alert"
            className="mb-4 p-3 rounded-[12px] bg-red-50 border border-red-200 text-sm text-red-700"
          >
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <label
              htmlFor="admin-key"
              className="block text-sm font-medium text-[#2C3E2D] mb-1.5"
            >
              Admin key
            </label>
            <div className="relative">
              <input
                id="admin-key"
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                required
                value={keyValue}
                onChange={(e) => setKeyValue(e.target.value)}
                placeholder="Paste your admin key"
                className="w-full rounded-[20px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 pr-10 text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-[#8B9B8D] hover:text-[#6B7B6D] transition-colors"
                aria-label={showKey ? 'Hide admin key' : 'Show admin key'}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading || keyValue.trim().length === 0}
            className="w-full bg-[#2C3E2D] hover:bg-[#3A5240] disabled:bg-[rgba(44,62,45,0.2)] text-white font-semibold py-2.5 rounded-[12px] text-sm transition-colors mt-2 flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <span
                  className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"
                  aria-hidden="true"
                />
                Verifying...
              </>
            ) : (
              'Access Dashboard'
            )}
          </button>
        </form>

        <p className="text-center text-xs text-[#8B9B8D] mt-6">
          Session clears when you close the browser tab.
        </p>
      </div>
    </div>
  );
}
