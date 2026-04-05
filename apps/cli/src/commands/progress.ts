export class ProgressTracker {
  private startTime: number;
  private completed = 0;
  private total: number;

  constructor(total: number) {
    this.total = total;
    this.startTime = performance.now();
  }

  tick(count = 1): void {
    this.completed += count;
  }

  format(): string {
    const elapsed = performance.now() - this.startTime;
    const elapsedSec = elapsed / 1000;
    if (this.completed === 0 || elapsedSec < 1) {
      return `${this.completed}/${this.total}`;
    }
    const rate = this.completed / elapsedSec;
    const remaining = (this.total - this.completed) / rate;
    return `${this.completed}/${this.total} (${formatDuration(elapsedSec)} elapsed, ~${formatDuration(remaining)} remaining)`;
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return `${mins}m${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h${remainMins}m`;
}
