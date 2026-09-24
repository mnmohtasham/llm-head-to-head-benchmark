import {
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  formatMs,
  type Capability,
  type CapabilityKey,
  type MachineView,
  type ProbeReport,
} from '@duel/shared';
import type { CSSProperties } from 'react';
import { api } from '../api';
import { formatGb, osLabel, relativeTime } from '../format';

const STATUS_TEXT: Record<Capability['status'], string> = {
  ok: 'works',
  missing: 'not available',
  error: 'failed',
  unknown: 'not checked',
};

const STATE_LABEL = {
  probing: 'Probing…',
  idle: 'Not probed',
  ok: 'Ready',
  warning: 'Check',
  error: 'Error',
} as const;

interface Props {
  machine: MachineView;
  probing: boolean;
  now: number;
  onProbe: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function MachineCard({ machine, probing, now, onProbe, onEdit, onDelete }: Props) {
  const probe = machine.lastProbe;
  const report = probe?.report ?? null;
  const state = probing ? 'probing' : report ? report.overall : 'idle';
  const nameId = `machine-${machine.id}`;

  return (
    <article
      className="card"
      data-testid="machine-card"
      data-machine-name={machine.name}
      style={{ '--machine': machine.color } as CSSProperties}
      aria-labelledby={nameId}
      aria-busy={probing}
    >
      <header className="card-head">
        <div className="card-title">
          <h2 id={nameId} className="machine-name">
            {machine.name}
          </h2>
          {machine.notes ? <p className="machine-notes">{machine.notes}</p> : null}
        </div>
        <span className={`state state-${state}`} data-testid="overall" role="status">
          {STATE_LABEL[state]}
        </span>
      </header>

      {report ? <Stats report={report} /> : null}

      <ul className="chips" aria-label="Capabilities">
        {CAPABILITY_KEYS.map((key) => (
          <Chip key={key} name={key} capability={report?.capabilities[key] ?? null} />
        ))}
      </ul>

      {report ? <Details report={report} /> : null}
      {report && report.issues.length > 0 ? <Issues report={report} /> : null}

      <dl className="meta">
        <div>
          <dt>Address</dt>
          <dd className="mono">{machine.baseUrl}</dd>
        </div>
        <div>
          <dt>Key</dt>
          <dd className="mono">{machine.apiKeyMasked ?? 'none'}</dd>
        </div>
        <div>
          <dt>Probed</dt>
          <dd>
            {probe ? (
              <time dateTime={probe.probedAt} title={new Date(probe.probedAt).toLocaleString()}>
                {relativeTime(probe.probedAt, now)}
              </time>
            ) : (
              'never'
            )}
          </dd>
        </div>
      </dl>

      <div className="card-actions">
        <button type="button" className="btn btn-outline" onClick={onProbe} disabled={probing}>
          Probe
        </button>
        <button type="button" className="btn btn-quiet" onClick={onEdit}>
          Edit
        </button>
        {probe ? (
          <a className="btn btn-quiet" href={api.exportUrl(machine.id)} download>
            Export probe
          </a>
        ) : null}
        <button type="button" className="btn btn-quiet btn-danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </article>
  );
}

function Chip({ name, capability }: { name: CapabilityKey; capability: Capability | null }) {
  const status = capability?.status ?? 'unknown';
  const label = CAPABILITY_LABELS[name];
  const described = capability ? STATUS_TEXT[status] : 'not probed yet';
  return (
    <li
      className={`chip chip-${status}`}
      data-testid={`cap-${name}`}
      data-status={capability ? status : 'none'}
      title={capability ? `${label}: ${capability.summary}` : `${label}: not probed yet`}
    >
      <span className="chip-dot" aria-hidden="true" />
      {label}
      <span className="sr-only">: {described}</span>
    </li>
  );
}

function Stats({ report }: { report: ProbeReport }) {
  const software: Array<[string, string]> = [];
  if (report.versions.unsloth) software.push(['Unsloth', report.versions.unsloth]);
  if (report.versions.studio) software.push(['Studio', report.versions.studio]);
  if (report.versions.llamaCpp) software.push(['llama.cpp', report.versions.llamaCpp]);
  if (report.platform.backend) software.push(['Backend', report.platform.backend.toUpperCase()]);
  if (report.rtt.medianMs !== null) software.push(['RTT', formatMs(report.rtt.medianMs)]);

  const hardware: Array<[string, string]> = [];
  for (const gpu of report.gpus) {
    hardware.push([
      'GPU',
      gpu.memoryGb !== null ? `${gpu.name} · ${formatGb(gpu.memoryGb)}` : gpu.name,
    ]);
  }
  if (report.platform.cpuCores !== null)
    hardware.push(['CPU', `${report.platform.cpuCores} threads`]);
  if (report.platform.memoryTotalGb !== null) {
    hardware.push(['RAM', formatGb(report.platform.memoryTotalGb)]);
  }
  const os = osLabel(report.platform.os);
  if (os) hardware.push(['OS', os]);

  const rows = [software, hardware].filter((row) => row.length > 0);
  if (rows.length === 0) return null;
  return (
    <div className="stats">
      {rows.map((row, index) => (
        <p className="stat-row" key={index}>
          {row.map(([label, value]) => (
            <span className="stat" key={`${label}-${value}`}>
              <span className="stat-label">{label}</span>{' '}
              <span className="stat-value">{value}</span>
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

function Details({ report }: { report: ProbeReport }) {
  const keys = (['text', 'stt', 'image', 'telemetry'] as const).filter(
    (key) => report.capabilities[key].status !== 'unknown',
  );
  if (keys.length === 0) return null;
  const summary = (key: (typeof keys)[number]) => {
    const text = report.capabilities[key].summary;
    const context = report.text.contextLength;
    return key === 'text' && context ? `${text} · ${Math.round(context / 1024)}K context` : text;
  };
  return (
    <dl className="details">
      {keys.map((key) => (
        <div className="detail-row" key={key}>
          <dt>{CAPABILITY_LABELS[key]}</dt>
          <dd>{summary(key)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Issues({ report }: { report: ProbeReport }) {
  return (
    <ul className="issues" aria-label="Findings">
      {report.issues.map((issue, index) => (
        <li key={index} className={`issue issue-${issue.severity}`}>
          <span className="issue-title">{issue.title}</span>{' '}
          <span className="issue-hint">{issue.hint}</span>
        </li>
      ))}
    </ul>
  );
}
