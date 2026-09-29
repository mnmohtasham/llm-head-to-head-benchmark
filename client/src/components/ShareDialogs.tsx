import {
  SHARE_SERVICE_ACCOUNT,
  SHARE_SERVICE_NAME,
  shortDate,
  type DeviceRun,
  type ShareRecord,
} from '@duel/shared';
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

/** LLM Bench, where runs go: the token from its account page, and this sender's key. */
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
  const [token, setToken] = useState('');
  const [removeToken, setRemoveToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const host = new URL(settings.endpoint).host;

  const save = async (event: FormEvent, close: () => void) => {
    event.preventDefault();
    setError(null);
    const typed = token.trim();
    if (!removeToken && !typed) {
      close();
      return;
    }
    setBusy(true);
    try {
      onSaved(await api.setShareToken(removeToken ? null : typed));
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
            <b>Send</b> on a row sends that run to <b>{SHARE_SERVICE_NAME}</b> ({host}), the public
            results site for Model Duel, after showing you exactly what goes. It shows runs without
            names. Only races with a standard prompt can be sent, so every result there compares
            like for like, and only runs you send leave this computer.
          </p>
          <div className="field">
            <label htmlFor={`${id}-token`}>Token</label>
            <input
              id={`${id}-token`}
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              disabled={removeToken}
              placeholder={
                settings.hasToken
                  ? `Leave empty to keep ${settings.tokenMasked ?? 'the saved token'}`
                  : `Paste the token from your ${SHARE_SERVICE_NAME} account`
              }
              autoComplete="off"
              spellCheck={false}
            />
            <p className="field-hint">
              Sign in at{' '}
              <a href={SHARE_SERVICE_ACCOUNT} target="_blank" rel="noopener noreferrer">
                {host}/account
              </a>{' '}
              with Google and make a token there. It is sent to {SHARE_SERVICE_NAME} only, kept on
              this computer, and never shown again.
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
              <code data-testid="share-fingerprint">{settings.fingerprint}</code>.{' '}
              {SHARE_SERVICE_NAME} uses it to check a record was not changed on the way and to let
              only you replace your records. The private half never leaves this computer.
            </p>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
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
  'your name',
  'your own prompts and audio: only standard ones can be sent',
  'answers and thinking',
  'file names and paths',
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
  const [preview, setPreview] = useState<{
    record: ShareRecord;
    sha256: string;
    notStandard: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SentShare | null>(null);
  const earlier = settings.sent[run.key];
  const host = new URL(settings.endpoint).host;
  // LLM Bench takes runs only with a token.
  const needsToken = !settings.hasToken;

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    api.sharePreview({ sessionId: run.sessionId, machineId: run.machineId }).then(
      (shown) => {
        if (!cancelled) {
          setPreview({
            record: shown.record,
            sha256: shown.sha256,
            notStandard: shown.notStandard,
          });
          setError(null);
        }
      },
      (failure: unknown) => {
        if (!cancelled) setError(messageOf(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [run.sessionId, run.machineId]);

  const send = async () => {
    if (!preview) return;
    setSending(true);
    setError(null);
    try {
      const answer = await api.shareSend({
        sessionId: run.sessionId,
        machineId: run.machineId,
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
              {run.quant ? ` ${run.quant}` : ''}. It goes to <b>{host}</b>, a public site anyone can
              read, which shows it without your name.{' '}
              <button type="button" className="btn btn-quiet btn-inline" onClick={onSettings}>
                {needsToken ? 'Add your token' : 'Change your token'}
              </button>
            </p>
            {preview?.notStandard ? (
              <p className="form-error" data-testid="share-not-standard">
                {preview.notStandard}
              </p>
            ) : null}
            {needsToken ? (
              <p className="field-hint" data-testid="share-needs-token">
                {SHARE_SERVICE_NAME} takes runs only with your token. Sign in at{' '}
                <a href={SHARE_SERVICE_ACCOUNT} target="_blank" rel="noopener noreferrer">
                  {host}/account
                </a>{' '}
                with Google, make a token, and add it here.
              </p>
            ) : null}
            {earlier ? (
              <p className="field-hint" data-testid="share-earlier">
                Sent to {earlier.host} on {shortDate(earlier.at)}. Sending again replaces it there.
              </p>
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
                disabled={!preview || Boolean(preview.notStandard) || needsToken || sending}
              >
                {sending
                  ? 'Sending…'
                  : preview?.notStandard
                    ? 'Not a standard prompt'
                    : needsToken
                      ? 'Add your token first'
                      : `Send to ${host}`}
              </button>
            </div>
          </>
        )
      }
    </Dialog>
  );
}
