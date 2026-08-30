/**
 * status: active
 * phase: change-b-group-7-documentation-and-verification
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-08
 * agent_notes: "Exercises the production invariant checker against disposable authoritative-file copies."
 * insights: "Each of the 13 declaring occurrences is independently changed by one ASCII byte and must fail closed."
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const changeRoot = 'openspec/changes/add-gemini-model-fallback-and-rate-limit-recovery';
const files = {
  design: `${changeRoot}/design.md`,
  tasks: `${changeRoot}/tasks.md`,
  geminiSpec: `${changeRoot}/specs/gemini-model-fallback/spec.md`,
  rateLimitSpec: `${changeRoot}/specs/rate-limit-recovery-routing/spec.md`
} as const;

const invariants = [
  {
    label: 'terminal-cap',
    text: 'without splitting a code point or escape sequence',
    counts: { design: 1, tasks: 1, geminiSpec: 0, rateLimitSpec: 1 }
  },
  {
    label: 'backup-fail-fast-final',
    text: 'permission, HTTP 403, billing, unsupported-media, safety, invalid-request, malformed-response, and unknown',
    counts: { design: 1, tasks: 2, geminiSpec: 0, rateLimitSpec: 2 }
  },
  {
    label: 'redaction-inventory',
    text: 'credentials or API keys, authorization headers, data URLs, prompts, paths, file contents, encoded media, or complete or upstream provider bodies',
    counts: { design: 0, tasks: 2, geminiSpec: 0, rateLimitSpec: 1 }
  },
  {
    label: 'http-403-rule',
    text: 'HTTP 403 is unconditionally fail-fast',
    counts: { design: 1, tasks: 1, geminiSpec: 0, rateLimitSpec: 0 }
  }
] as const;

type FileKey = keyof typeof files;
const sourceRoot = path.resolve(process.cwd(), '..');
const checkerPath = path.resolve(process.cwd(), 'scripts/check-canonical-invariants.mjs');
const missingCanonicalSources = Object.values(files)
  .filter(relativePath => !existsSync(path.join(sourceRoot, relativePath)));
const canonicalSourceSkip = missingCanonicalSources.length === 0
  ? false
  : `authoritative OpenSpec sources are not present: ${missingCanonicalSources.join(', ')}`;
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'canonical-invariants-'));

after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

let fixtureSequence = 0;
const createFixture = async (): Promise<string> => {
  const root = path.join(temporaryRoot, `fixture-${fixtureSequence++}`);
  for (const relativePath of Object.values(files)) {
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(sourceRoot, relativePath), destination);
  }
  return root;
};

const runChecker = (root: string, cwd = process.cwd()) => spawnSync(
  process.execPath,
  [checkerPath, '--root', root],
  { cwd, encoding: 'utf8' }
);

const occurrenceOffsets = (content: string, needle: string): number[] => {
  const offsets: number[] = [];
  let offset = 0;
  while (true) {
    const match = content.indexOf(needle, offset);
    if (match === -1) return offsets;
    offsets.push(match);
    offset = match + needle.length;
  }
};

test('pristine fixture passes from an unrelated current directory', {
  skip: canonicalSourceSkip
}, async () => {
  const root = await createFixture();
  const result = runChecker(root, tmpdir());
  assert.equal(result.error, undefined, 'checker must execute');
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('one-byte mutation of every declaring occurrence fails closed', {
  skip: canonicalSourceSkip
}, async () => {
  let cases = 0;
  for (const invariant of invariants) {
    for (const [key, expectedCount] of Object.entries(invariant.counts) as [FileKey, number][]) {
      if (expectedCount === 0) continue;
      const source = await readFile(path.join(sourceRoot, files[key]), 'utf8');
      const offsets = occurrenceOffsets(source, invariant.text);
      assert.equal(offsets.length, expectedCount, `${invariant.label}/${key} source count drifted`);

      for (const offset of offsets) {
        const root = await createFixture();
        const target = path.join(root, files[key]);
        const content = await readFile(target, 'utf8');
        const replacement = content[offset] === 'x' ? 'y' : 'x';
        await writeFile(target, `${content.slice(0, offset)}${replacement}${content.slice(offset + 1)}`);
        const result = runChecker(root);
        assert.equal(result.error, undefined, 'checker must execute');
        assert.equal(result.status, 1, `${invariant.label}/${key}/${offset} unexpectedly passed`);
        cases += 1;
      }
    }
  }
  assert.equal(cases, 13);
});

test('missing files and occurrence-count drift fail closed', {
  skip: canonicalSourceSkip
}, async () => {
  const missingRoot = await createFixture();
  await rm(path.join(missingRoot, files.geminiSpec));
  assert.equal(runChecker(missingRoot).status, 1);

  const extraRoot = await createFixture();
  const target = path.join(extraRoot, files.design);
  const content = await readFile(target, 'utf8');
  await writeFile(target, `${content}\n${invariants[3].text}\n`);
  assert.equal(runChecker(extraRoot).status, 1);
});

test('malformed fixture-root arguments fail closed', () => {
  for (const args of [['--root'], ['--unknown', temporaryRoot], ['--root', temporaryRoot, 'extra']]) {
    const result = spawnSync(process.execPath, [checkerPath, ...args], { encoding: 'utf8' });
    assert.equal(result.error, undefined, 'checker must execute');
    assert.equal(result.status, 1);
  }
});