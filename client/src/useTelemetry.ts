import type { TelemetrySample, TelemetryStatus, TelemetryStreamMessage } from '@duel/shared';
import { useEffect, useState } from 'react';
import { api } from './api';

export interface TelemetryView {
  /** Null until the server has said. */
  enabled: boolean | null;
  statuses: Record<string, TelemetryStatus>;
  latest: Record<string, TelemetrySample>;
}

const EMPTY: TelemetryView = { enabled: null, statuses: {}, latest: {} };

/** Live readings for these machines, for as long as the component shows them. */
export function useTelemetry(machineIds: readonly string[]): TelemetryView {
  const key = [...new Set(machineIds)].sort().join(',');
  const [view, setView] = useState<TelemetryView>(EMPTY);
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
  return view;
}
