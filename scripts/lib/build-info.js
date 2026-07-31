"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  detectLinuxTargetContext,
  linuxTargetSummary,
} = require("./linux-target-context.js");
const {
  enabledLinuxFeatureIds,
  enabledLinuxFeatureInstallPlan,
  loadLinuxFeaturePatchDescriptors,
  linuxFeaturesRoot,
} = require("./linux-features.js");

const EXTERNAL_ATTACHMENT_CAPABILITY =
  "external-app-server-attachment-descriptor-v1";
const EXTERNAL_ATTACHMENT_FEATURE_ID = "shared-app-server-socket";
const EXTERNAL_ATTACHMENT_PATCH_ID =
  "feature:shared-app-server-socket:main-process-shared-app-server-socket";
const EXTERNAL_ATTACHMENT_READER_TARGET =
  ".codex-linux/features/shared-app-server-socket/descriptor-reader.js";
const EXTERNAL_ATTACHMENT_LAUNCHER_HOOK_TARGET =
  ".codex-linux/launcher.d/shared-app-server-socket-socket-env.sh";
const EXTERNAL_ATTACHMENT_MAIN_BUNDLE_PATTERN = /^main(?:-[^.]+)?\.js$/;

function pathStaysInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function assertNoSymbolicLinksInPath(target, label) {
  const absoluteTarget = path.resolve(target);
  const root = path.parse(absoluteTarget).root;
  let current = root;
  for (const part of path.relative(root, absoluteTarget).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} must not contain symbolic links`);
    }
  }
}

function resolveStagedRegularFile(installDir, relativeTarget, label) {
  const installPath = path.resolve(installDir);
  assertNoSymbolicLinksInPath(installPath, "Linux feature install directory");
  const installRoot = fs.realpathSync(installPath);
  const targetPath = path.resolve(installPath, relativeTarget);
  if (!pathStaysInside(installPath, targetPath)) {
    throw new Error(`${label} must stay inside the install directory`);
  }
  assertNoSymbolicLinksInPath(targetPath, label);
  const targetStat = fs.lstatSync(targetPath);
  if (!targetStat.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (!pathStaysInside(installRoot, fs.realpathSync(targetPath))) {
    throw new Error(`${label} must stay inside the install directory`);
  }
  return { targetPath, targetStat };
}

function resolveExtractedMainBundle(extractedAppRoot) {
  const extractedPath = path.resolve(extractedAppRoot);
  assertNoSymbolicLinksInPath(extractedPath, "Extracted app root");
  if (!fs.lstatSync(extractedPath).isDirectory()) {
    throw new Error("Extracted app root must be a directory");
  }
  const extractedRoot = fs.realpathSync(extractedPath);
  const buildDirectory = path.resolve(extractedPath, ".vite", "build");
  if (!pathStaysInside(extractedPath, buildDirectory)) {
    throw new Error("Extracted main bundle directory must stay inside the extracted app root");
  }
  assertNoSymbolicLinksInPath(buildDirectory, "Extracted main bundle directory");
  if (!fs.lstatSync(buildDirectory).isDirectory()) {
    throw new Error("Extracted main bundle directory must be a directory");
  }
  const buildRoot = fs.realpathSync(buildDirectory);
  if (!pathStaysInside(extractedRoot, buildRoot)) {
    throw new Error("Extracted main bundle directory must stay inside the extracted app root");
  }

  const candidates = fs
    .readdirSync(buildDirectory, { withFileTypes: true })
    .filter((entry) => EXTERNAL_ATTACHMENT_MAIN_BUNDLE_PATTERN.test(entry.name));
  if (candidates.length !== 1) {
    throw new Error("Extracted app must contain exactly one main bundle");
  }

  const targetPath = path.resolve(buildDirectory, candidates[0].name);
  if (!pathStaysInside(buildDirectory, targetPath)) {
    throw new Error("Extracted main bundle must stay inside the build directory");
  }
  assertNoSymbolicLinksInPath(targetPath, "Extracted main bundle");
  if (!fs.lstatSync(targetPath).isFile()) {
    throw new Error("Extracted main bundle must be a regular file");
  }
  const realTargetPath = fs.realpathSync(targetPath);
  if (
    !pathStaysInside(buildRoot, realTargetPath)
    || !pathStaysInside(extractedRoot, realTargetPath)
  ) {
    throw new Error("Extracted main bundle must stay inside the extracted app root");
  }
  return targetPath;
}

function stagedFeatureFileMatches(installDir, entry) {
  try {
    const sourceStat = fs.lstatSync(entry.source);
    const { targetPath, targetStat } = resolveStagedRegularFile(
      installDir,
      entry.target,
      "Linux feature staged artifact",
    );
    return sourceStat.isFile()
      && (targetStat.mode & 0o7777) === entry.mode
      && fs.readFileSync(targetPath).equals(fs.readFileSync(entry.source));
  } catch {
    return false;
  }
}

function stagedMainBundleHasCompleteExternalAttachmentTransport(
  extractedAppRoot,
  patchDescriptor,
) {
  try {
    const targetPath = resolveExtractedMainBundle(extractedAppRoot);
    const mainBundle = fs.readFileSync(targetPath, "utf8");
    let warned = false;
    const originalWarn = console.warn;
    console.warn = () => {
      warned = true;
    };
    try {
      return patchDescriptor.apply(mainBundle, {}) === mainBundle && !warned;
    } finally {
      console.warn = originalWarn;
    }
  } catch {
    return false;
  }
}

function externalAttachmentFeatureState({ featuresRoot, installDir, extractedAppRoot }) {
  const enabled = enabledLinuxFeatureIds({ featuresRoot });
  if (!enabled.includes(EXTERNAL_ATTACHMENT_FEATURE_ID)) {
    return { enabled: false, complete: false };
  }

  if (installDir == null) {
    return { enabled: true, complete: false, reason: "install directory is unavailable" };
  }
  if (extractedAppRoot == null) {
    return { enabled: true, complete: false, reason: "extracted app root is unavailable" };
  }

  try {
    const plan = enabledLinuxFeatureInstallPlan({ featuresRoot });
    const reader = plan.resources.find(
      (entry) =>
        entry.id === EXTERNAL_ATTACHMENT_FEATURE_ID
        && entry.target === EXTERNAL_ATTACHMENT_READER_TARGET
        && entry.mode === 0o644,
    );
    const launcherHook = plan.runtimeHooks.find(
      (entry) =>
        entry.id === EXTERNAL_ATTACHMENT_FEATURE_ID
        && entry.key === "launcher"
        && entry.target === EXTERNAL_ATTACHMENT_LAUNCHER_HOOK_TARGET
        && entry.mode === 0o755,
    );
    if (reader == null || launcherHook == null) {
      return { enabled: true, complete: false, reason: "feature install plan is incomplete" };
    }

    const patchDescriptor = loadLinuxFeaturePatchDescriptors({ featuresRoot }).find(
      (entry) =>
        entry.id === EXTERNAL_ATTACHMENT_PATCH_ID
        && entry.phase === "main-bundle"
        && entry.ciPolicy === "required-upstream",
    );
    if (patchDescriptor == null || typeof patchDescriptor.apply !== "function") {
      return { enabled: true, complete: false, reason: "required patch descriptor is unavailable" };
    }

    if (!stagedFeatureFileMatches(installDir, reader)) {
      return { enabled: true, complete: false, reason: "staged descriptor reader does not match the enabled feature" };
    }
    if (!stagedFeatureFileMatches(installDir, launcherHook)) {
      return { enabled: true, complete: false, reason: "staged launcher hook does not match the enabled feature" };
    }
    if (
      !stagedMainBundleHasCompleteExternalAttachmentTransport(extractedAppRoot, patchDescriptor)
    ) {
      return { enabled: true, complete: false, reason: "staged main bundle lacks a complete attachment transport" };
    }
    return { enabled: true, complete: true };
  } catch (error) {
    return {
      enabled: true,
      complete: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function hasCompleteExternalAttachmentFeature(options) {
  return externalAttachmentFeatureState(options).complete;
}

function linuxCapabilities({ featuresRoot, installDir, extractedAppRoot }) {
  const state = externalAttachmentFeatureState({ featuresRoot, installDir, extractedAppRoot });
  if (state.enabled && !state.complete) {
    const error = new Error(
      `Enabled Linux feature '${EXTERNAL_ATTACHMENT_FEATURE_ID}' cannot advertise `
        + `'${EXTERNAL_ATTACHMENT_CAPABILITY}': ${state.reason ?? "incomplete installation"}`,
    );
    error.code = "external-attachment-capability-incomplete";
    throw error;
  }
  return state.complete ? [EXTERNAL_ATTACHMENT_CAPABILITY] : [];
}

function runGit(repoDir, args) {
  const result = childProcess.spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isoTimestamp(env = process.env) {
  const rawEpoch = env.SOURCE_DATE_EPOCH?.trim();
  if (rawEpoch) {
    const epochSeconds = Number(rawEpoch);
    if (Number.isFinite(epochSeconds) && epochSeconds >= 0) {
      return new Date(Math.trunc(epochSeconds) * 1000).toISOString();
    }
  }
  return new Date().toISOString();
}

function sanitizeGitRemoteUrl(remote) {
  if (remote == null) {
    return null;
  }
  const value = String(remote).trim();
  if (value.length === 0 || path.isAbsolute(value) || value.startsWith("./") || value.startsWith("../")) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      return null;
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = "";
      url.password = "";
      return url.toString();
    }
  } catch {
    return value;
  }
  return value;
}

function sanitizeSourceInfo(info) {
  const { sourceInfoPath, ...sanitized } = info;
  void sourceInfoPath;
  sanitized.remote = sanitizeGitRemoteUrl(sanitized.remote);
  sanitized.commitUrl = githubCommitUrl(sanitized.remote, sanitized.commit);
  return sanitized;
}

function githubCommitUrl(remote, commit) {
  const sha = typeof commit === "string" ? commit.trim() : "";
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return null;
  }
  const value = sanitizeGitRemoteUrl(remote);
  if (value == null) {
    return null;
  }

  let ownerAndRepo = null;
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    ownerAndRepo = url.pathname.replace(/^\/+/, "");
  } catch {
    const scpMatch = value.match(/^(?:[^@]+@)?github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
    if (scpMatch) {
      ownerAndRepo = scpMatch[1];
    }
  }

  if (ownerAndRepo == null) {
    return null;
  }
  ownerAndRepo = ownerAndRepo.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(ownerAndRepo)) {
    return null;
  }
  return `https://github.com/${ownerAndRepo}/commit/${sha}`;
}

