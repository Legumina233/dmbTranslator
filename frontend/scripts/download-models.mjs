#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  CHECKSUM_ASSET,
  DEFAULT_MANIFEST,
  DEFAULT_MODEL_DIR,
  DEFAULT_REPO,
  collectModelAssets,
  assetNameFromModelUrl,
  fileExists,
  normalizeModelTag,
  parseChecksumText,
  parseCliArgs,
  sha256File,
} from "./model-release-assets.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLICATION_POLICY = "packages/model-manifest/publication-policy.json";

/**
 * 读取模型发布策略。文件缺失/损坏时返回 null —— 闸门是"有则检查"，
 * 不因为策略文件本身出问题就阻断下载。
 */
async function loadPublicationPolicy() {
  try {
    return JSON.parse(await readFile(resolveFromRoot(PUBLICATION_POLICY), "utf8"));
  } catch {
    return null;
  }
}

/** 把 { <key>: { path, status, reason } } 反过来按文件名索引。 */
function policyByAssetName(policy) {
  const map = new Map();
  for (const entry of Object.values(policy?.assets ?? {})) {
    if (entry && typeof entry.path === "string") {
      map.set(entry.path, entry);
    }
  }
  return map;
}

/**
 * 按发布策略检查待下载资产。
 *
 * 默认是**警告而非阻断**：blocked 的两个模型（气泡检测与去字修复）是运行时必需的，
 * 阻断会让扩展直接不可用。而且这里做的是「下载到本地自用」，风险性质不同于「分发」——
 * 真正防止分发的闸门在 scripts/upload-r2-models.mjs（assertModelPublicationApproved），
 * 模型文件本来也被 .gitignore 排除在仓库之外。
 *
 * 需要严格模式时用 --strict-license（适合维护者在发布前自查）：
 * - blocked：许可证冲突或未决，strict 下抛错
 * - conditional：可以分发但附带条件（如须提供源码获取途径），只提示不阻断
 */
function enforcePublicationPolicy(assets, policyMap, { strict }) {
  const blocked = [];
  const conditional = [];

  for (const asset of assets) {
    const entry = policyMap.get(asset);
    if (!entry) continue;
    if (entry.status === "blocked") blocked.push(entry);
    else if (entry.status === "conditional") conditional.push(entry);
  }

  if (conditional.length > 0) {
    console.warn("");
    console.warn(`提示：${conditional.length} 个资产为 conditional（可分发但附带条件）：`);
    for (const entry of conditional) {
      console.warn(`  - ${entry.path}: ${entry.reason}`);
    }
  }

  if (blocked.length === 0) return;

  console.warn("");
  console.warn(
    strict
      ? `拒绝下载：${blocked.length} 个模型资产的发布策略为 blocked（--strict-license）：`
      : `警告：${blocked.length} 个模型资产的许可证状态未决，本地自用可继续，但不得再分发：`,
  );
  for (const entry of blocked) {
    console.warn(`  - ${entry.path}`);
    console.warn(`      ${entry.reason}`);
  }

  if (strict) {
    throw new Error(
      "blocked 资产的许可证状态未决。发布分发前必须先解决冲突或替换模型；" +
        "确认只是本地自用可去掉 --strict-license。",
    );
  }

  console.warn("");
  console.warn("仅供本地使用，请勿将这些文件随仓库或 Release 分发。");
}

function usage() {
  console.log(`Usage: node scripts/download-models.mjs [version] [options]

Downloads model assets listed in public/models/models.json from a models-* GitHub Release.

Version:
  latest                 Find the newest models-* release (default)
  0.4.0 | v0.4.0         Normalized to models-v0.4.0
  models-v0.4.0          Used as-is

Options:
  --repo=<owner/name>    GitHub repository (default: ${DEFAULT_REPO})
  --manifest=<path>      Model manifest (default: ${DEFAULT_MANIFEST})
  --dest=<path>          Download directory (default: ${DEFAULT_MODEL_DIR})
  --force                Re-download existing files
  --use-verified-existing
                         Skip network when every existing asset matches models.json size/SHA-256
  --dry-run              Print what would be downloaded
  --strict-license       Fail instead of warn when a model asset's publication policy
                         status is "blocked" (default: warn and continue). Blocked assets
                         have unresolved license conflicts or missing provenance records —
                         read packages/model-manifest/publication-policy.json before
                         redistributing them.
  --help                 Show this help
`);
}

