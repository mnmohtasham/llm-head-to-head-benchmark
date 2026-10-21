import type { TelemetrySample, TelemetryStatus, TelemetryStreamMessage } from '@duel/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

export interface TelemetryView {
  /** Null until the server has said. */
  enabled: boolean | null;
  statuses: Record<string, TelemetryStatus>;
  latest: Record<string, TelemetrySample>;
}

const EMPTY: TelemetryView = { enabled: null, statuses: {}, latest: {} };

/** Live readings for these machines, for as long as the component shows them. */
export function useTelemetry(machineIds: readonly string[]) {
  const key = [...new Set(machineIds)].sort().join(',');
  const [view, setView] = useState<TelemetryView>(EMPTY);

  // The switch's state, even with no machine to stream: the stream says it only for its machines.
  useEffect(() => {
    let cancelled = false;
    api.settings().then(
      ({ telemetry }) => {
        if (!cancelled) {
          setView((current) =>
            current.enabled === null ? { ...current, enabled: telemetry } : current,
          );
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!key) return;
    const source = new EventSource(api.telemetryStreamUrl(key.split(',')));
    source.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as TelemetryStreamMessage;
      if (message.type === 'status') {
        setView((current) => ({
          enabled: message.enabled,
          statuses: Object.fromEntries(message.statuses.map((s) => [s.machineId, s])),
          latest: {
            ...current.latest,
            ...Object.fromEntries(
              message.statuses
                .filter((s) => s.latest !== null)
                .map((s) => [s.machineId, s.latest as TelemetrySample]),
            ),
          },
        }));
      } else {
        setView((current) => ({
          ...current,
          latest: { ...current.latest, [message.machineId]: message.sample },
        }));
      }
    };
    return () => source.close();
  }, [key]);

  /** What the server answered when the switch was turned. */
  const setEnabled = useCallback(
    (enabled: boolean) => setView((current) => ({ ...current, enabled })),
    [],
  );
  return { ...view, setEnabled };
}