function parseWrapperVersion(content) {
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^version\s*=\s*"([^"]+)"/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function readWrapperVersion(repoDir) {
  try {
    return parseWrapperVersion(fs.readFileSync(path.join(repoDir, "updater", "Cargo.toml"), "utf8"));
  } catch {
    return null;
  }
}

function sourceInfoFromGit(repoDir, env = process.env) {
  const overrideCommit = env.CODEX_LINUX_SOURCE_COMMIT?.trim();
  const insideWorkTree = runGit(repoDir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!insideWorkTree && !overrideCommit) {
    return null;
  }

  const commit = overrideCommit || runGit(repoDir, ["rev-parse", "HEAD"]);
  const status = runGit(repoDir, ["status", "--porcelain"]);
  const remote = sanitizeGitRemoteUrl(env.CODEX_LINUX_SOURCE_REMOTE?.trim() || runGit(repoDir, ["remote", "get-url", "origin"]));
  return {
    commit,
    shortCommit: commit == null ? null : commit.slice(0, 12),
    version: readWrapperVersion(repoDir),
    branch: env.CODEX_LINUX_SOURCE_BRANCH?.trim() || runGit(repoDir, ["branch", "--show-current"]),
    remote,
    commitUrl: githubCommitUrl(remote, commit),
    describe: env.CODEX_LINUX_SOURCE_DESCRIBE?.trim() || runGit(repoDir, ["describe", "--always", "--dirty", "--tags"]),
    dirty: status != null && status.length > 0,
  };
}

