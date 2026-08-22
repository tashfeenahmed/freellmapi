import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A handful of lib modules are pure by design: functions over their arguments,
// no I/O, no DB, no config. error-classify.ts says so in its own header and
// gives the reason — it is imported by the proxy, the responses path AND the
// fusion panel, so a value import there is how the fusion ↔ proxy cycle comes
// back. The others are the same shape: parsers and formatters that several
// surfaces share precisely because they depend on nothing.
//
// Nothing enforces that today. Adding `import { getDb }` to one of them
// compiles, passes every test, and quietly converts a leaf into a hub — the
// damage (an import cycle, a DB read on a hot path that must never throw, a
// unit test that suddenly needs a database) surfaces later and somewhere else.
// Same rationale as registry-drift.test.ts: make the quiet no-op a failing
// test.
//
// TYPE imports stay legal. `import type` is erased before it can create a
// cycle or pull in a runtime dependency, which is why the type-only modules
// below are on the list rather than excluded from it.

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(here, '../../lib');

// NEW PURE MODULES MUST BE ADDED HERE. This is not a convention you have to
// remember: `every pure lib module is on the list` below fails until a module
// with no value imports is listed, so the guard maintains itself rather than
// silently covering less of lib/ as lib/ grows. A module deliberately left off
// is a module being declared not-pure, which is a decision worth making out
// loud in a diff.
const PURE_MODULES = [
  'budget.ts',
  'error-classify.ts',
  'header-value.ts',
  'provider-identity.ts',
  'structured-output.ts',
  'tool-args.ts',
  'tool-call-rescue.ts',
  // Type-only imports today; listed so they stay that way.
  'client-classifier.ts',
  'content.ts',
  'think-tags.ts',
];

// Pure in fact today, but NOT declared invariant: nothing in the codebase
// depends on these staying import-free, and freezing a module nobody has argued
// should be frozen buys a false failure the first time one legitimately needs a
// dependency. They are listed only so the classification check below has an
// answer for them — moving one up to PURE_MODULES is the way to promote it.
const NOT_GUARDED = [
  'config.ts',
  'custom-provider-cleanup.ts',
  'endpoint-scope.ts',
  'error-redaction.ts',
  'gemini-wire.ts',
  'key-parser.ts',
  'log-redaction.ts',
  'model-scope.ts',
  'process-safety-net.ts',
  'provider-timeout.ts',
  'scheduler.ts',
  'served-model.ts',
  'wake-detect.ts',
];

/** True when every specifier inside `{...}` is type-only, so the whole
 *  statement is erased. */
function allSpecifiersAreTypes(specifiers: string): boolean {
  return specifiers.split(',').every(s => s.trim() === '' || /^type\s/.test(s.trim()));
}

/** Import statements that survive compilation, i.e. everything except
 *  `import type ...`. Also catches bare side-effect imports (`import './x.js'`)
 *  and `require(...)`, which are value dependencies just as much.
 *
 *  Three forms beyond a plain static import are load-bearing here, because each
 *  creates the same runtime dependency while looking nothing like `^import`:
 *  a dynamic `await import('./x.js')`, and re-exports of the form
 *  `export { x } from './x.js'` / `export * from './x.js'` — a re-export is an
 *  import that also republishes, so it forms a cycle just as readily. */
function valueImportsIn(source: string): string[] {
  const found: string[] = [];
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*')) continue;

    // Dynamic import — `const m = await import('./x.js')` never starts with
    // `import`, so the anchored rules below cannot see it. `import.meta.url`
    // is not a call and does not match.
    if (/\bimport\s*\(/.test(line)) { found.push(line); continue; }

    // Re-exports. Only those with a `from` clause reach another module;
    // `export { localThing }` republishes something declared right here.
    if (/^export\b/.test(line) && /\bfrom\s*['"]/.test(line)) {
      if (!/^export\s+type\b/.test(line)) {
        const reexported = /^export\s*\{([^}]*)\}\s*from/.exec(line);
        if (!reexported || !allSpecifiersAreTypes(reexported[1])) found.push(line);
      }
      continue;
    }

    if (/^import\s+type\b/.test(line)) continue;
    // `import { type A, type B } from` is also fully erased.
    const named = /^import\s*\{([^}]*)\}\s*from/.exec(line);
    if (named && allSpecifiersAreTypes(named[1])) continue;
    if (/^import\b/.test(line)) found.push(line);
    if (/\brequire\s*\(/.test(line)) found.push(line);
  }
  return found;
}

