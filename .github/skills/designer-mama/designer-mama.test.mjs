import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const skillDir = dirname(fileURLToPath(import.meta.url));
const skillPath = join(skillDir, 'SKILL.md');
const promptPath = join(skillDir, '..', '..', 'prompts', 'designer-mama.prompt.md');

const skill = readFileSync(skillPath, 'utf8');
const prompt = readFileSync(promptPath, 'utf8');

test('designer-mama skill and activation prompt exist with expected frontmatter', () => {
  assert.match(skill, /^---\nname: designer-mama\n/);
  assert.match(skill, /description: .*Creative Director and Lead Graphic Designer/);
  assert.match(prompt, /^---\ndescription: .*Designer Mama/);
  assert.match(prompt, /Activate the `designer-mama` skill/);
});

test('designer-mama encodes the Prosar Digital brand constants and output default', () => {
  assert.match(skill, /#0A0A0A/);
  assert.match(skill, /#CCEE00/);
  assert.match(skill, /#FFFFFF/);
  assert.match(skill, /1080x1080 px/);
  assert.match(skill, /high-quality JPEG/);
  assert.match(skill, /1080x1350 px/);
  assert.match(skill, /1640x624 px/);
});

test('designer-mama documents role boundaries and approval gates', () => {
  assert.match(skill, /\/marketer-mama/);
  assert.match(skill, /\/content-mama/);
  assert.match(skill, /\/poster-mama/);
  assert.match(skill, /\/custom-web-man/);
  assert.match(skill, /\/ytcontentmama/);
  assert.match(skill, /\/prosarteam/);
  assert.match(skill, /Page connection/);
  assert.match(skill, /publishing or scheduling/);
  assert.match(skill, /live-content edits or deletion/);
  assert.match(skill, /ad spend or ad launch/);
  assert.match(skill, /brand-identity or logo redesign/);
  assert.match(skill, /irreversible repository or production changes/);
});

test('designer-mama includes logo, truth, and Meta security rules', () => {
  assert.match(skill, /Preserve an approved original logo exactly/);
  assert.match(skill, /clearly marked placeholder/);
  assert.match(skill, /Never invent/);
  assert.match(skill, /official OAuth\/Graph API/);
  assert.match(skill, /least-privilege permissions/);
  assert.match(skill, /Never request or accept passwords, codes, cookies, access tokens, or secrets/);
  assert.match(skill, /read-only verification first/);
  assert.match(skill, /official Meta documentation/);
  assert.doesNotMatch(skill, /I am connected to Facebook/i);
});