function sourceInfo(repoDir, env = process.env) {
  const sourceInfoPath = path.join(repoDir, ".codex-linux", "source-info.json");
  const staged = readJsonFile(sourceInfoPath);
  if (staged != null && typeof staged === "object" && !Array.isArray(staged)) {
    return {
      ...sanitizeSourceInfo(staged),
      version: staged.version ?? readWrapperVersion(repoDir),
      provenance: staged.provenance ?? "packaged-update-builder",
    };
  }
  const gitInfo = sourceInfoFromGit(repoDir, env);
  if (gitInfo != null) {
    return { ...gitInfo, provenance: "git" };
  }
  return {
    commit: env.CODEX_LINUX_SOURCE_COMMIT?.trim() || null,
    shortCommit: env.CODEX_LINUX_SOURCE_COMMIT?.trim()?.slice(0, 12) || null,
    version: readWrapperVersion(repoDir),
    branch: env.CODEX_LINUX_SOURCE_BRANCH?.trim() || null,
    remote: sanitizeGitRemoteUrl(env.CODEX_LINUX_SOURCE_REMOTE?.trim() || null),
    commitUrl: githubCommitUrl(env.CODEX_LINUX_SOURCE_REMOTE?.trim() || null, env.CODEX_LINUX_SOURCE_COMMIT?.trim() || null),
    describe: env.CODEX_LINUX_SOURCE_DESCRIBE?.trim() || null,
    dirty: null,
    provenance: "unknown",
  };
}