describe('pure lib modules stay pure', () => {
  it.each(PURE_MODULES)('%s has no value imports', (filename) => {
    const source = fs.readFileSync(path.join(LIB, filename), 'utf8');

    expect(valueImportsIn(source)).toEqual([]);
  });

  it('every listed module actually exists', () => {
    // A rename that leaves the list behind would otherwise silently stop
    // guarding anything.
    for (const filename of PURE_MODULES) {
      expect(fs.existsSync(path.join(LIB, filename)), `${filename} is listed but missing`).toBe(true);
    }
  });

  it('every import-free lib module is classified, so the guard cannot drift', () => {
    // What keeps this test honest as lib/ grows. A hardcoded list covers a
    // smaller fraction of lib/ with every module added, and nothing says so:
    // the suite stays green while protecting less and less of what it claims
    // to. A new pure module now fails here until someone decides which list it
    // belongs on.
    //
    // Impure modules need no bookkeeping — purity is computed from the source,
    // so only a module that IS import-free has to be classified. Adding a
    // module with dependencies costs nothing.
    const unclassified = fs.readdirSync(LIB)
      .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .filter(name => !PURE_MODULES.includes(name) && !NOT_GUARDED.includes(name))
      .filter(name => valueImportsIn(fs.readFileSync(path.join(LIB, name), 'utf8')).length === 0);

    expect(
      unclassified,
      `${unclassified.join(', ')} have no value imports, so they are pure in fact, but neither `
      + 'list mentions them and nothing keeps them that way. Add each to PURE_MODULES to make '
      + 'its purity an enforced invariant, or to NOT_GUARDED to record that it is pure today '
      + 'by coincidence rather than by contract.',
    ).toEqual([]);
  });

  it('the two lists stay disjoint and current', () => {
    // A module that gains an import is no longer pure in fact; leaving it in
    // NOT_GUARDED is harmless but stale, and leaving it in PURE_MODULES is
    // caught by the per-module assertions above.
    expect(PURE_MODULES.filter(name => NOT_GUARDED.includes(name))).toEqual([]);
    for (const filename of NOT_GUARDED) {
      expect(fs.existsSync(path.join(LIB, filename)), `${filename} is listed but missing`).toBe(true);
    }
  });

  it('the detector recognises the forms it has to catch', () => {
    expect(valueImportsIn("import type { A } from './a.js';")).toEqual([]);
    expect(valueImportsIn("import { type A, type B } from './a.js';")).toEqual([]);

    expect(valueImportsIn("import { getDb } from '../db/index.js';")).toHaveLength(1);
    expect(valueImportsIn("import fs from 'node:fs';")).toHaveLength(1);
    expect(valueImportsIn("import './side-effect.js';")).toHaveLength(1);
    expect(valueImportsIn("const x = require('node:fs');")).toHaveLength(1);
    expect(valueImportsIn("import { type A, getDb } from '../db/index.js';")).toHaveLength(1);
  });

  it('catches the forms that do not begin with the import keyword', () => {
    // A dynamic import is a runtime dependency that defeats an anchored ^import
    // rule completely — it is the obvious way to smuggle getDb into a pure
    // module without tripping this test.
    expect(valueImportsIn("const { getDb } = await import('../db/index.js');")).toHaveLength(1);
    expect(valueImportsIn("void import('./side-effect.js');")).toHaveLength(1);
    // `import.meta.url` is not a call.
    expect(valueImportsIn('const here = import.meta.url;')).toEqual([]);

    // A re-export imports and republishes in one statement, so it forms a
    // cycle just as readily as a plain import.
    expect(valueImportsIn("export { getDb } from '../db/index.js';")).toHaveLength(1);
    expect(valueImportsIn("export * from '../db/index.js';")).toHaveLength(1);
    expect(valueImportsIn("export * as db from '../db/index.js';")).toHaveLength(1);

    // Type-only re-exports are erased, and a local re-export reaches no module.
    expect(valueImportsIn("export type { A } from './a.js';")).toEqual([]);
    expect(valueImportsIn("export { type A, type B } from './a.js';")).toEqual([]);
    expect(valueImportsIn('export { localHelper };')).toEqual([]);
    expect(valueImportsIn('export function f(): void {}')).toEqual([]);
  });
});
