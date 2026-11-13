export interface Scheduler {
  every(ms: number, fn: () => void | Promise<void>, opts?: { name?: string }): () => void;
  after(ms: number, fn: () => void | Promise<void>): () => void;
}

export class NodeScheduler implements Scheduler {
  // Every live timer's cancel, so shutdown can stop all background jobs
  // before it closes the database (M39). Once stopped, nothing new starts.
  private readonly cancels = new Set<() => void>();
  private stopped = false;

  every(ms: number, fn: () => void | Promise<void>, _opts?: { name?: string }): () => void {
    if (this.stopped) return () => {};
    const id = setInterval(() => { void fn(); }, ms);
    return this.track(() => clearInterval(id));
  }

  after(ms: number, fn: () => void | Promise<void>): () => void {
    if (this.stopped) return () => {};
    const id = setTimeout(() => {
      this.cancels.delete(cancel);
      void fn();
    }, ms);
    const cancel = this.track(() => clearTimeout(id));
    return cancel;
  }

  /** Cancel every timer handed out and refuse new ones. */
  stopAll(): void {
    this.stopped = true;
    for (const cancel of this.cancels) cancel();
    this.cancels.clear();
  }

  private track(clear: () => void): () => void {
    const cancel = () => {
      clear();
      this.cancels.delete(cancel);
    };
    this.cancels.add(cancel);
    return cancel;
  }
}
