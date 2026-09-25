import {
  CLOUD_INFO,
  CLOUD_PROVIDERS,
  MACHINE_COLORS,
  type CloudModel,
  type CloudProvider,
  type MachineView,
} from '@duel/shared';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, messageOf } from '../api';
import { modelFacts } from './CloudCard';
import { ColorField } from './MachineDialog';

export interface CloudFormValues {
  name: string;
  baseUrl: string;
  color: string;
  /** For an edit: "" keeps the saved key. */
  apiKey: string;
  cloud: { provider: CloudProvider; model: CloudModel };
}

interface Props {
  machine: MachineView | null;
  usedColors: readonly string[];
  onSubmit: (values: CloudFormValues) => Promise<void>;
  onClose: () => void;
}

/** Adds or edits a cloud reference model: provider, key, and a model from the provider's list. */
export function CloudDialog({ machine, usedColors, onSubmit, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const saved = machine?.cloud ?? null;
  const [provider, setProvider] = useState<CloudProvider>(saved?.provider ?? 'openai');
  const [name, setName] = useState(machine?.name ?? '');
  /** Until the user types a name, it follows the model. */
  const [nameTouched, setNameTouched] = useState(machine !== null);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const info = CLOUD_INFO[provider];
  const [address, setAddress] = useState(
    machine && machine.baseUrl !== info.baseUrl ? machine.baseUrl : '',
  );
  const [models, setModels] = useState<CloudModel[] | null>(saved?.model ? [saved.model] : null);
  const [modelId, setModelId] = useState(saved?.model?.id ?? '');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [color, setColor] = useState<string>(
    machine?.color ?? MACHINE_COLORS.find((c) => !usedColors.includes(c)) ?? MACHINE_COLORS[0],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const savedKey = machine?.hasApiKey ? machine.apiKeyMasked : null;
  const model = models?.find((m) => m.id === modelId) ?? null;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const pickProvider = (next: CloudProvider) => {
    setProvider(next);
    setModels(null);
    setModelId('');
    setFetchError(null);
    if (!nameTouched) setName('');
  };

  const pickModel = (next: string) => {
    setModelId(next);
    const picked = models?.find((m) => m.id === next);
    if (picked && !nameTouched) setName(picked.label.slice(0, 60));
  };

  const fetchModels = async () => {
    setFetchError(null);
    if (!apiKey.trim() && !savedKey) {
      setErrors((current) => ({ ...current, apiKey: 'Enter the API key first.' }));
      return;
    }
    setErrors((current) => ({ ...current, apiKey: '', model: '' }));
    setFetching(true);
    try {
      const { models: list } = await api.cloudModels({
        provider,
        apiKey: apiKey.trim() || undefined,
        baseUrl: address.trim() || undefined,
        machineId: machine?.id,
      });
      setModels(list);
      if (!list.some((m) => m.id === modelId)) setModelId('');
      if (list.length === 0) setFetchError(`${info.label} offers this key no text models.`);
    } catch (error) {
      setFetchError(messageOf(error));
    } finally {
      setFetching(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const local: Record<string, string> = {};
    const finalName = name.trim() || model?.label.slice(0, 60) || info.defaultName;
    if (!machine && !apiKey.trim()) local.apiKey = 'Enter the API key.';
    if (!model) local.model = models ? 'Choose a model.' : 'Fetch the models and choose one.';
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0 || !model) return;
    setBusy(true);
    try {
      await onSubmit({
        name: finalName,
        baseUrl: address.trim() || info.baseUrl,
        color,
        apiKey: apiKey.trim(),
        cloud: { provider, model },
      });
    } catch (error) {
      if (error instanceof ApiError && Object.keys(error.fields).length > 0)
        setErrors(error.fields);
      else setFormError(messageOf(error));
      setBusy(false);
    }
  };

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
          {machine ? 'Edit cloud model' : 'Add cloud model'}
        </h2>
        <p className="field-hint">
          A cloud model races on the Text tab as a reference next to your machines. Model Duel sends
          each request with your key and the provider bills it.
        </p>

        <div className="field">
          <label htmlFor={`${id}-provider`}>Provider</label>
          <select
            id={`${id}-provider`}
            value={provider}
            onChange={(event) => pickProvider(event.target.value as CloudProvider)}
            disabled={machine !== null}
          >
            {CLOUD_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {CLOUD_INFO[p].label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor={`${id}-key`}>API key</label>
          <div className="key-input">
            <input
              id={`${id}-key`}
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={savedKey ? `Leave empty to keep ${savedKey}` : 'Paste the key'}
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
            {errors.apiKey ||
              `${info.keyHint} It is stored on this computer only, never shown again, and never written to results.`}
          </p>
        </div>

        <details className="field" open={address !== ''}>
          <summary className="field-label">API address (optional)</summary>
          <label htmlFor={`${id}-address`}>API address</label>
          <input
            id={`${id}-address`}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder={info.baseUrl}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            aria-invalid={Boolean(errors.baseUrl)}
          />
          <p className={errors.baseUrl ? 'field-error' : 'field-hint'}>
            {errors.baseUrl ||
              `Leave empty for ${info.baseUrl}. Change it only for a gateway that speaks the same API.`}
          </p>
        </details>

        <div className="field">
          <label htmlFor={`${id}-model`}>Model</label>
          <div className="fetch-row">
            <select
              id={`${id}-model`}
              value={modelId}
              onChange={(event) => pickModel(event.target.value)}
              disabled={!models || models.length === 0}
              aria-invalid={Boolean(errors.model)}
              aria-describedby={`${id}-model-note`}
            >
              <option value="">
                {models ? `Choose one of ${models.length} models` : 'Fetch the models first'}
              </option>
              {(models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label === m.id ? m.id : `${m.label} (${m.id})`}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => void fetchModels()}
              disabled={fetching}
            >
              {fetching
                ? 'Fetching…'
                : models && models.length > 1
                  ? 'Fetch again'
                  : 'Fetch models'}
            </button>
          </div>
          <p
            id={`${id}-model-note`}
            className={fetchError || errors.model ? 'field-error' : 'field-hint'}
            role={fetchError ? 'alert' : undefined}
          >
            {fetchError ||
              errors.model ||
              (model
                ? modelFacts(model).join(' · ')
                : `Model Duel asks ${info.label} for the text models this key can use.`)}
          </p>
        </div>

        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameTouched(true);
            }}
            maxLength={60}
            placeholder={model?.label ?? info.defaultName}
            autoComplete="off"
            aria-invalid={Boolean(errors.name)}
          />
          {errors.name ? <p className="field-error">{errors.name}</p> : null}
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
            {busy ? 'Saving…' : machine ? 'Save' : 'Add'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
