export function years(value: number): string {
  if (value < 1 / 12) return `${Math.max(1, Math.round(value * 365))} d`;
  if (value < 1) return `${Math.round(value * 12)} mo`;
  return `${value.toFixed(1)} yr`;
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function metres(value: number): string {
  return value < 1 ? `${(value * 100).toFixed(0)} cm` : `${value.toFixed(1)} m`;
}

export function count(value: number): string {
  return value.toLocaleString();
}

export function ago(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const hours = delta / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(delta / 60_000))} min ago`;
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function until(iso: string): string {
  const delta = new Date(iso).getTime() - Date.now();
  if (delta <= 0) return 'now';
  const hours = delta / 3_600_000;
  if (hours < 1) return `${Math.round(delta / 60_000)} min`;
  return `${Math.round(hours)} h`;
}
