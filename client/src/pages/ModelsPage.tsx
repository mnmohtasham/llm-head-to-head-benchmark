import {
  isActiveJob,
  type LoadJob,
  type LoadRequest,
  type MachineModelsView,
  type MachineStatusView,
  type MachineView,
} from '@duel/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, messageOf } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LoadDialog } from '../components/LoadDialog';
import { LogPanel, type LogEntry, type NewLogEntry } from '../components/LogPanel';
import { ModelPane } from '../components/ModelPane';
import { TopBar } from '../components/TopBar';
import { formatDuration } from '../format';

interface Props {
  machines: MachineView[] | null;
  loadError: string | null;
  log: LogEntry[];
  addLog: (entry: NewLogEntry) => void;
}

function describeJob(job: LoadJob): { tone: NewLogEntry['tone']; text: string } {
  const name = `${job.displayName}${job.quant ? ` ${job.quant}` : ''}`;
  const took = formatDuration(job.durationMs ?? 0);
  if (job.state === 'loaded') {
    return {
      tone: job.memoryWarning ? 'warning' : 'ok',
      text: job.alreadyLoaded
        ? `${name} was already loaded with these settings.`
        : `Loaded ${name} in ${took}.${job.memoryWarning ? ' It does not fit in memory.' : ''}`,
    };
  }
  if (job.state === 'cancelled')
    return { tone: 'info', text: `Load of ${name} cancelled after ${took}.` };
  return { tone: 'error', text: `Load of ${name} failed: ${job.error ?? 'unknown error'}` };
}

