import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, SIGNED_OUT_EVENT } from './api';
import { SignIn } from './components/SignIn';

interface AuthView {
  /** The server asks for a password, so the page offers to sign out. */
  required: boolean;
  signOut: () => void;
}

const AuthContext = createContext<AuthView>({ required: false, signOut: () => undefined });

export const useAuth = () => useContext(AuthContext);

/**
 * Shows the sign-in form when the server asks for a password, and again whenever a request comes
 * back unauthorized, for example after the password changed. Otherwise shows the app.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'open' | 'signed-in' | 'signed-out'>('checking');

  useEffect(() => {
    let cancelled = false;
    api.auth().then(
      (auth) => {
        if (!cancelled)
          setState(!auth.required ? 'open' : auth.signedIn ? 'signed-in' : 'signed-out');
      },
      // A server that is down or older than the password shows its own errors in the app.
      () => {
        if (!cancelled) setState('open');
      },
    );
    const onSignedOut = () => setState('signed-out');
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => {
      cancelled = true;
      window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
    };
  }, []);

  if (state === 'checking') return null;
  if (state === 'signed-out') return <SignIn onSignedIn={() => window.location.reload()} />;
  const view: AuthView = {
    required: state === 'signed-in',
    signOut: () => {
      void api.logout().finally(() => window.location.reload());
    },
  };
  return <AuthContext.Provider value={view}>{children}</AuthContext.Provider>;
}