function packageProfile(target) {
  const id = target.distro.id;
  const ids = new Set([id, ...target.distro.idLike]);
  const versionMajor = target.distro.versionMajor;

  if (ids.has("nixos") || ids.has("nix")) {
    return {
      id: "nix",
      label: "NixOS / Nix",
      packageManager: "flake",
      format: "runnable directly",
      notes: "nix run github:ilysenko/codex-desktop-linux",
    };
  }
  if (["debian", "ubuntu", "pop", "linuxmint", "elementary"].some((value) => ids.has(value))) {
    return {
      id: "debian-family",
      label: "Debian / Ubuntu / Pop!_OS / Mint / Elementary",
      packageManager: "apt",
      format: ".deb",
      notes: "Managed Node.js runtime is bundled; no distro Node.js package is required",
    };
  }
  if (target.atomic && ids.has("fedora")) {
    return {
      id: "fedora-atomic",
      label: "Fedora Atomic Desktop",
      packageManager: "rpm-ostree",
      format: ".rpm",
      notes: "Native packages are layered with rpm-ostree instead of installed with dnf",
    };
  }
  if (id === "fedora") {
    return {
      id: versionMajor != null && versionMajor < 41 ? "fedora-pre-41" : "fedora-41-plus",
      label: versionMajor != null && versionMajor < 41 ? "Fedora < 41" : "Fedora 41+",
      packageManager: versionMajor != null && versionMajor < 41 ? "dnf" : "dnf5",
      format: ".rpm",
      notes: "",
    };
  }
  if (["opensuse", "suse", "sles"].some((value) => ids.has(value))) {
    return {
      id: "opensuse-family",
      label: "openSUSE Tumbleweed / Leap",
      packageManager: "zypper",
      format: ".rpm",
      notes: "Uses zypper --no-gpg-checks install for the local rebuild",
    };
  }
  if (["arch", "archlinux", "manjaro", "endeavouros"].some((value) => ids.has(value))) {
    return {
      id: "arch-family",
      label: "Arch / Manjaro / EndeavourOS",
      packageManager: "pacman",
      format: ".pkg.tar.zst",
      notes: "",
    };
  }
  return {
    id: "other-linux",
    label: "Atomic desktops / other Linux distros",
    packageManager: "none",
    format: ".AppImage",
    notes: "Local self-build only; no bundled auto-updater",
  };
}

