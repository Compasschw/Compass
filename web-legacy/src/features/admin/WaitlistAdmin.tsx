import { useState, useEffect } from 'react';
import { Trash2, Download, RefreshCw } from 'lucide-react';

interface WaitlistEntry {
  firstName?: string;
  lastName?: string;
  email: string;
  role?: string;
  submittedAt: string;
}

export function WaitlistAdmin() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);

  async function load() {
    try {
      const { fetchWaitlistEntries } = await import('../../api/waitlist');
      const apiEntries = await fetchWaitlistEntries();
      const mapped = apiEntries.map(e => ({
        firstName: e.first_name,
        lastName: e.last_name,
        email: e.email,
        role: e.role,
        submittedAt: e.created_at,
      }));
      setEntries(mapped.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)));
    } catch {
      // Fallback to localStorage
      try {
        const data = JSON.parse(localStorage.getItem('compass_waitlist') || '[]') as WaitlistEntry[];
        setEntries(data.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)));
      } catch { setEntries([]); }
    }
  }

  useEffect(() => { load(); }, []);

  function exportCSV() {
    const header = 'First Name,Last Name,Email,Role,Submitted At';
    const rows = entries.map(e =>
      [e.firstName || '', e.lastName || '', e.email, e.role || '', e.submittedAt].map(v => `"${v}"`).join(',')
    );
    const csv = [header, ...rows].join(String.fromCharCode(10));
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compass-waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearAll() {
    if (confirm('Delete all waitlist entries?')) {
      localStorage.removeItem('compass_waitlist');
      setEntries([]);
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#FBF7F0', fontFamily: "'Outfit', 'Inter', system-ui" }}>
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '2rem 1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: '#2C3E2D', margin: 0 }}>Waitlist Signups</h1>
            <p style={{ fontSize: 14, color: '#6B7B6D', margin: '4px 0 0' }}>{entries.length} total</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={load} title="Refresh" style={{ padding: '8px 12px', borderRadius: 12, border: '1px solid rgba(44,62,45,0.1)', background: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: '#2C3E2D' }}>
              <RefreshCw size={14} /> Refresh
            </button>
            <button onClick={exportCSV} disabled={entries.length === 0} style={{ padding: '8px 12px', borderRadius: 12, border: 'none', background: '#2C3E2D', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, opacity: entries.length === 0 ? 0.4 : 1 }}>
              <Download size={14} /> Export CSV
            </button>
            <button onClick={clearAll} disabled={entries.length === 0} style={{ padding: '8px 12px', borderRadius: 12, border: '1px solid rgba(220,38,38,0.2)', background: 'white', color: '#DC2626', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, opacity: entries.length === 0 ? 0.4 : 1 }}>
              <Trash2 size={14} /> Clear
            </button>
          </div>
        </div>

        {entries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '4rem 1rem', background: 'white', borderRadius: 20, border: '1px solid rgba(44,62,45,0.06)' }}>
            <p style={{ fontSize: 16, color: '#6B7B6D' }}>No signups yet. Share your landing page!</p>
          </div>
        ) : (
          <div style={{ background: 'white', borderRadius: 20, border: '1px solid rgba(44,62,45,0.06)', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(44,62,45,0.08)' }}>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: '#2C3E2D', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Name</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: '#2C3E2D', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Email</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: '#2C3E2D', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Role</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: '#2C3E2D', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>When</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i} style={{ borderBottom: i < entries.length - 1 ? '1px solid rgba(44,62,45,0.04)' : 'none' }}>
                    <td style={{ padding: '12px 16px', color: '#2C3E2D' }}>{e.firstName ? `${e.firstName} ${e.lastName || ''}`.trim() : '—'}</td>
                    <td style={{ padding: '12px 16px', color: '#2C3E2D' }}>{e.email}</td>
                    <td style={{ padding: '12px 16px' }}>
                      {e.role ? (
                        <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: e.role === 'chw' ? 'rgba(212,184,150,0.2)' : e.role === 'member' ? 'rgba(107,143,113,0.15)' : 'rgba(44,62,45,0.06)', color: e.role === 'chw' ? '#8B6F47' : e.role === 'member' ? '#6B8F71' : '#6B7B6D' }}>{e.role}</span>
                      ) : '—'}
                    </td>
                    <td style={{ padding: '12px 16px', color: '#6B7B6D', fontSize: 13 }}>{new Date(e.submittedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
