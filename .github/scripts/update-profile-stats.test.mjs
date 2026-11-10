import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { countCommits, countStars, renderStats, updateStats } from './update-profile-stats.mjs';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const repo = (owner, stars, options = {}) => ({
  owner: { login: owner },
  stargazers_count: stars,
  private: false,
  fork: false,
  ...options,
});
const json = (data, options = {}) => new Response(JSON.stringify(data), options);

test('counts public non-fork repositories across all pages for the requested owner', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (urls.length === 1) {
      return json([
        repo('apotocki', 11),
        repo('apotocki', 50, { fork: true }),
        repo('apotocki', 30, { private: true }),
        repo('someone-else', 20),
      ], { headers: { link: '<https://api.github.com/next>; rel="next"' } });
    }
    return json([repo('APOTOCKI', 4)]);
  };
  assert.equal(await countStars(fetchImpl, 'token', 'apotocki', false), 15);
  assert.match(urls[0], /type=owner&per_page=100&page=1$/);
  assert.match(urls[1], /page=2$/);
});

test('queries commit contributions for exactly the preceding 30 days', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.github.com/graphql');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.variables, {
      login: 'apotocki',
      from: '2026-10-11T12:00:00.000Z',
      to: '2026-11-10T12:00:00.000Z',
    });
    assert.match(body.query, /totalCommitContributions/);
    return json({ data: { user: { contributionsCollection: { totalCommitContributions: 42 } } } });
  };
  assert.equal(await countCommits(fetchImpl, 'token', NOW), 42);
});

test('renders counts and date in the card and accessible title', () => {
  const svg = renderStats(1234, 56, NOW);
  assert.match(svg, /1,234 public stars and 56 commit contributions/);
  assert.match(svg, />1,234<\/text>/);
  assert.match(svg, />56<\/text>/);
  assert.match(svg, /Updated 2026-11-10 UTC/);
});

test('updates the snapshot only after all API requests succeed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'profile-stats-'));
  const outputPath = join(directory, 'stats.svg');
  try {
    await writeFile(outputPath, 'previous snapshot');
    const fetchImpl = async url => {
      if (url.endsWith('/graphql')) {
        return json({ data: { user: { contributionsCollection: { totalCommitContributions: 7 } } } });
      }
      if (url.includes('/orgs/otok-dev/')) return json([repo('otok-dev', 3)]);
      return json([repo('apotocki', 5)]);
    };
    await updateStats({ token: 'token', fetchImpl, now: NOW, outputPath });
    const svg = await readFile(outputPath, 'utf8');
    assert.match(svg, /8 public stars and 7 commit contributions/);

    const failingFetch = async url => {
      if (url.endsWith('/graphql')) return json({ errors: [{ message: 'Unavailable' }] });
      return json([]);
    };
    await assert.rejects(updateStats({ token: 'token', fetchImpl: failingFetch, now: NOW, outputPath }), /Unavailable/);
    assert.equal(await readFile(outputPath, 'utf8'), svg);
  } finally {
    await rm(outputPath, { force: true });
    await rmdir(directory);
  }
});

test('rejects missing credentials, failed requests, and malformed data', async () => {
  await assert.rejects(updateStats({ token: '' }), /GITHUB_TOKEN is required/);
  await assert.rejects(countStars(async () => json({}, { status: 403, statusText: 'Forbidden' }), 'token', 'apotocki', false), /403 Forbidden/);
  await assert.rejects(countStars(async () => json([repo('apotocki', null)]), 'token', 'apotocki', false), /Invalid repository data/);
  await assert.rejects(countCommits(async () => json({ data: { user: null } }), 'token', NOW), /valid commit contribution count/);
});
