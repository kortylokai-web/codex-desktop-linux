"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const descriptors = require("./patch.js");
const { findMainBundle } = require("../../scripts/patches/lib/assets.js");
const { applyMainBundlePatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");

test("native metadata stays feature-owned without retired core IPC helpers", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../scripts/patches/impl/computer-use.js"), "utf8");
  assert.doesNotMatch(source, /linuxNativeDesktopAppsHelper|applyLinuxNativeDesktopAppsHandlerPatch/);
  const descriptor = descriptors.find(({ id }) => id === "native-applications");
  assert(descriptor);
  assert.equal(descriptor.phase, "main-bundle");
});

test("current signed native metadata factory patches without changing the trusted input", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, () => {
  const main = findMainBundle(process.env.CODEX_SIGNED_EXTRACTED_APP);
  assert(main, "Expected the verified main-process bundle");
  const file = path.join(main.buildDir, main.mainBundle);
  const actual = fs.readFileSync(file, "utf8");
  const patch = descriptors.find(({ id }) => id === "native-applications").apply;
  const patched = patch(actual);
  assert.equal(patched !== actual, true, "Expected the pristine signed contract to change");
  assert.equal(patch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.equal(fs.readFileSync(file, "utf8"), actual);
});

for (const id of ["unified-runtime", "avatar-cursor", "ui-feature", "plugin-gate"]) {
  test(`current signed ${id} patches once and preserves syntax`, { skip: !process.env.CODEX_SIGNED_EXTRACTED_APP }, () => {
    const main = findMainBundle(process.env.CODEX_SIGNED_EXTRACTED_APP);
    const actual = fs.readFileSync(path.join(main.buildDir, main.mainBundle), "utf8");
    const patch = descriptors.find(descriptor => descriptor.id === id).apply;
    const patched = patch(actual);
    assert.equal(patched !== actual, true, "Expected the pristine signed contract to change");
    assert.equal(patch(patched), patched);
    assert.doesNotThrow(() => new vm.Script(patched));
  });
}

test("current signed main descriptors compose and remain idempotent", { skip: !process.env.CODEX_SIGNED_EXTRACTED_APP }, () => {
  const main = findMainBundle(process.env.CODEX_SIGNED_EXTRACTED_APP);
  const original = fs.readFileSync(path.join(main.buildDir, main.mainBundle), "utf8");
  const patches = descriptors.filter(descriptor => descriptor.phase === "main-bundle")
    .map(descriptor => ({ ...descriptor, featureId: "computer-use-linux", sourceKind: "feature" }))
    .sort((a, b) => a.order - b.order);
  const apply = (source, expectedStatus) => {
    const report = createPatchReport();
    report.enabledFeatures = ["computer-use-linux"];
    const result = applyMainBundlePatchDescriptors(source, patches, {}, report);
    assert.deepEqual(enabledFeatureFailuresFromReport(report), []);
    assert.deepEqual(report.patches.map(({ name, status }) => ({ name, status })),
      patches.map(({ id }) => ({ name: id, status: expectedStatus })));
    return result.patchedSource;
  };
  const patched = apply(original, "applied");
  assert.equal(patched !== original, true);
  assert.equal(apply(patched, "already-applied"), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
});

for (const descriptor of descriptors.filter(descriptor => descriptor.phase === "webview-asset")) {
  test(`current signed ${descriptor.id} retains its unique contract`, { skip: !process.env.CODEX_SIGNED_EXTRACTED_APP }, () => {
    const assets = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview/assets");
    const matches = fs.readdirSync(assets).filter(name => descriptor.pattern.test(name))
      .map(name => fs.readFileSync(path.join(assets, name), "utf8"))
      .filter(source => !descriptor.assetMatch || descriptor.assetMatch(source));
    assert.equal(matches.length, 1);
    const source = matches[0];
    const patched = descriptor.apply(source);
    assert.equal(patched !== source, true);
    assert.equal(descriptor.apply(patched), patched);
  });
}
