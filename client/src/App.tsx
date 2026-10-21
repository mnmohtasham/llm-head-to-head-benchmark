import type { MachineView } from '@duel/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, messageOf } from './api';
import type { LogEntry, NewLogEntry } from './components/LogPanel';
import type { Page } from './components/TopBar';
// Each page is fetched the first time its tab is opened.
import {
  ImagePage,
  MachinesPage,
  ModelsPage,
  ResultsPage,
  SuitesPage,
  TextPage,
  TranscribePage,
} from './LazyPages';

let nextLogId = 1;

function pageFromHash(): Page {
  if (window.location.hash === '#/models') return 'models';
  if (window.location.hash === '#/text' || window.location.hash.startsWith('#/text/'))
    return 'text';
  if (window.location.hash === '#/transcribe' || window.location.hash.startsWith('#/transcribe/'))
    return 'transcribe';
  if (window.location.hash === '#/image' || window.location.hash.startsWith('#/image/'))
    return 'image';
  if (window.location.hash === '#/suites' || window.location.hash.startsWith('#/suites/'))
    return 'suites';
  // #/results?compare=… and #/results?history=… open a comparison or a history there.
  if (window.location.hash === '#/results' || window.location.hash.startsWith('#/results?'))
    return 'results';
  return 'machines';
}

const TITLES: Record<Page, string> = {
  machines: 'Machines',
  models: 'Models',
  text: 'Text',
  transcribe: 'Transcribe',
  image: 'Image',
  suites: 'Suites',
  results: 'Results',
};

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [machines, setMachines] = useState<MachineView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    document.title = `${TITLES[page]} · Model Duel`;
  }, [page]);

  const addLog = useCallback((entry: NewLogEntry) => {
    setLog((current) => [{ ...entry, id: nextLogId++, at: new Date() }, ...current].slice(0, 100));
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.health().then(
      (health) => {
        // The dev server serves the page itself, so only a production server can be out of date.
        if (!cancelled && health.mode !== 'dev' && health.build !== __BUILD_ID__) setStale(true);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.listMachines().then(
      (list) => {
        if (!cancelled) setMachines(list);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(messageOf(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Cloud models race only on the Text tab, and the other local servers race text and have their
  // own Models panes; the other tabs need a machine running Unsloth.
  const unsloth = useMemo(
    () => machines?.filter((m) => !m.cloud && m.server === 'unsloth') ?? null,
    [machines],
  );
  const others = useMemo(
    () => machines?.filter((m) => !m.cloud && m.server !== 'unsloth') ?? [],
    [machines],
  );

  return (
    <div className="app">
      {stale ? (
        <div className="banner banner-error" role="alert" data-testid="stale-server">
          This page and the running Model Duel server come from different builds, so some requests
          fail. Reload the page. If this message stays, stop the server and start it again with{' '}
          <code>npm start</code>.
        </div>
      ) : null}
      {page === 'text' ? (
        <TextPage machines={machines} loadError={loadError} log={log} addLog={addLog} />
      ) : page === 'transcribe' ? (
        <TranscribePage machines={unsloth} loadError={loadError} log={log} addLog={addLog} />
      ) : page === 'image' ? (
        <ImagePage machines={unsloth} loadError={loadError} log={log} addLog={addLog} />
      ) : page === 'suites' ? (
        <SuitesPage machines={machines} loadError={loadError} />
      ) : page === 'results' ? (
        <ResultsPage />
      ) : page === 'models' ? (
        <ModelsPage
          machines={unsloth}
          others={others}
          loadError={loadError}
          log={log}
          addLog={addLog}
        />
      ) : (
        <MachinesPage
          machines={machines}
          setMachines={setMachines}
          loadError={loadError}
          log={log}
          addLog={addLog}
        />
      )}
    </div>
  );
}
