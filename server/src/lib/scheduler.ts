export interface Scheduler {
  every(ms: number, fn: () => void | Promise<void>, opts?: { name?: string }): () => void;
  after(ms: number, fn: () => void | Promise<void>): () => void;
}

export class NodeScheduler implements Scheduler {
  every(ms: number, fn: () => void | Promise<void>, _opts?: { name?: string }): () => void {
    const id = setInterval(() => { void fn(); }, ms);
    return () => clearInterval(id);
  }

  after(ms: number, fn: () => void | Promise<void>): () => void {
    const id = setTimeout(() => { void fn(); }, ms);
    return () => clearTimeout(id);
  }
}
