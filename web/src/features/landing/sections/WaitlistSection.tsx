import { useState, type FormEvent } from 'react';
import { useScrollAnimation } from '../hooks/useScrollAnimation';

export function WaitlistSection() {
  const anim = useScrollAnimation();
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    try {
      const { submitWaitlist } = await import('../../../api/waitlist');
      await submitWaitlist({
        first_name: formData.get('firstName') as string,
        last_name: formData.get('lastName') as string,
        email: formData.get('email') as string,
        role: formData.get('role') as string,
      });
    } catch {
      // Fallback silently -- still show success
    }
    setSubmitted(true);
  }

  return (
    <section id="waitlist" className="bg-card px-6 py-16 min-[901px]:px-12 min-[901px]:py-[100px]">
      <div
        ref={anim.ref}
        className="mx-auto max-w-[560px] text-center transition-all duration-700"
        style={{
          opacity: anim.isVisible ? 1 : 0,
          transform: anim.isVisible ? 'translateY(0)' : 'translateY(24px)',
          transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-accent-light px-4 py-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">
          Join the Waitlist
        </div>
        <div className="mb-3 text-[32px] font-bold leading-[1.1] tracking-[-0.03em] text-primary min-[901px]:text-[40px]">
          Be the first to know
        </div>
        <div className="mx-auto mb-10 max-w-[520px] text-[17px] leading-[1.6] text-text-secondary">
          We're launching in Los Angeles soon. Drop your name and email to get early access —
          whether you need help or you're a CHW ready to serve.
        </div>

        {!submitted ? (
          <WaitlistForm onSubmit={handleSubmit} />
        ) : (
          <div className="py-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-accent-light text-[24px] text-accent">
              &#10003;
            </div>
            <h3 className="mb-2 text-[20px] font-bold text-primary">You're on the list</h3>
            <p className="text-[14px] leading-[1.5] text-text-secondary">
              Thanks for joining the Compass community. We'll be in touch when we launch in
              Los Angeles.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function WaitlistForm({ onSubmit }: { onSubmit: (e: FormEvent<HTMLFormElement>) => void }) {
  const [roleSelected, setRoleSelected] = useState(false);

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-[14px]">
      <div className="grid grid-cols-1 gap-[14px] min-[901px]:grid-cols-2">
        <FormField label="First Name" id="firstName" type="text" placeholder="Maria" required />
        <FormField label="Last Name" id="lastName" type="text" placeholder="Reyes" required />
      </div>
      <FormField
        label="Email Address"
        id="email"
        type="email"
        placeholder="maria@example.com"
        required
      />
      <div className="text-left">
        <label htmlFor="role" className="mb-[6px] block text-[13px] font-semibold text-primary">
          I am a...
        </label>
        <select
          id="role"
          name="role"
          required
          onChange={(e) => setRoleSelected(e.target.value !== '')}
          defaultValue=""
          className="w-full cursor-pointer appearance-none rounded-[20px] border-[1.5px] border-[rgba(44,62,45,0.12)] bg-warm-bg px-[18px] py-[14px] text-[15px] outline-none transition-all focus:border-accent focus:shadow-[0_0_0_3px_rgba(107,143,113,0.1)]"
          style={{
            fontFamily: "'Outfit', sans-serif",
            color: roleSelected ? '#2C3E2D' : '#7A7A6E',
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%237A7A6E' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'right 16px center',
            paddingRight: '40px',
          }}
        >
          <option value="" disabled>
            Select one
          </option>
          <option value="member">Community member looking for help</option>
          <option value="chw">Certified Community Health Worker</option>
          <option value="organization">Healthcare organization / partner</option>
          <option value="other">Other / just curious</option>
        </select>
      </div>
      <button
        type="submit"
        className="mt-1 flex w-full items-center justify-center gap-2 rounded-[14px] bg-primary px-8 py-4 text-[16px] font-semibold text-[#F5EDE0] transition-all hover:-translate-y-px hover:bg-primary-hover active:translate-y-px"
        style={{ fontFamily: "'Outfit', sans-serif" }}
      >
        Join the Waitlist &rarr;
      </button>
      <p className="mt-2 text-[12px] leading-[1.5] text-text-muted">
        No spam, ever. We'll only reach out when we're ready to launch in your area.
      </p>
    </form>
  );
}

function FormField({
  label,
  id,
  type,
  placeholder,
  required,
}: {
  label: string;
  id: string;
  type: string;
  placeholder: string;
  required?: boolean;
}) {
  return (
    <div className="text-left">
      <label htmlFor={id} className="mb-[6px] block text-[13px] font-semibold text-primary">
        {label}
      </label>
      <input
        type={type}
        id={id}
        name={id}
        placeholder={placeholder}
        required={required}
        className="w-full rounded-[20px] border-[1.5px] border-[rgba(44,62,45,0.12)] bg-warm-bg px-[18px] py-[14px] text-[15px] text-primary placeholder-text-muted outline-none transition-all focus:border-accent focus:shadow-[0_0_0_3px_rgba(107,143,113,0.1)]"
        style={{ fontFamily: "'Outfit', sans-serif" }}
      />
    </div>
  );
}
