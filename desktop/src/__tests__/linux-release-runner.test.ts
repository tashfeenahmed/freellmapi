import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const yaml = createRequire(import.meta.url)('js-yaml');

describe('Linux installer runner compatibility', () => {
  it('pins native packaging to Ubuntu 24.04 without dropping package formats', () => {
    const workflowPath = fileURLToPath(new URL('../../../.github/workflows/desktop-release.yml', import.meta.url));
    const workflow = yaml.load(readFileSync(workflowPath, 'utf8')) as {
      jobs: { build: { strategy: { matrix: { include: Array<{ os: string; artifact: string; ebArgs: string; glob: string }> } } } };
    };
    const linux = workflow.jobs.build.strategy.matrix.include.find((entry) => entry.artifact === 'linux-installer');

    expect(linux?.os).toBe('ubuntu-24.04');
    expect(linux?.ebArgs).toBe('--linux --x64');
    for (const artifact of ['*.AppImage', '*.tar.xz', '*.deb', '*.rpm', 'latest-linux.yml']) {
      expect(linux?.glob).toContain(`desktop/dist-electron/${artifact}`);
    }
  });
});
