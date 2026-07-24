#!/usr/bin/env node
/**
 * Real acquisition counts from the registries that deliver Krelvan.
 *
 * These are channel events, not unique people. Never add them into a made-up "users" metric:
 * CI, bots, mirrors and repeated downloads can all be present.
 */

const npmPackage = "krelvan";
const repository = process.env.KRELVAN_GITHUB_REPOSITORY ?? "sreenathmmenon/krelvan";
const jsonOutput = process.argv.includes("--json");
const githubToken = process.env.GITHUB_TOKEN;

async function getJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "krelvan-download-stats",
      ...headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function npmCounts() {
  const periods = ["last-day", "last-week", "last-month"];
  const rows = await Promise.all(periods.map(async (period) => {
    const value = await getJson(`https://api.npmjs.org/downloads/point/${period}/${npmPackage}`);
    return [period, {
      downloads: Number(value.downloads),
      start: String(value.start),
      end: String(value.end),
    }];
  }));
  return Object.fromEntries(rows);
}

async function githubCounts() {
  const headers = githubToken ? { authorization: `Bearer ${githubToken}` } : {};
  const releases = await getJson(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
    headers,
  );
  const assets = releases.flatMap((release) =>
    (release.assets ?? []).map((asset) => ({
      release: release.tag_name,
      name: asset.name,
      downloads: Number(asset.download_count),
      size: Number(asset.size),
      createdAt: asset.created_at,
    })),
  );
  return {
    releases: releases.length,
    assets,
    assetDownloads: assets.reduce((sum, asset) => sum + asset.downloads, 0),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  warning: "Channel downloads are not unique customers and must not be summed into a users metric.",
  npm: null,
  github: null,
  unavailable: [],
};

try { report.npm = await npmCounts(); }
catch (error) { report.unavailable.push({ channel: "npm", error: String(error) }); }

try { report.github = await githubCounts(); }
catch (error) { report.unavailable.push({ channel: "github-releases", error: String(error) }); }

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Krelvan download channels — ${report.generatedAt}`);
  console.log("Counts are downloads/pulls, not unique customers.\n");
  if (report.npm) {
    console.log("npm package");
    for (const [period, value] of Object.entries(report.npm)) {
      console.log(`  ${period.padEnd(10)} ${String(value.downloads).padStart(8)}  ${value.start} → ${value.end}`);
    }
  }
  if (report.github) {
    console.log(`\nGitHub release assets (${report.github.releases} releases)`);
    if (report.github.assets.length === 0) console.log("  no uploaded release assets yet");
    for (const asset of report.github.assets) {
      console.log(`  ${String(asset.downloads).padStart(8)}  ${asset.release} / ${asset.name}`);
    }
  }
  for (const missing of report.unavailable) {
    console.log(`\n${missing.channel}: unavailable (${missing.error})`);
  }
}

if (report.npm === null && report.github === null) process.exitCode = 1;
