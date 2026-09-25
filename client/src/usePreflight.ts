import {
  hasErrors,
  hasWarnings,
  type PreflightIssue,
  type PreflightRequest,
  type PreflightResult,
} from '@duel/shared';
import { useEffect, useRef, useState } from 'react';
import { api, messageOf } from './api';

/**
 * Pre-flight runs on the machines themselves, a moment after the form stops changing. The request
 * is passed as its JSON text, which is also the key that tells a stale answer from the current one.
 */
export function usePreflight(requestKey: string | null, paused: boolean) {
  const [preflight, setPreflight] = useState<{
    key: string;
    result: PreflightResult | null;
    error: string | null;
  } | null>(null);
  const [raceAnyway, setRaceAnyway] = useState(false);
  /** Bumped to run pre-flight again for the same request, after the machines changed. */
  const [round, setRound] = useState(0);
  const ticketRef = useRef(0);

  useEffect(() => {
    if (!requestKey || paused) return;
    const request = JSON.parse(requestKey) as PreflightRequest;
    if (request.machineIds.length === 0) return;
    const ticket = ++ticketRef.current;
    const timer = setTimeout(() => {
      api.preflight(request).then(
        (result) => {
          if (ticket === ticketRef.current) setPreflight({ key: requestKey, result, error: null });
        },
        (error: unknown) => {
          if (ticket === ticketRef.current) {
            setPreflight({ key: requestKey, result: null, error: messageOf(error) });
          }
        },
      );
    }, 350);
    return () => clearTimeout(timer);
  }, [requestKey, paused, round]);

  const current = preflight && preflight.key === requestKey ? preflight : null;
  const issues: PreflightIssue[] = current?.result?.issues ?? [];
  return {
    current,
    issues,
    errors: issues.filter((issue) => issue.level === 'error'),
    warnings: issues.filter((issue) => issue.level === 'warning'),
    notes: issues.filter((issue) => issue.level === 'note'),
    /** Nothing checked yet, an error, or warnings the user has not accepted. */
    stops:
      current === null ||
      current.result === null ||
      hasErrors(issues) ||
      (hasWarnings(issues) && !raceAnyway),
    raceAnyway,
    setRaceAnyway,
    recheck: () => setRound((n) => n + 1),
    /** Shows what the server's own pre-flight found when it refused to start. */
    showIssues: (found: PreflightIssue[]) => {
      if (!requestKey) return;
      setPreflight({
        key: requestKey,
        result: {
          checkedAt: new Date().toISOString(),
          issues: found,
          promptTokens: current?.result?.promptTokens ?? {},
          promptWords: current?.result?.promptWords ?? 0,
          audio: current?.result?.audio ?? null,
        },
        error: null,
      });
    },
  };
}
