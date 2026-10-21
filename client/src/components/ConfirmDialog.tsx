import { useId, useRef, useState } from 'react';
import { useModal } from '../useModal';

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useModal(ref);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className="dialog dialog-small"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-message`}
      onClose={onClose}
      onCancel={(event) => {
        // Escape waits for the answer, so an error still has somewhere to show.
        if (busy) event.preventDefault();
      }}
    >
      <div className="dialog-body">
        <h2 id={`${id}-title`} className="dialog-title">
          {title}
        </h2>
        <p id={`${id}-message`}>{message}</p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => ref.current?.close()}
            disabled={busy}
            autoFocus
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger-solid"
            onClick={() => void confirm()}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
