import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { TopBar, type Page } from './components/TopBar';

/** Shows what went wrong instead of an empty window when a tab cannot draw. */
class PageError extends Component<
  { children: ReactNode; fallback: (error: Error) => ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

/**
 * A tab whose code is fetched the first time it is opened, so the first page does not wait for
 * every other one. Its top bar shows while the code loads; a tab whose code cannot load, for
 * example after the server was updated under an open page, says so.
 */
function lazyPage<P extends object>(
  page: Page,
  title: string,
  load: () => Promise<ComponentType<P>>,
): ComponentType<P> {
  const Loaded = lazy(async () => ({ default: await load() }));
  const frame = (body: ReactNode) => (
    <>
      <TopBar title={title} current={page} />
      <main className="main">{body}</main>
    </>
  );
  return function LazyPage(props: P) {
    return (
      <PageError
        fallback={(error) =>
          frame(
            <div className="banner banner-error" role="alert" data-testid="page-error">
              This page could not be shown: {error.message} Reload the page to try again.
            </div>,
          )
        }
      >
        <Suspense fallback={frame(<p className="loading">Loading…</p>)}>
          <Loaded {...props} />
        </Suspense>
      </PageError>
    );
  };
}

export const MachinesPage = lazyPage('machines', 'Machines', () =>
  import('./pages/MachinesPage').then((m) => m.MachinesPage),
);
export const ModelsPage = lazyPage('models', 'Models', () =>
  import('./pages/ModelsPage').then((m) => m.ModelsPage),
);
export const TextPage = lazyPage('text', 'Text', () =>
  import('./pages/TextPage').then((m) => m.TextPage),
);
export const TranscribePage = lazyPage('transcribe', 'Transcribe', () =>
  import('./pages/TranscribePage').then((m) => m.TranscribePage),
);
export const ImagePage = lazyPage('image', 'Image', () =>
  import('./pages/ImagePage').then((m) => m.ImagePage),
);
export const SuitesPage = lazyPage('suites', 'Suites', () =>
  import('./pages/SuitesPage').then((m) => m.SuitesPage),
);
export const ResultsPage = lazyPage('results', 'Results', () =>
  import('./pages/ResultsPage').then((m) => m.ResultsPage),
);
