import fs from 'node:fs';
import path from 'node:path';
import {
  applyEdits,
  modify,
  parse,
  type ParseError,
} from 'jsonc-parser';
import { Document, isMap, parseDocument } from 'yaml';
import type { GeneratedFile } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);
}

function mergeJson(existing: string, value: Record<string, unknown>): string {
  let rendered = existing.trim() ? existing : '{}\n';
  const errors: ParseError[] = [];
  const parsed = parse(rendered, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length || !isRecord(parsed)) {
    throw new Error('Existing JSON/JSONC cannot be parsed safely');
  }

  const formattingOptions = {
    insertSpaces: true,
    tabSize: 2,
    eol: '\n',
  };
  const applyPatch = (
    base: Record<string, unknown>,
    patch: Record<string, unknown>,
    parentPath: (string | number)[] = [],
  ) => {
    for (const [key, next] of Object.entries(patch)) {
      const current = base[key];
      const propertyPath = [...parentPath, key];
      if (isRecord(current) && isRecord(next)) {
        applyPatch(current, next, propertyPath);
        continue;
      }
      rendered = applyEdits(rendered, modify(
        rendered,
        propertyPath,
        next,
        { formattingOptions },
      ));
    }
  };
  applyPatch(parsed, value);
  return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
}

// Structural YAML merge, the `mergeJson` rule applied to a YAML document:
// nested objects recurse, everything else (scalars, arrays) is replaced at
// that path, and an explicit `undefined` deletes the key (a generator's way
// to retire a sibling the new value makes stale). Editing the parsed
// Document rather than re-rendering from a plain object keeps the user's
// comments, key order, and quoting for every node the patch does not touch —
// a settings.yaml shared with other providers (DeepSeek Harness keeps every
// route under one `llm-pi-ai` key) must not lose its siblings just because
// ours changed.
function mergeYamlDocument(existing: string, value: Record<string, unknown>): string {
  if (!existing.trim()) {
    const fresh = new Document(JSON.parse(JSON.stringify(value)));
    return fresh.toString({ lineWidth: 0 });
  }
  const doc = parseDocument(existing);
  if (doc.errors.length) {
    throw new Error(`Existing YAML cannot be parsed safely: ${doc.errors[0].message}`);
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error('Existing YAML is not a mapping at the top level');
  }
  const applyPatch = (patch: Record<string, unknown>, parentPath: string[] = []) => {
    for (const [key, next] of Object.entries(patch)) {
      const propertyPath = [...parentPath, key];
      if (next === undefined) {
        doc.deleteIn(propertyPath);
        continue;
      }
      const current = doc.getIn(propertyPath, true);
      if (isRecord(next) && isMap(current)) {
        applyPatch(next, propertyPath);
        continue;
      }
      doc.setIn(propertyPath, next);
    }
  };
  applyPatch(value);
  const rendered = doc.toString({ lineWidth: 0 });
  return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
}

function markerPattern(): RegExp {
  return new RegExp(
    `^[ \\t]*(?:#|//) freellmapi:start[\\s\\S]*?^[ \\t]*(?:#|//) freellmapi:end\\s*`,
    'm',
  );
}

