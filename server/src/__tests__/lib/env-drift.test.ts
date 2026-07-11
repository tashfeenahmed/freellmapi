import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  compareEnvText,
  formatEnvDriftReport,
  parseEnvNames,
  warnOnEnvDrift,
} from '../../lib/env-drift.js';

describe('env drift warnings', () => {
  it('parses active env assignments and can include commented examples', () => {
    const text = [
      'ENCRYPTION_KEY=abc',
      'export PORT=3001',
      '# DASHBOARD_ORIGINS=http://localhost:5173',
      '# just a comment',
      'lowercase=value',
    ].join('\n');

    expect(parseEnvNames(text)).toEqual(['ENCRYPTION_KEY', 'PORT']);
    expect(parseEnvNames(text, { includeCommented: true })).toEqual([
      'DASHBOARD_ORIGINS',
      'ENCRYPTION_KEY',
      'PORT',
    ]);
  });

  it('warns about missing active defaults without flagging opt-in examples', () => {
    const report = compareEnvText(
      'ENCRYPTION_KEY=abc\nPORT=3001\n',
      [
        'ENCRYPTION_KEY=your-key',
        'PORT=3001',
        'REQUEST_ANALYTICS_RETENTION_DAYS=90',
        '# FREELLMAPI_CONTEXT_HANDOFF=on_model_switch',
      ].join('\n'),
    );

    expect(report.missingDocumentedDefaults).toEqual(['REQUEST_ANALYTICS_RETENTION_DAYS']);
    expect(report.unknownKeys).toEqual([]);
  });

  it('reports unknown keys but allows known env-only settings', () => {
    const report = compareEnvText(
      [
        'ENCRYPTION_KEY=abc',
        'PORT=3001',
        'OLD_FLAG=true',
        'NODE_ENV=production',
        'PROVIDER_DAILY_REQUEST_CAP_GROQ=50',
      ].join('\n'),
      'ENCRYPTION_KEY=your-key\nPORT=3001\n# HOST=::\n',
    );

    expect(report.missingDocumentedDefaults).toEqual([]);
    expect(report.unknownKeys).toEqual(['OLD_FLAG']);
  });

  it('formats a compact, non-fatal warning', () => {
    const lines = formatEnvDriftReport({
      missingDocumentedDefaults: ['REQUEST_ANALYTICS_MAX_ROWS'],
      unknownKeys: ['OLD_FLAG'],
    });

    expect(lines).toEqual([
      '[config] .env check: 1 documented default missing; 1 unrecognised key. Startup continues.',
      '[config]   missing from .env: REQUEST_ANALYTICS_MAX_ROWS',
      '[config]   not in .env.example: OLD_FLAG',
      '[config]   Compare .env.example when you next edit your config.',
    ]);
  });

  it('logs once per formatted line when both files exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-env-drift-'));
    const envPath = path.join(dir, '.env');
    const examplePath = path.join(dir, '.env.example');
    fs.writeFileSync(envPath, 'ENCRYPTION_KEY=abc\nPORT=3001\nOLD_FLAG=true\n');
    fs.writeFileSync(examplePath, 'ENCRYPTION_KEY=your-key\nPORT=3001\nREQUEST_ANALYTICS_MAX_ROWS=100000\n');
    const logger = { warn: vi.fn() };

    const report = warnOnEnvDrift({ envPath, examplePath }, logger);

    expect(report).toEqual({
      missingDocumentedDefaults: ['REQUEST_ANALYTICS_MAX_ROWS'],
      unknownKeys: ['OLD_FLAG'],
    });
    expect(logger.warn).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenNthCalledWith(1, '[config] .env check: 1 documented default missing; 1 unrecognised key. Startup continues.');
  });

  it('stays quiet when .env is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-env-drift-'));
    const logger = { warn: vi.fn() };

    expect(warnOnEnvDrift({
      envPath: path.join(dir, '.env'),
      examplePath: path.join(dir, '.env.example'),
    }, logger)).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
