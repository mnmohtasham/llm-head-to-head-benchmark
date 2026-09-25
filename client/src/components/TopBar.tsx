import type { ReactNode } from 'react';

export type Page = 'machines' | 'models' | 'text' | 'transcribe' | 'image';

const TABS: ReadonlyArray<{ page: Page; label: string }> = [
  { page: 'machines', label: 'Machines' },
  { page: 'models', label: 'Models' },
  { page: 'text', label: 'Text' },
  { page: 'transcribe', label: 'Transcribe' },
  { page: 'image', label: 'Image' },
];

export function TopBar({
  title,
  current,
  actions,
}: {
  title: string;
  current: Page;
  actions?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-bar" aria-hidden="true" />
        <h1>{title}</h1>
      </div>
      <div className="topbar-right">
        <nav className="tabs" aria-label="Pages">
          {TABS.map((tab) => (
            <a
              key={tab.page}
              href={`#/${tab.page}`}
              className={`tab${tab.page === current ? ' tab-current' : ''}`}
              aria-current={tab.page === current ? 'page' : undefined}
            >
              {tab.label}
            </a>
          ))}
        </nav>
        {actions ? <div className="topbar-actions">{actions}</div> : null}
      </div>
    </header>
  );
}
