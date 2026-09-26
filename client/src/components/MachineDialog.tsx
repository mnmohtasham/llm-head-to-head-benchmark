import {
  LMSTUDIO_PORT,
  MACHINE_COLOR_NAMES,
  MACHINE_COLORS,
  normalizeBaseUrl,
  SERVER_LABEL,
  type MachineServer,
  type MachineView,
} from '@duel/shared';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api';

export interface MachineFormValues {
  name: string;
  baseUrl: string;
  notes: string;
  color: string;
  /** For an edit: "" keeps the saved key and null removes it. */
  apiKey: string | null;
  /** The Model Duel agent's address; "" for none. */
  agentUrl: string;
  /** As for the key: "" keeps the saved token and null removes it. */
  agentToken: string | null;
  /** The server the machine runs; fixed once the machine is added. */
  server: MachineServer;
}

interface Props {
  machine: MachineView | null;
  usedColors: readonly string[];
  onSubmit: (values: MachineFormValues) => Promise<void>;
  onClose: () => void;
}

export function MachineDialog({ machine, usedColors, onSubmit, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const savedKey = machine?.hasApiKey ? machine.apiKeyMasked : null;
  const [server, setServer] = useState<MachineServer>(machine?.server ?? 'unsloth');
  const lm = server === 'lmstudio';
  const [name, setName] = useState(machine?.name ?? '');
  const [address, setAddress] = useState(machine?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [removeKey, setRemoveKey] = useState(false);
  const [notes, setNotes] = useState(machine?.notes ?? '');
  const savedToken = machine?.hasAgentToken ? machine.agentTokenMasked : null;
  const [agentUrl, setAgentUrl] = useState(machine?.agentUrl ?? '');
  const [agentToken, setAgentToken] = useState('');
  const [removeToken, setRemoveToken] = useState(false);
  const [color, setColor] = useState<string>(
    machine?.color ?? MACHINE_COLORS.find((c) => !usedColors.includes(c)) ?? MACHINE_COLORS[0],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const preview = address.trim() ? normalizeBaseUrl(address, lm ? LMSTUDIO_PORT : undefined) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const local: Record<string, string> = {};
    if (!name.trim()) local.name = 'Give the machine a name.';
    if (!address.trim()) local.baseUrl = 'Enter the machine address.';
    else if (preview && !preview.ok) local.baseUrl = preview.error;
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0) return;
    setBusy(true);
    try {
      await onSubmit({
        name,
        baseUrl: address,
        notes,
        color,
        apiKey: machine && removeKey ? null : apiKey,
        agentUrl: lm ? '' : agentUrl,
        agentToken: machine && removeToken ? null : lm ? '' : agentToken,
        server,
      });
    } catch (error) {
      if (error instanceof ApiError && Object.keys(error.fields).length > 0)
        setErrors(error.fields);
      else setFormError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  const addressHint = errors.baseUrl ? null : preview?.ok ? (
    <>
      Will connect to <code>{preview.url}</code>
    </>
  ) : preview ? null : lm ? (
    'The IP address or name of the machine. Port 1234, LM Studio’s, is added when you leave it out.'
  ) : (
    'The IP address or name of the machine. Port 8888 is added when you leave it out.'
  );
  const addressError = errors.baseUrl ?? (preview && !preview.ok ? preview.error : null);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <form onSubmit={(event) => void submit(event)} noValidate>
        <h2 id={`${id}-title`} className="dialog-title">
          {machine ? 'Edit machine' : 'Add machine'}
        </h2>

        <div className="field">
          <span className="field-label" id={`${id}-server-label`}>
            Server
          </span>
          {machine ? (
            <p className="field-hint">
              {SERVER_LABEL[server]}. Add another machine to use the other.
            </p>
          ) : (
            <div className="toggle-chips" role="radiogroup" aria-labelledby={`${id}-server-label`}>
              {(['unsloth', 'lmstudio'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={server === option}
                  className={`toggle-chip${server === option ? ' toggle-chip-on' : ''}`}
                  onClick={() => setServer(option)}
                >
                  {SERVER_LABEL[option]}
                </button>
              ))}
            </div>
          )}
          {lm && !machine ? (
            <p className="field-hint">
              LM Studio races text only. In LM Studio, turn on Serve on Local Network (Developer →
              Server Settings) so this computer can reach it.
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            placeholder="M3 Ultra 512GB"
            autoComplete="off"
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? `${id}-name-error` : undefined}
            autoFocus
          />
          {errors.name ? (
            <p id={`${id}-name-error`} className="field-error">
              {errors.name}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor={`${id}-address`}>Address</label>
          <input
            id={`${id}-address`}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="192.168.1.10"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            aria-invalid={Boolean(addressError)}
            aria-describedby={`${id}-address-note`}
          />
          <p id={`${id}-address-note`} className={addressError ? 'field-error' : 'field-hint'}>
            {addressError ?? addressHint}
          </p>
        </div>

        <div className="field">
          <label htmlFor={`${id}-key`}>{lm ? 'API token (optional)' : 'API key'}</label>
          <div className="key-input">
            <input
              id={`${id}-key`}
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={removeKey}
              placeholder={
                savedKey
                  ? `Leave empty to keep ${savedKey}`
                  : lm
                    ? 'Only if LM Studio requires one'
                    : 'sk-unsloth-…'
              }
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(errors.apiKey)}
              aria-describedby={`${id}-key-note`}
            />
            <button
              type="button"
              className="btn btn-quiet btn-small"
              onClick={() => setShowKey((shown) => !shown)}
              aria-pressed={showKey}
            >
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <p id={`${id}-key-note`} className={errors.apiKey ? 'field-error' : 'field-hint'}>
            {errors.apiKey ??
              (lm
                ? 'Needed only when Require Authentication is on in LM Studio; create one under Developer → Server Settings → Manage Tokens. It is stored on this computer only and never shown again.'
                : 'Create one in Unsloth on that machine under Settings → API. It is stored on this computer only and never shown again.')}
          </p>
          {savedKey ? (
            <label className="check">
              <input
                type="checkbox"
                checked={removeKey}
                onChange={(event) => setRemoveKey(event.target.checked)}
              />
              Remove the saved key
            </label>
          ) : null}
        </div>

        {lm ? null : (
          <details className="field" open={Boolean(machine?.agentUrl)}>
            <summary className="field-label">Agent, for the Command tab (optional)</summary>
            <label htmlFor={`${id}-agent`}>Agent address</label>
            <input
              id={`${id}-agent`}
              value={agentUrl}
              onChange={(event) => setAgentUrl(event.target.value)}
              placeholder="192.168.1.10:8765"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(errors.agentUrl)}
            />
            <label htmlFor={`${id}-agent-token`}>Agent token</label>
            <input
              id={`${id}-agent-token`}
              type="password"
              value={agentToken}
              onChange={(event) => setAgentToken(event.target.value)}
              disabled={removeToken}
              placeholder={
                savedToken ? `Leave empty to keep ${savedToken}` : 'The token the agent printed'
              }
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(errors.agentToken)}
            />
            <p className={errors.agentUrl || errors.agentToken ? 'field-error' : 'field-hint'}>
              {errors.agentUrl ??
                errors.agentToken ??
                'Start the agent on that machine with npm run agent -- --host 0.0.0.0. It prints its token. Without an agent the Command tab skips this machine.'}
            </p>
            {savedToken ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={removeToken}
                  onChange={(event) => setRemoveToken(event.target.checked)}
                />
                Remove the saved token
              </label>
            ) : null}
          </details>
        )}

        <div className="field">
          <label htmlFor={`${id}-notes`}>Notes</label>
          <textarea
            id={`${id}-notes`}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Mac Studio, 512 GB, macOS 15.6"
            aria-invalid={Boolean(errors.notes)}
          />
          {errors.notes ? <p className="field-error">{errors.notes}</p> : null}
        </div>

        <ColorField name={`${id}-color`} color={color} onChange={setColor} />

        {formError ? (
          <p className="form-error" role="alert">
            {formError}
          </p>
        ) : null}

        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : machine ? 'Save' : 'Add and probe'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** The colour a machine gets in charts and panes. */
export function ColorField({
  name,
  color,
  onChange,
}: {
  name: string;
  color: string;
  onChange: (color: string) => void;
}) {
  return (
    <fieldset className="field">
      <legend>Colour</legend>
      <div className="swatches">
        {MACHINE_COLORS.map((swatch) => (
          <label key={swatch} className="swatch" title={MACHINE_COLOR_NAMES[swatch]}>
            <input
              type="radio"
              name={name}
              value={swatch}
              checked={color === swatch}
              onChange={() => onChange(swatch)}
            />
            <span className="swatch-fill" style={{ background: swatch }} aria-hidden="true" />
            <span className="sr-only">{MACHINE_COLOR_NAMES[swatch]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
