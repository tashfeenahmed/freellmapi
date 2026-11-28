// #44206: streaming tool_call delta accumulator.
//
// Some upstreams pack MULTIPLE complete tool_calls into one delta (observed
// Glm shape: call 1 with id/name/arguments, call 2 with a name but a missing
// or garbage index). The old `index ?? 0` merge welded those into one
// corrupted call whose concatenated arguments failed to parse, so the whole
// turn read as an empty completion and needlessly failed over.
//
// Routing per entry, in order:
//   1. id already seen → extend that call (fragment or repeat-id provider).
//   2. fresh id → new call (its index if unclaimed, else a synthetic key).
//   3. no id, no name, index matches an open call → extend it (the normal
//      OpenAI-style argument fragment).
//   4. no id, name, index matches an open call whose name is still empty →
//      extend it (id-less providers stream the name first).
//   5. otherwise, an entry with a name starts a NEW call — covers the packed
//      second complete call (missing index) that used to be merged into call 0.
//   6. no id, no name, no (or unknown) index → argument fragment; extend the
//      most recently opened call, or key 0 for backward compatibility.
//
// Keys stay numeric so the caller's existing Map<number, acc> ordering
// (sorted by key at assembly time) is preserved: provider indexes come first
// in index order, synthetic keys (1_000_000+) follow in array order.

export interface ToolCallAcc {
  id?: string;
  name: string;
  args: string;
}

export interface ToolCallDelta {
  index?: number | null;
  id?: string | null;
  function?: { name?: string | null; arguments?: string | null } | null;
}

export class ToolCallAccumulator {
  private readonly accs = new Map<number, ToolCallAcc>();
  private readonly idKey = new Map<string, number>();
  private nextSyntheticKey = 1_000_000;
  private lastOpenKey: number | null = null;

  /** True once any tool_call delta frame arrived. */
  sawDeltas = false;

  /** Process one entry of a delta's tool_calls array. */
  add(tc: ToolCallDelta): void {
    this.sawDeltas = true;
    const hasId = typeof tc.id === 'string' && tc.id.length > 0;
    const name = tc.function?.name ?? '';
    const args = tc.function?.arguments ?? '';
    const idx = typeof tc.index === 'number' ? tc.index : null;
    const openOrCreate = (key: number): ToolCallAcc => {
      let acc = this.accs.get(key);
      if (!acc) {
        acc = { id: undefined, name: '', args: '' };
        this.accs.set(key, acc);
      }
      this.lastOpenKey = key;
      return acc;
    };
    let key: number | null = hasId ? this.idKey.get(tc.id!) ?? null : null;
    if (key == null && idx != null && !name && this.accs.has(idx)) key = idx;
    if (key == null && idx != null && name && this.accs.has(idx) && !this.accs.get(idx)!.name) key = idx;
    if (key == null && (hasId || name)) {
      key = idx != null && !this.accs.has(idx) ? idx : this.nextSyntheticKey++;
      if (hasId) this.idKey.set(tc.id!, key);
    }
    if (key == null) key = idx ?? this.lastOpenKey ?? 0;
    const acc = openOrCreate(key);
    if (tc.id && !acc.id) acc.id = tc.id;
    if (name) acc.name += name;
    if (args) acc.args += args;
  }

  /** Accumulated calls, ordered by key (provider indexes, then array order). */
  entries(): ToolCallAcc[] {
    return [...this.accs.entries()].sort((a, b) => a[0] - b[0]).map(([, acc]) => acc);
  }

  /** Same calls as entries() — alias for the previous Map.values() call sites. */
  values(): ToolCallAcc[] {
    return this.entries();
  }
}