function sha256File(filePath) {
  const crypto = require("node:crypto");
  const hasher = crypto.createHash("sha256");
  hasher.update(fs.readFileSync(filePath));
  return hasher.digest("hex");
}

function appBundleVersion(appDir) {
  const infoPath = path.join(appDir, "Contents", "Info.plist");
  if (!fs.existsSync(infoPath)) {
    return null;
  }
  const result = childProcess.spawnSync(
    "python3",
    ["-c", "import plistlib,sys; p=plistlib.load(open(sys.argv[1],'rb')); print(p.get('CFBundleShortVersionString') or p.get('CFBundleVersion') or '')", infoPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0) {
    return null;
  }
  const version = result.stdout.trim();
  return version.length > 0 ? version : null;
}

function linuxTargetInfo(target) {
  return {
    summary: linuxTargetSummary(target),
    distro: target.distro,
    packageFormat: target.packageFormat,
    packageManager: target.packageManager,
    arch: target.arch,
    desktop: target.desktop,
    sessionType: target.sessionType,
    wayland: target.wayland,
    x11: target.x11,
    atomic: target.atomic,
  };
}

function buildInfo(options) {
  const repoDir = path.resolve(options.repoDir);
  const installDir = options.installDir == null ? null : path.resolve(options.installDir);
  const extractedAppRoot =
    options.extractedAppRoot == null ? null : path.resolve(options.extractedAppRoot);
  const dmgPath = path.resolve(options.dmgPath);
  const appDir = path.resolve(options.appDir);
  const featuresRoot = linuxFeaturesRoot({ featuresRoot: options.featuresRoot });
  const env = options.env ?? process.env;
  const target = options.linuxTarget ?? detectLinuxTargetContext();
  return {
    schemaVersion: 1,
    generatedAt: isoTimestamp(env),
    appIdentity: {
      id: options.appId,
      displayName: options.appDisplayName,
    },
    upstreamDmg: {
      fileName: path.basename(dmgPath),
      sizeBytes: fs.statSync(dmgPath).size,
      sha256: sha256File(dmgPath),
      appVersion: appBundleVersion(appDir),
    },
    electronVersion: options.electronVersion,
    source: sourceInfo(repoDir, env),
    linuxTarget: linuxTargetInfo(target),
    packageProfile: packageProfile(target),
    linuxFeatures: {
      enabled: enabledLinuxFeatureIds({ featuresRoot }),
    },
    linuxCapabilities: linuxCapabilities({ featuresRoot, installDir, extractedAppRoot }),
  };
}

function writeBuildInfo(options) {
  const info = buildInfo(options);
  for (const outputPath of options.outputPaths) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  }
  return info;
}

function main() {
  const [
    repoDir,
    installDir,
    dmgPath,
    appDir,
    extractedAppRoot,
    electronVersion,
    appId,
    appDisplayName,
  ] = process.argv.slice(2);
  if (
    [
      repoDir,
      installDir,
      dmgPath,
      appDir,
      extractedAppRoot,
      electronVersion,
      appId,
      appDisplayName,
    ].some((value) => !value)
  ) {
    console.error(
      "Usage: build-info.js <repo-dir> <install-dir> <dmg-path> <app-dir> "
        + "<extracted-app-root> <electron-version> <app-id> <app-display-name>",
    );
    process.exit(1);
  }
  writeBuildInfo({
    repoDir,
    installDir,
    dmgPath,
    appDir,
    extractedAppRoot,
    electronVersion,
    appId,
    appDisplayName,
    outputPaths: [
      path.join(installDir, "resources", "codex-linux-build-info.json"),
      path.join(installDir, ".codex-linux", "build-info.json"),
    ],
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  EXTERNAL_ATTACHMENT_CAPABILITY,
  EXTERNAL_ATTACHMENT_FEATURE_ID,
  buildInfo,
  githubCommitUrl,
  hasCompleteExternalAttachmentFeature,
  isoTimestamp,
  linuxCapabilities,
  packageProfile,
  sanitizeGitRemoteUrl,
  sourceInfo,
  sourceInfoFromGit,
  writeBuildInfo,
};
