import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './features/auth/AuthContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.tsx';
import { ErrorBoundary } from './shared/components/ErrorBoundary';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found in document. Check index.html.');
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } })}>
        <AuthProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </AuthProvider>
        </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
