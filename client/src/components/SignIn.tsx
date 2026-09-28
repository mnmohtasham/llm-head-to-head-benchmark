import { useEffect, useState, type FormEvent } from 'react';
import { api, messageOf } from '../api';

/** The form a password-protected Model Duel shows before anything else. */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Sign in · Model Duel';
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSignedIn();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <form className="signin-card" onSubmit={(event) => void submit(event)}>
        <h1 className="dialog-title">Model Duel</h1>
        <p className="signin-note">This Model Duel is protected with a password.</p>
        <div className="field">
          <label htmlFor="signin-password">Password</label>
          <input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button className="btn btn-primary" type="submit" disabled={busy || password === ''}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </main>
  );
}
