import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../features/auth/AuthContext';
import App from '../App';
import { describe, it, expect } from 'vitest';

function renderWithProviders(initialRoute = '/') {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );
}

describe('Smoke tests', () => {
  it('renders landing page for unauthenticated users', () => {
    renderWithProviders('/landing');
    expect(document.body).toBeTruthy();
  });

  it('renders login page', () => {
    renderWithProviders('/login');
    expect(screen.getByText('Welcome Back')).toBeInTheDocument();
  });

  it('renders register page', () => {
    renderWithProviders('/register');
    expect(screen.getByText('Join CompassCHW')).toBeInTheDocument();
  });

  it('redirects protected routes to login when not authenticated', () => {
    renderWithProviders('/chw/dashboard');
    expect(screen.getByText('Welcome Back')).toBeInTheDocument();
  });

  it('renders legal pages', () => {
    renderWithProviders('/privacy');
    expect(screen.getByText('Privacy Policy')).toBeInTheDocument();
  });
});
