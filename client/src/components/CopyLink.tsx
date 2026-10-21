import { useState } from 'react';

/**
 * Copies the full address of a hash link. Browsers keep the clipboard to https and this
 * computer's own address, so elsewhere the link shows, selected, to copy by hand.
 */
export function CopyLink({ href, what }: { href: string; what: string }) {
  const url = `${window.location.origin}${window.location.pathname}${href}`;
  const [done, setDone] = useState<{ url: string; copied: boolean } | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setDone({ url, copied: true });
    } catch {
      setDone({ url, copied: false });
    }
  };
  // A link copied for another comparison says nothing about this one.
  const shown = done?.url === url ? done : null;
  return (
    <span className="copy-link">
      <button type="button" className="btn btn-outline btn-small" onClick={() => void copy()}>
        {shown?.copied ? 'Link copied ✓' : 'Copy link'}
      </button>
      {shown && !shown.copied ? (
        <input
          className="copy-link-text"
          readOnly
          value={url}
          aria-label={`Link to this ${what}, to copy`}
          onFocus={(event) => event.target.select()}
          autoFocus
        />
      ) : null}
      <span className="sr-only" role="status">
        {shown?.copied ? 'Link copied' : ''}
      </span>
    </span>
  );
}
