import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com';
const LOGIN = 'apotocki';
const ORGANIZATION = 'otok-dev';
const DAY_MS = 24 * 60 * 60 * 1000;

async function request(fetchImpl, token, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} (${url})`);
  }
  return response;
}

export async function countStars(fetchImpl, token, owner, isOrganization) {
  const resource = isOrganization ? `orgs/${owner}/repos` : `users/${owner}/repos`;
  const type = isOrganization ? 'public' : 'owner';
  let page = 1;
  let stars = 0;

  while (true) {
    const url = `${API}/${resource}?type=${type}&per_page=100&page=${page}`;
    const response = await request(fetchImpl, token, url);
    const repositories = await response.json();
    if (!Array.isArray(repositories)) {
      throw new Error(`Unexpected repository list for ${owner}`);
    }

    for (const repository of repositories) {
      if (typeof repository.private !== 'boolean' || typeof repository.fork !== 'boolean' ||
          typeof repository.owner?.login !== 'string' ||
          !Number.isSafeInteger(repository.stargazers_count) || repository.stargazers_count < 0) {
        throw new Error(`Invalid repository data for ${owner}`);
      }
      if (!repository.private && !repository.fork &&
          repository.owner.login.toLowerCase() === owner.toLowerCase()) {
        stars += repository.stargazers_count;
      }
    }

    if (!response.headers.get('link')?.match(/<[^>]+>;\s*rel="next"/)) {
      return stars;
    }
    page += 1;
  }
}

export async function countCommits(fetchImpl, token, now) {
  const from = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const to = now.toISOString();
  const response = await request(fetchImpl, token, `${API}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query ($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
          }
        }
      }`,
      variables: { login: LOGIN, from, to },
    }),
  });
  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(`GitHub GraphQL request failed: ${result.errors.map(error => error.message).join('; ')}`);
  }
  const commits = result.data?.user?.contributionsCollection?.totalCommitContributions;
  if (!Number.isSafeInteger(commits) || commits < 0) {
    throw new Error('GitHub did not return a valid commit contribution count');
  }
  return commits;
}

export function renderStats(stars, commits, now) {
  const starLabel = stars.toLocaleString('en-US');
  const commitLabel = commits.toLocaleString('en-US');
  const date = now.toISOString().slice(0, 10);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="130" viewBox="0 0 600 130" role="img" aria-labelledby="title">
  <title id="title">${starLabel} public stars and ${commitLabel} commit contributions in the last 30 days. Updated ${date} UTC.</title>
  <rect width="600" height="130" rx="12" fill="#102229"/>
  <path d="M28 26 H65" stroke="#44d5c3" stroke-width="3" stroke-linecap="round"/>
  <text x="28" y="62" fill="#f3f6f5" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700">${starLabel}</text>
  <text x="28" y="84" fill="#abd4d0" font-family="Arial, Helvetica, sans-serif" font-size="13">PUBLIC STARS</text>
  <path d="M245 28 V91" stroke="#315158"/>
  <text x="276" y="62" fill="#f3f6f5" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700">${commitLabel}</text>
  <text x="276" y="84" fill="#abd4d0" font-family="Arial, Helvetica, sans-serif" font-size="13">COMMITS / LAST 30 DAYS</text>
  <text x="28" y="112" fill="#9ab5b3" font-family="Arial, Helvetica, sans-serif" font-size="11">Updated ${date} UTC</text>
</svg>
`;
}

export async function updateStats({ token, fetchImpl = fetch, now = new Date(), outputPath = 'assets/profile-stats.svg' }) {
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to fetch GitHub statistics');
  }
  const [personalStars, organizationStars, commits] = await Promise.all([
    countStars(fetchImpl, token, LOGIN, false),
    countStars(fetchImpl, token, ORGANIZATION, true),
    countCommits(fetchImpl, token, now),
  ]);
  await writeFile(outputPath, renderStats(personalStars + organizationStars, commits, now), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  updateStats({ token: process.env.GITHUB_TOKEN }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
