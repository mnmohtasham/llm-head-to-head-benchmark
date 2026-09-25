import { formatMs, type MachineView, type ProbeReport } from '@duel/shared';
import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { api, messageOf } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LogPanel, type LogEntry, type NewLogEntry } from '../components/LogPanel';
import { CloudCard } from '../components/CloudCard';
import { CloudDialog, type CloudFormValues } from '../components/CloudDialog';
import { MachineCard } from '../components/MachineCard';
import { MachineDialog, type MachineFormValues } from '../components/MachineDialog';
import { TelemetrySwitch } from '../components/TelemetryChips';
import { TopBar } from '../components/TopBar';
import { useNow } from '../useNow';
import { useTelemetry } from '../useTelemetry';

type DialogState =
  { mode: 'add' } | { mode: 'add-cloud' } | { mode: 'edit'; machine: MachineView } | null;

function describeProbe(report: ProbeReport): string {
  if (report.overall === 'ok') {
    return report.rtt.medianMs !== null ? `Ready, RTT ${formatMs(report.rtt.medianMs)}.` : 'Ready.';
  }
  const first =
    report.issues.find((issue) => issue.severity === 'error') ??
    report.issues.find((issue) => issue.severity === 'warning');
  return first ? first.title : 'Probed.';
}

interface Props {
  machines: MachineView[] | null;
  setMachines: Dispatch<SetStateAction<MachineView[] | null>>;
  loadError: string | null;
  log: LogEntry[];
  addLog: (entry: NewLogEntry) => void;
}

