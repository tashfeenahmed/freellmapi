import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const yaml = createRequire(import.meta.url)('js-yaml');
const here = dirname(fileURLToPath(import.meta.url));
type Step = { name?: string; if?: string; run?: string; shell?: string };
const workflow = yaml.load(readFileSync(resolve(here, '../../../.github/workflows/desktop-release.yml'), 'utf8'));
const steps: Step[] = workflow.jobs.build.steps;
const mitigation = steps.find(step => step.name === 'Use TCP for Apple notarization on Intel macOS')!;

describe('Intel notarization network workaround', () => {
  it('only applies to signed Intel builds, before app and DMG notarization', () => {
    expect(mitigation.if).toBe("matrix.os == 'macos-15-intel' && steps.maccreds.outputs.signed == 'true'");
    expect(mitigation.shell).toBe('bash');
    const index = steps.indexOf(mitigation);
    expect(index).toBeGreaterThan(steps.findIndex(step => step.name === 'Validate macOS signing credentials'));
    expect(index).toBeLessThan(steps.findIndex(step => step.name === 'Package installer'));
    expect(index).toBeLessThan(steps.findIndex(step => step.name === 'Notarize and staple the DMG'));
    const credentials = steps.find(step => step.name === 'Validate macOS signing credentials')!;
    expect(credentials.if).toContain("startsWith(github.ref, 'refs/tags/')");
  });

  it('does not bypass notarization, ticket validation, Gatekeeper or metadata verification', () => {
    const notarize = steps.find(step => step.name === 'Notarize and staple the DMG')!;
    expect(notarize.run).toContain('xcrun notarytool submit');
    expect(notarize.run).toContain('--wait --timeout 30m');
    expect(notarize.run).toContain('xcrun stapler staple');
    expect(notarize.run).toContain('xcrun stapler validate');
    expect(notarize.run).toContain('spctl -a -vv -t install');
    expect(notarize.run).toContain('refresh-mac-update-metadata.mjs');
    expect(workflow.jobs['macos-release'].needs).toBe('build');
    expect(workflow.jobs.publish.needs).toEqual(['build', 'macos-release']);
  });

  // The actual workflow shell is exercised with a fake sudo/pfctl. This never
  // changes the test host firewall or needs administrator/network access.
  describe.skipIf(process.platform === 'win32')('shell execution', () => {
    function execute(failure = '') {
      const dir = mkdtempSync(join(tmpdir(), 'notarization-network-test-'));
      const log = join(dir, 'commands');
      const rules = join(dir, 'rules');
      try {
        writeFileSync(join(dir, 'sudo'), `#!/bin/sh
printf '%s\\n' "$*" >> "$PFCTL_TEST_LOG"
[ "$1" = pfctl ] || exit 99
case "$2" in
  -f) cat > "$PFCTL_TEST_RULES"; [ "$PFCTL_TEST_FAIL" != load ] || exit 1 ;;
  -E) [ "$PFCTL_TEST_FAIL" != enable ] || exit 1 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
        const result = spawnSync('bash', ['-c', mitigation.run!], {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PFCTL_TEST_LOG: log, PFCTL_TEST_RULES: rules, PFCTL_TEST_FAIL: failure },
          encoding: 'utf8', timeout: 5000,
        });
        if (result.error) throw result.error;
        return { status: result.status, commands: readFileSync(log, 'utf8'), rules: readFileSync(rules, 'utf8') };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('blocks only UDP 443, then enables PF, leaving TCP HTTPS available', () => {
      expect(execute()).toEqual({ status: 0, commands: 'pfctl -f -\npfctl -E\n', rules: 'block return out quick proto udp from any to any port 443\n' });
    });

    it('stops if loading the rule fails', () => {
      const result = execute('load');
      expect(result.status).toBe(1);
      expect(result.commands).toBe('pfctl -f -\n');
    });

    it('stops if enabling PF fails', () => {
      expect(execute('enable').status).toBe(1);
    });
  });
});
