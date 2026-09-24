export function relativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function clockTime(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatGb(gb: number | null): string {
  if (gb === null) return 'n/a';
  return gb >= 100 ? `${Math.round(gb)} GB` : `${Number(gb.toFixed(1))} GB`;
}

/** "macOS-15.6.1-arm64-arm-64bit" becomes "macOS 15.6.1"; Linux keeps the kernel version. */
export function osLabel(platform: string | null): string | null {
  if (!platform) return null;
  const mac = /^macOS-([\d.]+)/.exec(platform);
  if (mac) return `macOS ${mac[1]}`;
  const linux = /^Linux-(\d+\.\d+)/.exec(platform);
  if (linux) return `Linux ${linux[1]}`;
  const windows = /^Windows-(\d+)/.exec(platform);
  if (windows) return `Windows ${windows[1]}`;
  return platform.split('-')[0] ?? platform;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return 'size unknown';
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

export function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** Seconds with two decimals, like the big numbers of the reference tool. */
export function formatSeconds(ms: number | null): string {
  return ms === null ? 'n/a' : (ms / 1000).toFixed(2);
}

export function formatMsValue(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'n/a';
  return ms < 10
    ? `${ms.toFixed(1)} ms`
    : ms < 10_000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(1)} s`;
}

export function formatRate(value: number | null | undefined, unit: string): string {
  return value === null || value === undefined ? 'n/a' : `${value.toFixed(1)} ${unit}`;
}
