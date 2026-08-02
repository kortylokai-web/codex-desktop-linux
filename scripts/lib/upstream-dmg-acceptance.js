"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { sourceInfo } = require("./build-info.js");
const { linuxFeatureManifestMap, linuxFeaturesRoot } = require("./linux-features.js");
const { enabledFeatureFailuresFromReport, optionalDriftFromReport } = require("./patch-report.js");
const { readPatchReport, validatePatchReport } = require("./patch-validation.js");
const { UPSTREAM_DMG_RELEASE_PROFILE } = require("./upstream-dmg-release-profile.js");

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const file = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(file);
  }
}

function readJsonIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readReportResult(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { report: null, error: filePath ? `missing report: ${filePath}` : "report path not provided" };
  }
  try {
    return { report: readPatchReport(filePath), error: null };
  } catch (error) {
    return { report: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function integrityFailures(report) {
  const findings = report?.postPatchIntegrity?.findings;
  if (!Array.isArray(findings) || findings.length === 0) {
    return [];
  }
  return findings.map((finding) => ({
    code: "post-patch-integrity",
    check: "core",
    name: finding.symbol ?? finding.path ?? "post-patch integrity",
    status: "failed",
    reason: finding.reason ?? "Post-patch integrity check failed",
  }));
}

function validationBlockers(check, failures) {
  return failures.map((failure) => {
    const separator = failure.indexOf(": ");
    return {
      code: "required-patch",
      check,
      name: separator < 0 ? failure : failure.slice(0, separator),
      status: "failed",
      reason: failure,
    };
  });
}

function driftWarnings(check, report, excludedNames = new Set()) {
  return optionalDriftFromReport(report)
    .filter((warning) => !excludedNames.has(warning.name))
    .map((warning) => ({
    code: "optional-patch-drift",
    check,
    name: warning.name,
    status: warning.status,
    reason: warning.reason ?? null,
    }));
}

function httpIdentity(metadata) {
  if (metadata == null) {
    return null;
  }
  const normalize = (value) => (
    value == null || value === "" || value === "unknown" || value === "no-etag" ? null : value
  );
  const identity = {
    etag: normalize(metadata.etag),
    lastModified: normalize(metadata.lastModified ?? metadata.last_modified),
    contentLength: normalize(metadata.contentLength ?? metadata.content_length),
  };
  // Content-Length alone is not a stable upstream identity. Require a strong
  // ETag or the validator pair exposed by CDNs that omit ETag.
  if (identity.etag == null && (identity.lastModified == null || identity.contentLength == null)) {
    return null;
  }
  identity.key = crypto
    .createHash("sha256")
    .update(`${identity.lastModified ?? ""}|${identity.etag ?? ""}|${identity.contentLength ?? ""}`)
    .digest("hex");
  return identity;
}

function buildDmgInfo({ dmgPath, metadata, buildInfo }) {
  const upstreamDmg = buildInfo?.upstreamDmg ?? {};
  return {
    path: dmgPath ? path.resolve(dmgPath) : metadata?.path ?? null,
    url: metadata?.url ?? null,
    sha256: dmgPath && fs.existsSync(dmgPath) ? sha256File(dmgPath) : metadata?.sha256 ?? upstreamDmg.sha256 ?? null,
    sizeBytes: dmgPath && fs.existsSync(dmgPath) ? fs.statSync(dmgPath).size : metadata?.sizeBytes ?? metadata?.size_bytes ?? upstreamDmg.sizeBytes ?? null,
    appVersion: upstreamDmg.appVersion ?? metadata?.appVersion ?? metadata?.app_version ?? null,
    httpIdentity: httpIdentity(metadata),
  };
}

function candidateEnabledLinuxFeatureIds(coreReport, buildInfo) {
  return [...new Set([
    ...(Array.isArray(coreReport?.enabledFeatures) ? coreReport.enabledFeatures : []),
    ...(Array.isArray(buildInfo?.linuxFeatures?.enabled) ? buildInfo.linuxFeatures.enabled : []),
  ].filter((feature) => typeof feature === "string"))]
    .sort((left, right) => left.localeCompare(right));
}

function sameMultiset(expected, actual) {
  if (!Array.isArray(actual) || expected.length !== actual.length) {
    return false;
  }
  const counts = new Map();
  for (const value of expected) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  for (const value of actual) {
    const count = counts.get(value);
    if (count == null || count === 0) {
      return false;
    }
    counts.set(value, count - 1);
  }
  return [...counts.values()].every((count) => count === 0);
}

function linuxFeatureCapabilityBlockers(coreReport, buildInfo, options) {
  const enabledFeatureIds = candidateEnabledLinuxFeatureIds(coreReport, buildInfo);
  if (enabledFeatureIds.length === 0 && buildInfo == null) {
    return [];
  }

  const repoRoot = options.repoRoot ?? process.cwd();
  const featuresRoot = linuxFeaturesRoot({
    featuresRoot: options.featuresRoot ?? path.join(repoRoot, "linux-features"),
  });
  let manifests;
  try {
    manifests = linuxFeatureManifestMap({ featuresRoot });
  } catch (error) {
    return [{
      code: "linux-feature-capabilities",
      check: "linux-features",
      name: "manifest",
      status: "failed",
      reason: `Could not resolve candidate Linux feature manifests: ${error instanceof Error ? error.message : String(error)}`,
    }];
  }

  const expected = [];
  const blockers = [];
  for (const featureId of enabledFeatureIds) {
    const feature = manifests.get(featureId);
    if (feature == null) {
      blockers.push({
        code: "linux-feature-capabilities",
        check: `feature:${featureId}`,
        name: featureId,
        status: "failed",
        reason: `Candidate enabled Linux feature '${featureId}' has no manifest in ${featuresRoot}`,
      });
      continue;
    }
    expected.push(...feature.manifest.capabilities);
  }
  if (blockers.length > 0) {
    return blockers;
  }

  if (sameMultiset(expected, buildInfo?.linuxCapabilities)) {
    return [];
  }
  return [{
    code: "linux-feature-capabilities",
    check: enabledFeatureIds.length === 0 ? "linux-features" : `feature:${enabledFeatureIds.join(",")}`,
    name: "linuxCapabilities",
    status: "failed",
    reason: `Candidate Linux capabilities must exactly match enabled feature declarations: expected ${JSON.stringify(expected)}; received ${JSON.stringify(buildInfo?.linuxCapabilities)}`,
  }];
}

function evaluateUpstreamDmg(options) {
  const profile = options.profile ?? UPSTREAM_DMG_RELEASE_PROFILE;
  let metadata = null;
  let buildInfo = null;
  const inputErrors = [];
  try {
    metadata = readJsonIfPresent(options.metadataPath);
  } catch (error) {
    inputErrors.push(`invalid DMG metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    buildInfo = readJsonIfPresent(options.buildInfoPath);
  } catch (error) {
    inputErrors.push(`invalid build metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
  const core = readReportResult(options.coreReportPath);
  const blockers = [];
  const warnings = [];
  const inconclusiveReasons = [...inputErrors];

  if (core.report) {
    const enabledFeatureFailures = profile.rejectEnabledFeatureDrift
      ? enabledFeatureFailuresFromReport(core.report)
      : [];
    const enabledFeatureFailureNames = new Set(enabledFeatureFailures.map((failure) => failure.name));
    blockers.push(...validationBlockers("core", validatePatchReport(core.report, profile.corePatchProfile)));
    blockers.push(...integrityFailures(core.report));
    blockers.push(...enabledFeatureFailures.map((failure) => ({
      code: "enabled-feature-drift",
      check: `feature:${failure.featureId}`,
      name: failure.name,
      status: failure.status,
      reason: failure.reason ?? `Enabled feature ${failure.featureId} did not apply cleanly`,
    })));
    warnings.push(...driftWarnings("core", core.report, enabledFeatureFailureNames));
  } else {
    inconclusiveReasons.push(core.error);
  }
  blockers.push(...linuxFeatureCapabilityBlockers(core.report, buildInfo, options));

  if (options.buildStatus !== "success") {
    inconclusiveReasons.push(`candidate build status: ${options.buildStatus ?? "unknown"}`);
  }

  const dmg = buildDmgInfo({ dmgPath: options.dmgPath, metadata, buildInfo });
  if (!dmg.sha256) {
    inconclusiveReasons.push("DMG fingerprint is unavailable");
  }
  const verdict = blockers.length > 0
    ? "rejected"
    : inconclusiveReasons.length > 0
      ? "inconclusive"
      : warnings.length > 0
        ? "accepted_with_warnings"
        : "accepted";
  const discoveredSource = sourceInfo(options.repoRoot ?? process.cwd());
  const source = buildInfo?.source ?? (discoveredSource.commit == null ? null : discoveredSource);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile: profile.id,
    verdict,
    dmg,
    source,
    checks: {
      build: { status: options.buildStatus ?? "unknown" },
      patchReport: {
        status: core.report ? "completed" : "missing",
        reportPath: options.coreReportPath ?? null,
        enabledFeatures: Array.isArray(core.report?.enabledFeatures) ? core.report.enabledFeatures : [],
      },
    },
    blockers,
    warnings,
    inconclusiveReasons: [...new Set(inconclusiveReasons.filter(Boolean))],
    run: {
      id: options.runId ?? null,
      attempt: options.runAttempt ?? null,
      url: options.runUrl ?? null,
      source: options.source ?? "local",
    },
  };
}

function decisionMarkdown(decision) {
  const lines = [
    "## Upstream DMG acceptance",
    "",
    `- Verdict: \`${decision.verdict}\``,
    `- Profile: \`${decision.profile}\``,
    `- DMG SHA-256: \`${decision.dmg.sha256 ?? "unknown"}\``,
    `- App version: \`${decision.dmg.appVersion ?? "unknown"}\``,
    `- Required blockers: \`${decision.blockers.length}\``,
    `- Optional warnings: \`${decision.warnings.length}\``,
  ];
  if (decision.blockers.length > 0) {
    lines.push("", "### Blockers", ...decision.blockers.map((item) => `- ${item.check}: ${item.reason}`));
  }
  if (decision.warnings.length > 0) {
    lines.push("", "### Optional drift", ...decision.warnings.map((item) => `- ${item.check}: ${item.name} (${item.status})`));
  }
  if (decision.inconclusiveReasons.length > 0) {
    lines.push("", "### Inconclusive reasons", ...decision.inconclusiveReasons.map((reason) => `- ${reason}`));
  }
  return `${lines.join("\n")}\n`;
}

module.exports = {
  decisionMarkdown,
  evaluateUpstreamDmg,
  httpIdentity,
};