export function MachinesPage({ machines, setMachines, loadError, log, addLog }: Props) {
  const [probing, setProbing] = useState<ReadonlySet<string>>(() => new Set());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleting, setDeleting] = useState<MachineView | null>(null);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const now = useNow();
  const local = (machines ?? []).filter((m) => !m.cloud);
  const telemetry = useTelemetry(local.map((m) => m.id));

  const probe = useCallback(
    async (machine: MachineView) => {
      setProbing((current) => new Set(current).add(machine.id));
      try {
        const summary = await api.probeMachine(machine.id);
        setMachines(
          (list) =>
            list?.map((m) => (m.id === machine.id ? { ...m, lastProbe: summary } : m)) ?? null,
        );
        addLog({
          machineName: machine.name,
          color: machine.color,
          tone: summary.report.overall,
          text: describeProbe(summary.report),
        });
      } catch (error) {
        addLog({
          machineName: machine.name,
          color: machine.color,
          tone: 'error',
          text: `Probe failed: ${messageOf(error)}`,
        });
      } finally {
        setProbing((current) => {
          const next = new Set(current);
          next.delete(machine.id);
          return next;
        });
      }
    },
    [addLog, setMachines],
  );

  const probeAll = () => {
    for (const machine of local) void probe(machine);
  };

  const save = async (values: MachineFormValues) => {
    if (dialog?.mode === 'edit') {
      const updated = await api.updateMachine(dialog.machine.id, values);
      setMachines((list) => list?.map((m) => (m.id === updated.id ? updated : m)) ?? [updated]);
      setDialog(null);
      addLog({ machineName: updated.name, color: updated.color, tone: 'info', text: 'Saved.' });
      if (updated.lastProbe === null) void probe(updated);
      return;
    }
    const created = await api.createMachine({
      ...values,
      apiKey: values.apiKey ?? '',
      agentToken: values.agentToken ?? '',
    });
    setMachines((list) => [...(list ?? []), created]);
    setDialog(null);
    addLog({ machineName: created.name, color: created.color, tone: 'info', text: 'Added.' });
    void probe(created);
  };

  const saveCloud = async (values: CloudFormValues) => {
    if (dialog?.mode === 'edit') {
      const updated = await api.updateMachine(dialog.machine.id, {
        ...values,
        notes: dialog.machine.notes,
      });
      setMachines((list) => list?.map((m) => (m.id === updated.id ? updated : m)) ?? [updated]);
      setDialog(null);
      addLog({ machineName: updated.name, color: updated.color, tone: 'info', text: 'Saved.' });
      return;
    }
    const created = await api.createMachine(values);
    setMachines((list) => [...(list ?? []), created]);
    setDialog(null);
    addLog({
      machineName: created.name,
      color: created.color,
      tone: 'info',
      text: `Added ${values.cloud.model.id} as a cloud reference.`,
    });
  };

  const remove = async () => {
    if (!deleting) return;
    await api.deleteMachine(deleting.id);
    setMachines((list) => list?.filter((m) => m.id !== deleting.id) ?? null);
    addLog({ machineName: deleting.name, color: deleting.color, tone: 'info', text: 'Deleted.' });
    setDeleting(null);
  };

  const openAdd = () => setDialog({ mode: 'add' });

  return (
    <>
      <TopBar
        title="Machines"
        current="machines"
        actions={
          <>
            {local.length > 0 ? (
              <button
                type="button"
                className="btn btn-outline"
                onClick={probeAll}
                disabled={probing.size > 0}
              >
                Probe all
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => setDialog({ mode: 'add-cloud' })}
            >
              Add cloud model
            </button>
            <button type="button" className="btn btn-primary" onClick={openAdd}>
              Add machine
            </button>
          </>
        }
      />

      <main className="main">
        <p className="subbar">
          Each machine runs Unsloth Studio. A probe checks that Model Duel can reach it, that the
          API key works, and what the machine can run. Cloud models from OpenAI, Anthropic and
          Google race on the Text tab as a reference.
        </p>

        {loadError ? (
          <div className="banner banner-error" role="alert">
            {loadError}
          </div>
        ) : null}
        {machines === null && !loadError ? <p className="loading">Loading machines…</p> : null}
        {machines && machines.length === 0 ? <EmptyState onAdd={openAdd} /> : null}
        {local.length > 0 ? (
          <section className="panel telemetry-panel" aria-label="Live hardware">
            <TelemetrySwitch enabled={telemetry.enabled} onError={setTelemetryError} />
            {telemetryError ? <p className="field-error">{telemetryError}</p> : null}
          </section>
        ) : null}
        {machines && machines.length > 0 ? (
          <div className="machine-grid">
            {machines.map((machine) =>
              machine.cloud ? (
                <CloudCard
                  key={machine.id}
                  machine={{ ...machine, cloud: machine.cloud }}
                  onEdit={() => setDialog({ mode: 'edit', machine })}
                  onDelete={() => setDeleting(machine)}
                />
              ) : (
                <MachineCard
                  key={machine.id}
                  machine={machine}
                  probing={probing.has(machine.id)}
                  now={now}
                  onProbe={() => void probe(machine)}
                  onEdit={() => setDialog({ mode: 'edit', machine })}
                  onDelete={() => setDeleting(machine)}
                  telemetry={{
                    enabled: telemetry.enabled,
                    status: telemetry.statuses[machine.id],
                    sample: telemetry.latest[machine.id],
                  }}
                />
              ),
            )}
          </div>
        ) : null}

        <LogPanel machines={machines ?? []} entries={log} />
      </main>

      {dialog?.mode === 'add-cloud' || (dialog?.mode === 'edit' && dialog.machine.cloud) ? (
        <CloudDialog
          key={dialog.mode === 'edit' ? dialog.machine.id : 'add-cloud'}
          machine={dialog.mode === 'edit' ? dialog.machine : null}
          usedColors={(machines ?? []).map((m) => m.color)}
          onSubmit={saveCloud}
          onClose={() => setDialog(null)}
        />
      ) : dialog ? (
        <MachineDialog
          key={dialog.mode === 'edit' ? dialog.machine.id : 'add'}
          machine={dialog.mode === 'edit' ? dialog.machine : null}
          usedColors={(machines ?? []).map((m) => m.color)}
          onSubmit={save}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete machine"
          message={
            deleting.cloud
              ? `Delete ${deleting.name}? Its saved API key is removed from this computer. Races it ran keep their results.`
              : `Delete ${deleting.name}? Its saved API key and last probe are removed from this computer. Unsloth on that machine is not touched.`
          }
          confirmLabel="Delete"
          onConfirm={remove}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <section className="empty" aria-labelledby="empty-title">
      <h2 id="empty-title" className="section-title">
        No machines yet
      </h2>
      <ol>
        <li>
          On each machine, open Unsloth and go to <b>Settings → API → Remote &amp; LAN</b>. Press{' '}
          <b>Start</b> and turn on <b>Start automatically</b>.
        </li>
        <li>On the same screen, create an API key and copy it. Unsloth shows it only once.</li>
        <li>Add the machine here with its IP address and the key.</li>
      </ol>
      <button type="button" className="btn btn-primary" onClick={onAdd}>
        Add machine
      </button>
    </section>
  );
}