export function ModelsPage({ machines, loadError, log, addLog }: Props) {
  const [statuses, setStatuses] = useState<Record<string, MachineStatusView>>({});
  const [models, setModels] = useState<Record<string, MachineModelsView>>({});
  const [jobs, setJobs] = useState<Record<string, LoadJob>>({});
  const [clockOffset, setClockOffset] = useState(0);
  const [dialog, setDialog] = useState<{ machineIds: string[]; modelId: string | null } | null>(
    null,
  );
  const [unloading, setUnloading] = useState<MachineView | null>(null);
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(() => new Set());
  const previousJobs = useRef<Record<string, LoadJob>>({});

  const refreshStatus = useCallback(async (machineId: string) => {
    try {
      const view = await api.machineStatus(machineId);
      setStatuses((current) => ({ ...current, [machineId]: view }));
      const job = view.job;
      if (job)
        setJobs((current) =>
          current[machineId]?.id === job.id && isActiveJob(current[machineId])
            ? current
            : { ...current, [machineId]: job },
        );
    } catch (error) {
      setStatuses((current) => ({
        ...current,
        [machineId]: {
          machineId,
          status: null,
          error: messageOf(error),
          job: null,
          checkedAt: new Date().toISOString(),
        },
      }));
    }
  }, []);

  const refreshModels = useCallback(async (machineId: string, refresh = false) => {
    try {
      const view = await api.listModels(machineId, refresh);
      setModels((current) => ({ ...current, [machineId]: view }));
    } catch (error) {
      setModels((current) => ({
        ...current,
        [machineId]: { machineId, models: null, fetchedAt: null, error: messageOf(error) },
      }));
    }
  }, []);

  const machineKey = (machines ?? []).map((m) => m.id).join(',');
  useEffect(() => {
    for (const machineId of machineKey.split(',').filter(Boolean)) {
      void refreshStatus(machineId);
      void refreshModels(machineId);
    }
  }, [machineKey, refreshStatus, refreshModels]);

  // Follow running loads twice a second; the controller answers from memory.
  const anyActive = Object.values(jobs).some(isActiveJob);
  useEffect(() => {
    if (!anyActive) return;
    let stopped = false;
    const tick = async () => {
      try {
        const { jobs: list, serverTime } = await api.listLoads();
        if (stopped) return;
        setClockOffset(Date.parse(serverTime) - Date.now());
        setJobs((current) => {
          const next = { ...current };
          for (const job of list) next[job.machineId] = job;
          return next;
        });
      } catch {
        // Keep following; a missed tick is harmless.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [anyActive]);

  // When a load ends, read the machine again and say what happened.
  useEffect(() => {
    for (const [machineId, job] of Object.entries(jobs)) {
      const before = previousJobs.current[machineId];
      if (before && before.id === job.id && isActiveJob(before) && !isActiveJob(job)) {
        void refreshStatus(machineId);
        void refreshModels(machineId);
        const machine = machines?.find((m) => m.id === machineId);
        addLog({
          machineName: machine?.name ?? null,
          color: machine?.color ?? null,
          ...describeJob(job),
        });
      }
    }
    previousJobs.current = jobs;
  }, [jobs, machines, addLog, refreshStatus, refreshModels]);

  const startLoad = async (request: LoadRequest) => {
    const { results } = await api.startLoad(request);
    setJobs((current) => {
      const next = { ...current };
      for (const result of results) if (result.job) next[result.machineId] = result.job;
      return next;
    });
    for (const result of results) {
      const machine = machines?.find((m) => m.id === result.machineId);
      const job = result.job;
      addLog({
        machineName: machine?.name ?? null,
        color: machine?.color ?? null,
        tone: result.started ? 'info' : 'warning',
        text: job
          ? `Loading ${job.displayName}${job.quant ? ` ${job.quant}` : ''}.`
          : `Skipped. ${result.reason ?? ''}`,
      });
    }
    setDialog(null);
  };

  const cancel = async (machine: MachineView) => {
    try {
      const { job } = await api.cancelLoad(machine.id);
      setJobs((current) => ({ ...current, [machine.id]: job }));
    } catch (error) {
      addLog({
        machineName: machine.name,
        color: machine.color,
        tone: 'error',
        text: messageOf(error),
      });
    }
  };

  const unload = async () => {
    if (!unloading) return;
    const view = await api.unload(unloading.id);
    setStatuses((current) => ({ ...current, [unloading.id]: view }));
    void refreshModels(unloading.id);
    addLog({
      machineName: unloading.name,
      color: unloading.color,
      tone: 'info',
      text: 'Model unloaded.',
    });
    setUnloading(null);
  };

  const refresh = async (machine: MachineView) => {
    setRefreshing((current) => new Set(current).add(machine.id));
    await Promise.all([refreshStatus(machine.id), refreshModels(machine.id, true)]);
    setRefreshing((current) => {
      const next = new Set(current);
      next.delete(machine.id);
      return next;
    });
  };

  const busyMachineIds = new Set(
    Object.values(jobs)
      .filter(isActiveJob)
      .map((job) => job.machineId),
  );

  return (
    <>
      <TopBar
        title="Models"
        current="models"
        actions={
          machines && machines.length > 0 ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setDialog({ machineIds: machines.map((m) => m.id), modelId: null })}
            >
              Load on all machines
            </button>
          ) : null
        }
      />

      <main className="main">
        <p className="subbar">
          Load the same model on every machine, or on one at a time. Only models and quants already
          on a machine are offered, so nothing is ever downloaded.
        </p>

        {loadError ? (
          <div className="banner banner-error" role="alert">
            {loadError}
          </div>
        ) : null}
        {machines === null && !loadError ? <p className="loading">Loading machines…</p> : null}
        {machines && machines.length === 0 ? (
          <section className="empty" aria-labelledby="models-empty-title">
            <h2 id="models-empty-title" className="section-title">
              No machines yet
            </h2>
            <p className="muted">
              Add your machines on the <a href="#/machines">Machines</a> screen first.
            </p>
          </section>
        ) : null}
        {machines && machines.length > 0 ? (
          <div className="machine-grid">
            {machines.map((machine) => (
              <ModelPane
                key={machine.id}
                machine={machine}
                statusView={statuses[machine.id] ?? null}
                modelsView={models[machine.id] ?? null}
                job={jobs[machine.id] ?? null}
                clockOffset={clockOffset}
                refreshing={refreshing.has(machine.id)}
                onLoad={(modelId) =>
                  setDialog({ machineIds: [machine.id], modelId: modelId ?? null })
                }
                onCancel={() => void cancel(machine)}
                onUnload={() => setUnloading(machine)}
                onRefresh={() => void refresh(machine)}
              />
            ))}
          </div>
        ) : null}

        <LogPanel machines={machines ?? []} entries={log} />
      </main>

      {dialog && machines ? (
        <LoadDialog
          machines={machines}
          models={models}
          initialMachineIds={dialog.machineIds}
          initialModelId={dialog.modelId}
          busyMachineIds={busyMachineIds}
          onSubmit={startLoad}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {unloading ? (
        <ConfirmDialog
          title="Unload model"
          message={`Unload ${statuses[unloading.id]?.status?.activeModel ?? 'the model'} from ${unloading.name}? This frees its memory. Loading it again takes time.`}
          confirmLabel="Unload"
          onConfirm={unload}
          onClose={() => setUnloading(null)}
        />
      ) : null}
    </>
  );
}
