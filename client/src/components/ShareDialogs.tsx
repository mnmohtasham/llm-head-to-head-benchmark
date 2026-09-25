import { checkShareEndpoint, shortDate, type DeviceRun, type ShareRecord } from '@duel/shared';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, api, messageOf, type SentShare, type ShareSettingsView } from '../api';

function Dialog({
  title,
  onClose,
  busy,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  busy: boolean;
  children: (close: () => void, titleId: string) => ReactNode;
  testId: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog dialog-wide"
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      data-testid={testId}
    >
      <div className="dialog-body">
        <h2 id={`${id}-title`} className="dialog-title">
          {title}
        </h2>
        {children(() => ref.current?.close(), `${id}-title`)}
      </div>
    </dialog>
  );
}

/** Where records go: the service's address, an optional token, and this sender's key. */
export function ShareSettingsDialog({
  settings,
  onSaved,
  onClose,
}: {
  settings: ShareSettingsView;
  onSaved: (settings: ShareSettingsView) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [endpoint, setEndpoint] = useState(settings.endpoint ?? '');
  const [token, setToken] = useState('');
  const [removeToken, setRemoveToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const checked = endpoint.trim() ? checkShareEndpoint(endpoint) : null;

  const save = async (event: FormEvent, close: () => void, clear = false) => {
    event.preventDefault();
    setError(null);
    if (!clear && checked && !checked.ok) return;
    setBusy(true);
    try {
      const saved = await api.updateShareSettings(
        clear
          ? { endpoint: null }
          : {
              endpoint: endpoint.trim() || null,
              ...(removeToken ? { token: null } : token.trim() ? { token: token.trim() } : {}),
            },
      );
      onSaved(saved);
      close();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : messageOf(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Results service" onClose={onClose} busy={busy} testId="share-settings">
      {(close) => (
        <form onSubmit={(event) => void save(event, close)} noValidate>
          <p className="field-hint">
            <b>Send</b> on a row sends that run to this service, after showing you exactly what
            goes. Only runs you send leave this computer.
          </p>
          <div className="field">
            <label htmlFor={`${id}-endpoint`}>Service address</label>
            <input
              id={`${id}-endpoint`}
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://results.example.com/api/runs"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              aria-invalid={Boolean(checked && !checked.ok)}
            />
            <p className={checked && !checked.ok ? 'field-error' : 'field-hint'}>
              {checked && !checked.ok
                ? checked.error
                : 'The full address that takes records, over https. Model Duel sends each record there with a POST.'}
            </p>
          </div>
          <div className="field">
            <label htmlFor={`${id}-token`}>Token (optional)</label>
            <input
              id={`${id}-token`}
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              disabled={removeToken}
              placeholder={
                settings.hasToken
                  ? `Leave empty to keep ${settings.tokenMasked ?? 'the saved token'}`
                  : 'Only if the service gave you one'
              }
              autoComplete="off"
              spellCheck={false}
            />
            <p className="field-hint">
              Sent as a bearer token to this address only. It is kept on this computer and never
              shown again.
            </p>
            {settings.hasToken ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={removeToken}
                  onChange={(event) => setRemoveToken(event.target.checked)}
                />
                Remove the saved token
              </label>
            ) : null}
          </div>
          <div className="field">
            <span className="field-label">Your sender key</span>
            <p className="field-hint">
              Every record is signed with a key made on this computer, fingerprint{' '}
              <code data-testid="share-fingerprint">{settings.fingerprint}</code>. The service can
              use it to check a record was not changed on the way and to let only you replace your
              records. The private half never leaves this computer.
            </p>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            {settings.endpoint ? (
              <button
                type="button"
                className="btn btn-quiet btn-danger"
                onClick={(event) => void save(event, close, true)}
                disabled={busy}
              >
                Remove address
              </button>
            ) : null}
            <button type="button" className="btn btn-quiet" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

const NEVER_SENT = [
  'API keys and tokens',
  'machine names, addresses and notes',
  'answers and thinking',
  'file names and paths',
  'your prompt, unless you tick the box',
];

/** Shows the record exactly as it would go, and sends it only when asked. */
export function ShareDialog({
  run,
  settings,
  onSent,
  onSettings,
  onClose,
}: {
  run: DeviceRun;
  settings: ShareSettingsView;
  onSent: (key: string, sent: SentShare) => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const [displayName, setDisplayName] = useState('');
  const [includePrompt, setIncludePrompt] = useState(false);
  const [preview, setPreview] = useState<{ record: ShareRecord; sha256: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SentShare | null>(null);
  const earlier = settings.sent[run.key];
  const host = settings.endpoint ? new URL(settings.endpoint).host : null;
  const custom = run.prompt?.startsWith('Custom') ?? false;

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    const timer = setTimeout(() => {
      api
        .sharePreview({
          sessionId: run.sessionId,
          machineId: run.machineId,
          options: { displayName, includePrompt },
        })
        .then(
          (shown) => {
            if (!cancelled) {
              setPreview({ record: shown.record, sha256: shown.sha256 });
              setError(null);
            }
          },
          (failure: unknown) => {
            if (!cancelled) setError(messageOf(failure));
          },
        );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [run.sessionId, run.machineId, displayName, includePrompt]);

  const send = async () => {
    if (!preview) return;
    setSending(true);
    setError(null);
    try {
      const answer = await api.shareSend({
        sessionId: run.sessionId,
        machineId: run.machineId,
        options: { displayName, includePrompt },
        sha256: preview.sha256,
      });
      setSent(answer);
      onSent(run.key, answer);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog
      title={sent ? 'Sent' : 'Send this run'}
      onClose={onClose}
      busy={sending}
      testId="share-dialog"
    >
      {(close) =>
        sent ? (
          <>
            <p role="status" data-testid="share-sent">
              {host} took the record{sent.message ? `: ${sent.message}` : '.'}
            </p>
            {sent.url ? (
              <p>
                <a href={sent.url} target="_blank" rel="noopener noreferrer">
                  Open it on {host}
                </a>
              </p>
            ) : null}
            <div className="dialog-actions">
              <button type="button" className="btn btn-primary" onClick={close}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="field-hint">
              {run.machine}, {shortDate(run.createdAt)}: {run.gpu ?? 'unknown GPU'},{' '}
              {run.model ?? 'no model'}
              {run.quant ? ` ${run.quant}` : ''}.{' '}
              {host ? (
                <>
                  It goes to <b>{host}</b>, a public service anyone can read.{' '}
                </>
              ) : null}
              <button type="button" className="btn btn-quiet btn-inline" onClick={onSettings}>
                {host ? 'Change the address' : 'Set the service address'}
              </button>
            </p>
            {earlier ? (
              <p className="field-hint" data-testid="share-earlier">
                Sent to {earlier.host} on {shortDate(earlier.at)}. Sending again replaces it there.
              </p>
            ) : null}
            <div className="field">
              <label htmlFor={`${id}-name`}>Name shown publicly (optional)</label>
              <input
                id={`${id}-name`}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={60}
                placeholder="Leave empty to show only the hardware"
                autoComplete="off"
              />
            </div>
            {custom ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={includePrompt}
                  onChange={(event) => setIncludePrompt(event.target.checked)}
                />
                Include my prompt. It may be private; leave it out unless you want it public.
              </label>
            ) : null}
            <p className="field-hint">Never sent: {NEVER_SENT.join('; ')}.</p>
            <details className="share-preview" open>
              <summary>The record, exactly as it will be sent</summary>
              <pre data-testid="share-record">
                {preview ? JSON.stringify(preview.record, null, 2) : 'Preparing…'}
              </pre>
            </details>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button type="button" className="btn btn-quiet" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void send()}
                disabled={!preview || !host || sending}
              >
                {sending ? 'Sending…' : host ? `Send to ${host}` : 'Set an address first'}
              </button>
            </div>
          </>
        )
      }
    </Dialog>
  );
}
