import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          background: '#FBF7F0',
          fontFamily: 'Outfit, Inter, system-ui, sans-serif',
        }}>
          <div style={{
            background: 'white',
            borderRadius: '20px',
            padding: '3rem',
            maxWidth: '400px',
            textAlign: 'center',
            boxShadow: '0 4px 24px rgba(44,62,45,0.08)',
          }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>&#x26A0;&#xFE0F;</div>
            <h1 style={{ fontSize: '20px', fontWeight: 700, color: '#2C3E2D', marginBottom: '8px' }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: '14px', color: '#777', marginBottom: '24px', lineHeight: 1.5 }}>
              We hit an unexpected error. Please try refreshing the page.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: '#2C3E2D',
                color: 'white',
                border: 'none',
                borderRadius: '12px',
                padding: '10px 24px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Refresh Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