function mergeMarked(existing: string, generated: string): string {
  const start = generated.match(/^[ \t]*(?:#|\/\/) freellmapi:start$/m)?.[0];
  const end = generated.match(/^[ \t]*(?:#|\/\/) freellmapi:end$/m)?.[0];
  if (!start || !end) return generated;
  const marked = markerPattern();
  if (marked.test(existing)) {
    return existing.replace(marked, `${generated.trimEnd()}\n`);
  }
  const separator = existing.length && !existing.endsWith('\n') ? '\n' : '';
  return `${existing}${separator}${existing.trim() ? '\n' : ''}${generated}`;
}

function topLevelYamlKey(line: string): string | undefined {
  return line.match(/^([A-Za-z0-9_-]+):(?:\s|$)/)?.[1];
}

function generatedYamlKeys(generated: string): Set<string> {
  return new Set(generated.split(/\r?\n/)
    .map(topLevelYamlKey)
    .filter((key): key is string => Boolean(key)));
}

function removeYamlKeys(existing: string, keys: Set<string>): string {
  const lines = existing.split(/\r?\n/);
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const key = topLevelYamlKey(lines[index]);
    if (!key || !keys.has(key)) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    index += 1;
    while (index < lines.length && !topLevelYamlKey(lines[index])) index += 1;
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function continueModelLines(generated: string): string[] {
  const lines = generated.split(/\r?\n/);
  const modelsIndex = lines.findIndex(line => line === 'models:');
  const endIndex = lines.findIndex(
    (line, index) => index > modelsIndex && line === '# freellmapi:end',
  );
  return lines.slice(modelsIndex + 1, endIndex < 0 ? undefined : endIndex);
}

function mergeContinueYaml(existing: string, generated: string): string {
  const generatedLines = generated.split(/\r?\n/);
  const missingHeader = ['name', 'version', 'schema']
    .filter(key => !existing.split(/\r?\n/).some(line => topLevelYamlKey(line) === key))
    .map(key => generatedLines.find(line => topLevelYamlKey(line) === key)!)
    .filter(Boolean);
  let lines = existing.split(/\r?\n/);
  const modelsIndex = lines.findIndex(line => topLevelYamlKey(line) === 'models');
  const modelLines = continueModelLines(generated);

  if (modelsIndex < 0) {
    const prefix = missingHeader.length ? `${missingHeader.join('\n')}\n` : '';
    const separator = existing.trim() ? '\n\n' : '';
    return `${prefix}${existing.trimEnd()}${separator}models:\n${modelLines.join('\n')}\n`;
  }

  let modelsEnd = modelsIndex + 1;
  while (modelsEnd < lines.length && !topLevelYamlKey(lines[modelsEnd])) modelsEnd += 1;
  const entryStart = lines.findIndex(
    (line, index) => index > modelsIndex
      && index < modelsEnd
      && /^\s{2}-\s+name:\s+["']?FreeLLMAPI["']?\s*$/.test(line),
  );
  if (entryStart >= 0) {
    let entryEnd = entryStart + 1;
    while (
      entryEnd < modelsEnd
      && !/^\s{2}-\s+/.test(lines[entryEnd])
      && !topLevelYamlKey(lines[entryEnd])
    ) {
      entryEnd += 1;
    }
    lines.splice(entryStart, entryEnd - entryStart, ...modelLines);
  } else {
    lines.splice(modelsEnd, 0, ...modelLines);
  }
  if (missingHeader.length) lines = [...missingHeader, ...lines];
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function mergeYaml(existing: string, generated: string): string {
  if (/^name: FreeLLMAPI$/m.test(generated) && /^models:$/m.test(generated)) {
    const withoutOldBlock = existing.replace(markerPattern(), '').trimEnd();
    return mergeContinueYaml(withoutOldBlock, generated);
  }
  if (!existing.trim()) return generated;
  if (/^# freellmapi:start$/m.test(existing)) return mergeMarked(existing, generated);
  const withoutConflicts = removeYamlKeys(existing, generatedYamlKeys(generated));
  return mergeMarked(withoutConflicts, generated);
}

function tomlTableHeader(line: string): string | undefined {
  return line.match(/^\[([^\]]+)\]$/)?.[1];
}

function tomlRootKey(line: string): string | undefined {
  return line.match(/^([A-Za-z0-9_.-]+)\s*=/)?.[1];
}

function isTomlMarkerLine(line: string): boolean {
  return /^[ \t]*# freellmapi:(?:start|end)$/.test(line);
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

interface TomlSections {
  root: string[];
  tables: string[];
}

function splitTomlSections(generated: string): TomlSections {
  const lines = generated.split(/\r?\n/).filter(line => !isTomlMarkerLine(line));
  const firstTable = lines.findIndex(line => tomlTableHeader(line) !== undefined);
  if (firstTable < 0) return { root: trimBlankEdges(lines), tables: [] };
  return {
    root: trimBlankEdges(lines.slice(0, firstTable)),
    tables: trimBlankEdges(lines.slice(firstTable)),
  };
}

// TOML keys written after a `[table]` header belong to that table, so
// generated root-level keys must be inserted BEFORE the first table header of
// the existing file, never appended after it. Generated tables are appended at
// the end, and only root keys that the generated ROOT REGION sets are removed
// from the existing root region.
function mergeToml(existing: string, generated: string): string {
  if (!existing.trim()) return generated;
  const { root: generatedRoot, tables: generatedTables } = splitTomlSections(generated);
  const rootKeys = new Set(generatedRoot
    .map(tomlRootKey)
    .filter((key): key is string => Boolean(key)));
  const tableNames = new Set(generatedTables
    .map(tomlTableHeader)
    .filter((name): name is string => Boolean(name)));

  const kept: string[] = [];
  let currentTable: string | undefined;
  for (const line of existing.split(/\r?\n/)) {
    if (isTomlMarkerLine(line)) continue;
    const table = tomlTableHeader(line);
    if (table) currentTable = table;
    if (currentTable && tableNames.has(currentTable)) continue;
    if (!currentTable && rootKeys.has(tomlRootKey(line) ?? '')) continue;
    kept.push(line);
  }

  const wrap = (lines: string[]): string[] => (lines.length
    ? ['# freellmapi:start', ...lines, '# freellmapi:end']
    : []);
  const firstTable = kept.findIndex(line => tomlTableHeader(line) !== undefined);
  const head = firstTable < 0 ? kept : kept.slice(0, firstTable);
  const tail = firstTable < 0 ? [] : kept.slice(firstTable);
  const sections = [head, wrap(generatedRoot), tail, wrap(generatedTables)]
    .map(lines => trimBlankEdges(lines).join('\n').replace(/\n{3,}/g, '\n\n'))
    .filter(Boolean);
  return `${sections.join('\n\n')}\n`;
}

function mergeEnv(existing: string, generated: string): string {
  const replacements = new Map(
    generated.split(/\r?\n/)
      .filter(line => line && !line.startsWith('#') && line.includes('='))
      .map(line => [line.slice(0, line.indexOf('=')), line]),
  );
  const lines = existing.split(/\r?\n/);
  const seen = new Set<string>();
  const output = lines.map(line => {
    const separator = line.indexOf('=');
    if (separator < 1 || line.trimStart().startsWith('#')) return line;
    const key = line.slice(0, separator);
    const replacement = replacements.get(key);
    if (!replacement) return line;
    seen.add(key);
    return replacement;
  });
  for (const [key, line] of replacements) {
    if (!seen.has(key)) output.push(line);
  }
  return `${output.filter((line, index) => line || index < output.length - 1).join('\n')}\n`;
}

export function renderFile(file: GeneratedFile, existing = ''): string {
  if (file.format === 'json') return mergeJson(existing, file.value ?? {});
  if (file.format === 'env') return mergeEnv(existing, file.content ?? '');
  if (file.format === 'yaml') {
    return file.value
      ? mergeYamlDocument(existing, file.value)
      : mergeYaml(existing, file.content ?? '');
  }
  return mergeToml(existing, file.content ?? '');
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export interface ApplyResult {
  path: string;
  changed: boolean;
  backupPath?: string;
  rendered: string;
  previous: string;
}

interface PlannedWrite extends ApplyResult {
  file: GeneratedFile;
  exists: boolean;
}

function planGeneratedFile(file: GeneratedFile): PlannedWrite {
  const exists = fs.existsSync(file.path);
  const previous = exists ? fs.readFileSync(file.path, 'utf8') : '';
  const rendered = renderFile(file, previous);
  return {
    file,
    exists,
    path: file.path,
    changed: rendered !== previous,
    rendered,
    previous,
  };
}

function commitPlannedWrite(plan: PlannedWrite): ApplyResult {
  const { file, exists, ...result } = plan;
  if (!plan.changed) return result;
  fs.mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
  let backupPath: string | undefined;
  if (exists) {
    backupPath = `${file.path}.backup-${timestamp()}`;
    fs.copyFileSync(file.path, backupPath);
  }
  const temporary = `${file.path}.freellmapi-${process.pid}.tmp`;
  fs.writeFileSync(temporary, plan.rendered, { mode: file.sensitive ? 0o600 : 0o644 });
  fs.renameSync(temporary, file.path);
  if (file.sensitive) fs.chmodSync(file.path, 0o600);
  return { ...result, backupPath };
}

// Two-phase apply: every target file is read and merged BEFORE the first
// write, so a merge failure on any file aborts the whole batch without
// leaving earlier files modified.
export function applyGeneratedFiles(
  files: GeneratedFile[],
  dryRun: boolean,
): ApplyResult[] {
  const plans = files.map(planGeneratedFile);
  if (dryRun) return plans.map(({ file: _file, exists: _exists, ...result }) => result);
  return plans.map(commitPlannedWrite);
}

export function applyGeneratedFile(file: GeneratedFile, dryRun: boolean): ApplyResult {
  return applyGeneratedFiles([file], dryRun)[0];
}

export function printDryRunDiff(result: ApplyResult): string {
  const oldLines = result.previous.split(/\r?\n/);
  const newLines = result.rendered.split(/\r?\n/);
  const lines = [`--- ${result.path}`, `+++ ${result.path}`];
  if (!result.previous) {
    lines.push(...newLines.map(line => `+${line}`));
    return lines.join('\n');
  }
  const prefix = oldLines.findIndex((line, index) => line !== newLines[index]);
  const changedAt = prefix < 0 ? 0 : prefix;
  lines.push(`@@ line ${changedAt + 1} @@`);
  lines.push(...oldLines.slice(changedAt).map(line => `-${line}`));
  lines.push(...newLines.slice(changedAt).map(line => `+${line}`));
  return lines.join('\n');
}
