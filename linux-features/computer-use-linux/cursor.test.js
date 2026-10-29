"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { applyLinuxComputerUseAvatarCursorBridgePatch: patch } = require("../../scripts/patches/impl/computer-use.js");
const current = 'let register=function(e,{addon:t,electronAppPath:r,platform:n=process.platform,resourcesPath:i=process.resourcesPath}={}){if("darwin"===n)try{(t??load({electronAppPath:r??electron.app.getAppPath(),resourcesPath:i})).setRemoteHostedPIPContentComputerUseCursorLocationHandler(e)}catch{return!1}};';
test("current anonymous cursor registration gains Linux bridge and preserves macOS", () => {
  const patched = patch(current);
  assert.notEqual(patched, current);
  assert.equal(patch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
  const calls=[];
  const register = vm.runInNewContext(`${patched};register`, { process: {env:{}}, require: () => {}, load: () => {throw Error("unexpected fallback")} });
  register(() => {}, { platform: "darwin", addon: {setRemoteHostedPIPContentComputerUseCursorLocationHandler: handler => calls.push(handler)} });
  assert.equal(calls.length, 1);
  assert.equal(register(() => {}, { platform: "linux" }), false);
  assert.equal(register(() => {}, { platform: "freebsd" }), undefined);
});
test("cursor registration rejects ambiguous and changed platform owners byte-identically", () => {
  for (const changed of [current + current, current.replace('if("darwin"===n)', 'if("win32"===n)')]) assert.equal(patch(changed), changed);
});

test("enabled cursor bridge rejects partial and duplicate injected state", async t => {
  const { applyMainBundlePatchDescriptors } = require("../../scripts/patches/engine.js");
  const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
  const descriptor = {
    ...require("./patch.js").find(({ id }) => id === "avatar-cursor"),
    featureId: "computer-use-linux", sourceKind: "feature",
  };
  const patched = patch(current);
  assert.notEqual(patched, current);
  const escapedOverride = String.raw`function codexLinuxRegisterComputerUseCursorH\u0061ndler(){return 'overridden'}`;
  const overridden = patched + escapedOverride;
  assert.doesNotThrow(() => new vm.Script(overridden));
  const register = vm.runInNewContext(`${overridden};register`, { process: { env: {} } });
  assert.equal(register(() => {}, { platform: "linux" }), "overridden",
    "the escaped duplicate actually overrides the generated helper");
  const guard = 'if("linux"===n)return codexLinuxRegisterComputerUseCursorHandler(e);';
  for (const [name, damaged] of [
    ["missing dispatch guard", patched.replace(guard, "")],
    ["damaged runtime helper", patched.replace("t.handler=e", "t.handler=null")],
    ["duplicate helper declaration", patched + "function codexLinuxComputerUseCursorComponent(){}"],
    ["escaped helper override", overridden],
    ["escaped partial helper in pristine source", current + escapedOverride],
    ["leading-zero braced helper collision", current + String.raw`function codexLinuxComputerUseCursorC\u{0000000000000000006f}mponent(){}`],
  ]) {
    await t.test(name, () => {
      const report = createPatchReport();
      report.enabledFeatures = ["computer-use-linux"];
      const result = applyMainBundlePatchDescriptors(damaged, [descriptor], {}, report);
      assert.equal(result.patchedSource, damaged, name);
      assert.equal(result.warnings.length, 1, name);
      assert.match(result.warnings[0], /Incomplete Linux avatar cursor bridge/, name);
      assert.notEqual(report.patches[0].status, "already-applied", name);
      assert.equal(enabledFeatureFailuresFromReport(report).length, 1, name);
    });
  }
});