function resolveFromRoot(path) {
  return resolve(ROOT, path);
}

function githubHeaders(extra = {}) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    "Accept": "application/vnd.github+json",
    "User-Agent": "dmbTranslator-model-scripts",
    ...(token ? { "Authorization": `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function resolveLatestModelTag(repo) {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    throw new Error(`Failed to list releases: ${response.status} ${response.statusText}`);
  }
  const releases = await response.json();
  const release = releases.find(
    (item) => typeof item.tag_name === "string" && item.tag_name.startsWith("models-"),
  );
  if (!release) {
    throw new Error(`No models-* release found in ${repo}`);
  }
  return release.tag_name;
}

async function fetchTextIfExists(url) {
  const response = await fetch(url, {
    headers: githubHeaders({ "Accept": "text/plain,application/octet-stream,*/*" }),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function downloadFile(url, targetPath) {
  const tempPath = `${targetPath}.download-${process.pid}.tmp`;
  const response = await fetch(url, { headers: githubHeaders({ "Accept": "application/octet-stream" }) });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error(`No response body for ${url}`);
  }
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function verifyChecksum(filePath, name, checksums) {
  const expected = checksums.get(name);
  if (!expected) {
    return;
  }
  const actual = await sha256File(filePath);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
}

async function existingAssetsMatchManifest(manifestPath, destDir) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const model of Object.values(manifest.models ?? {})) {
    for (const [urlKey, sizeKey, hashKey] of [
      ["url", "size", "sha256"],
      ["dictUrl", "dictSize", "dictSha256"],
    ]) {
      const url = model?.[urlKey];
      if (typeof url !== "string" || !url) continue;
      const expectedSize = model?.[sizeKey];
      const expectedHash = model?.[hashKey];
      if (!Number.isFinite(expectedSize) || typeof expectedHash !== "string") return false;
      const path = join(destDir, assetNameFromModelUrl(url));
      if (!await fileExists(path) || (await stat(path)).size !== expectedSize) return false;
      if (await sha256File(path) !== expectedHash.toLowerCase()) return false;
    }
  }
  return true;
}

async function main() {
  const { options, positionals } = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const repo = String(options.repo ?? DEFAULT_REPO);
  const manifestPath = resolveFromRoot(String(options.manifest ?? DEFAULT_MANIFEST));
  const destDir = resolveFromRoot(String(options.dest ?? DEFAULT_MODEL_DIR));
  const force = options.force === true;
  const useVerifiedExisting = options["use-verified-existing"] === true;
  const dryRun = options["dry-run"] === true;
  const strictLicense = options["strict-license"] === true;
  const requestedTag = positionals[0] ?? process.env.MODEL_RELEASE_TAG ?? "latest";

  let tag = normalizeModelTag(requestedTag);
  if (tag === "latest") {
    tag = await resolveLatestModelTag(repo);
  }

  const assets = await collectModelAssets(manifestPath);
  enforcePublicationPolicy(assets, policyByAssetName(await loadPublicationPolicy()), {
    strict: strictLicense,
  });
  const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;

  console.log(`Model release: ${repo}/${tag}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Destination: ${destDir}`);
  for (const asset of assets) {
    console.log(`  - ${asset}`);
  }

  if (dryRun) {
    return;
  }

  await mkdir(destDir, { recursive: true });

  if (!force && useVerifiedExisting && await existingAssetsMatchManifest(manifestPath, destDir)) {
    console.log("All existing model assets match models.json; network download skipped.");
    return;
  }

  const checksumText = await fetchTextIfExists(`${baseUrl}/${CHECKSUM_ASSET}`);
  const checksums = checksumText ? parseChecksumText(checksumText) : new Map();
  if (checksumText) {
    await writeFile(join(destDir, CHECKSUM_ASSET), checksumText, "utf8");
    console.log(`Saved ${CHECKSUM_ASSET}`);
  } else {
    console.log(`${CHECKSUM_ASSET} not found; downloads will not be checksum verified`);
  }

  for (const asset of assets) {
    const targetPath = join(destDir, asset);
    if (!force && await fileExists(targetPath)) {
      await verifyChecksum(targetPath, asset, checksums);
      console.log(`Skip existing ${asset}`);
      continue;
    }

    console.log(`Download ${asset}`);
    await downloadFile(`${baseUrl}/${asset}`, targetPath);
    await verifyChecksum(targetPath, asset, checksums);
  }

  console.log("Model download complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
