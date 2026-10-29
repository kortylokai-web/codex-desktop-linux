#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  applyLinuxAppshotAvailabilityPatch,
  applyLinuxAppshotHotkeyPatch,
  applyLinuxAppshotMainProcessPatch,
  descriptors,
  matchesLinuxAppshotAvailabilityContract,
  matchesLinuxAppshotHotkeyContract,
} = require("./patch.js");

function applyPatchTwice(patchFn, source) {
  const once = patchFn(source);
  assert.notEqual(once, source);
  assert.equal(patchFn(once), once);
  return once;
}

function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    callback();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

function appshotAvailabilityAtomBundleFixture() {
  return "async function q1o({scope:e,hostId:t,queryClient:n}){return(await n.ensureQueryData({queryKey:Adn({hostId:t}),queryFn:()=>Mdn(e,t)})).requirements?.allowAppshots!==!1}function J1o(e){return e===`macOS`||e===`windows`}";
}

function appshotMainProcessBundleFixture() {
  return [
    'function send(e,t,r){e.sendInlineMessageForView(t,{requestId:r,type:"computer-use-capture-updated"})}',
    'class Base{}class Capture extends Base{options;abortController=new AbortController;constructor(e){super(),this.options=e}[Symbol.dispose](){this.abortController.abort()}',
    'async getFrontmostWindow(){return this.abortController.signal.aborted?null:"win32"===process.platform?flags().appshotsEnabled?this.options.windowsCaptureNativeBridge?.getFrontmostWindow(this.options.origin,this.abortController.signal)??null:null:macFrontmost()}',
    'async start({animationDestination:e,animationPresentationStyle:t,bundleIdentifier:r,requestId:n}){let{origin:i,settings:s,windowManager:a,requestComputerUseCaptureWorker:o,subscribeComputerUseCaptureWorkerEvent:l,windowsCaptureNativeBridge:c}=this.options;if(this.abortController.signal.aborted)return null;let d=animation(e,t);return null==d?null:capture(d,r,i,n)}}',
    'class Owner{constructor(options){this.options=options;this.settings={}}create(e,m){return{appshotCapture:"darwin"===process.platform&&null!=this.options.requestComputerUseWorker&&null!=this.options.subscribeComputerUseCaptureWorkerEvent||"win32"===process.platform&&null!=this.options.windowsCaptureNativeBridge?new Capture({origin:e,settings:this.settings,windowManager:m,requestComputerUseCaptureWorker:this.options.requestComputerUseWorker,subscribeComputerUseCaptureWorkerEvent:this.options.subscribeComputerUseCaptureWorkerEvent,windowsCaptureNativeBridge:this.options.windowsCaptureNativeBridge}):void 0}}}',
    'globalThis.Owner=Owner;',
  ].join("");
}

function currentAppshotHotkeyMainBundleFixture() {
  return [
    'var Yk=new Set(["cmdorctrl","command","cmd","control","ctrl","alt","option","super"]),Jk=new Set([...Yk,"shift"]);',
    'function zk(e){return e}function Qk(){return null}',
    'function Nk(e,t,n){globalThis.registered={hotkey:e,handlers:t,trigger:n};return{unregister(){}}}',
    'function Lk(e,t=process.platform){return"darwin"===t&&null!=zk(e)}',
    'var Mk=function(e,t,n="press"){var a,b;let c,d;if("darwin"!==process.platform)return null;let r=zk(e)??Qk(e);return r==null?null:Nk(r,t,n)};',
    'var B8=class{configuredHotkey;registration=null;windowsCaptureNativeBridgeFailed=!1;constructor(e){this.enabled=!0,this.windowsCaptureNativeBridge=null;let a=e.getStored("appshotHotkey");void 0===a?this.configuredHotkey="win32"===process.platform?"DoubleAlt":"DoubleCommand":this.configuredHotkey=a;this.sync()}getState(){return{supported:this.enabled&&("darwin"===process.platform||"win32"===process.platform&&null!=this.windowsCaptureNativeBridge&&!this.windowsCaptureNativeBridgeFailed),configuredHotkey:this.configuredHotkey,isActive:null!=this.registration}}sync(){if(!this.getState().supported||this.configuredHotkey==null)return;this.registration=Mk(this.configuredHotkey,{onPressed(){}})}};',
    'globalThis.hotkeyEligible=Lk;globalThis.modifiers=Jk;globalThis.AppshotHotkeys=B8;globalThis.appshotHotkeyState="appshot-hotkey-state";',
  ].join("");
}

for (const location of ["installed", "cache", "retired only"]) {
  test(`AppShots backend commands use the staged unified plugin: ${location}`, async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-backend-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const installDir = path.join(workspace, "app");
    const resources = path.join(installDir, "resources");
    const codexHome = path.join(workspace, "codex-home");
    const plugin = path.join(resources, "plugins/openai-bundled/plugins/unified-computer-use");
    const marketplace = path.join(plugin, "../../.agents/plugins/marketplace.json");
    fs.mkdirSync(path.dirname(marketplace), { recursive: true });
    fs.writeFileSync(marketplace, JSON.stringify({ plugins: [{ name: "unified-computer-use" }] }));
    fs.mkdirSync(path.join(plugin, ".codex-plugin"), { recursive: true });
    fs.mkdirSync(path.join(plugin, "scripts"));
    fs.writeFileSync(path.join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({
      name: "unified-computer-use", version: "26.908.31748", mcpServers: "./.mcp.json",
    }));
    fs.writeFileSync(path.join(plugin, ".mcp.json"), JSON.stringify({
      mcpServers: { cua_repl: { command: "node", args: [], enabled: false } },
    }));
    const backend = path.join(workspace, "backend");
    fs.writeFileSync(backend, '#!/bin/sh\n[ "$1" = windows ] || exit 1\nprintf \'%s\\n\' \'{"backend":"staged-unified","windows":[]}\'\n', { mode: 0o755 });
    execFileSync("bash", [path.join(__dirname, "../computer-use-linux/stage.sh")], {
      env: { ...process.env, SCRIPT_DIR: path.resolve(__dirname, "../.."), INSTALL_DIR: installDir,
        CODEX_COMPUTER_USE_BINARY_SOURCE: backend, CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE: backend, CODEX_COMPUTER_USE_INDICATOR_BINARY_SOURCE: backend },
      stdio: "pipe",
    });
    if (location === "cache") {
      const cached = path.join(codexHome, "plugins/cache/openai-bundled/unified-computer-use/latest");
      fs.cpSync(plugin, cached, { recursive: true });
    }
    if (location !== "installed") {
      fs.rmSync(plugin, { recursive: true });
      // A leftover legacy helper must neither shadow the unified cache nor act as a fallback.
      for (const retired of [
        path.join(resources, "plugins/openai-bundled/plugins/computer-use/bin"),
        path.join(codexHome, "plugins/cache/openai-bundled/computer-use/latest/bin"),
      ]) {
        fs.mkdirSync(retired, { recursive: true });
        fs.writeFileSync(path.join(retired, "codex-computer-use-linux"),
          '#!/bin/sh\nprintf \'%s\\n\' \'{"backend":"retired"}\'\n', { mode: 0o755 });
      }
    }
    const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
    const context = vm.createContext({
      require, process: { env: { CODEX_HOME: codexHome }, platform: "linux", resourcesPath: resources },
    });
    vm.runInContext(patched.slice(patched.lastIndexOf(";function codexLinuxAppshotRequire")), context);
    if (location === "retired only") {
      await assert.rejects(context.codexLinuxAppshotBackendJson(["windows"]), /backend is not installed/);
    } else {
      const report = await context.codexLinuxAppshotBackendJson(["windows"]);
      assert.equal(report.backend, "staged-unified");
      assert.equal(report.windows.length, 0);
    }
  });
}

test("appshots stays disabled until listed in features.json", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-feature-"));
  const configPath = path.join(tempDir, "features.json");
  const featuresRoot = path.resolve(__dirname, "..");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;

  try {
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    fs.writeFileSync(configPath, '{"enabled":[]}\n');
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);

    fs.writeFileSync(configPath, '{"enabled":["appshots"]}\n');
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });

    assert.equal(loaded.length, 3);
    assert.deepEqual(
      loaded.map((descriptor) => descriptor.id).sort(),
      [
        "feature:appshots:linux-appshots-availability",
        "feature:appshots:linux-appshots-hotkey",
        "feature:appshots:linux-appshots-main-process",
      ].sort(),
    );
    assert.ok(loaded.every((descriptor) => descriptor.ciPolicy === "optional"));
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("appshots feature descriptors are optional", () => {
  assert.equal(descriptors.length, 3);
  assert.ok(descriptors.every((descriptor) => descriptor.ciPolicy == null));
});

test("appshots availability descriptor matches the current bundle", () => {
  const descriptor = descriptors.find(
    (descriptor) => descriptor.id === "linux-appshots-availability",
  );

  assert.equal(descriptor.pattern.test("appshot-availability-BoK-Z77O.js"), false);
  assert.equal(
    descriptor.pattern.test(
      "app-initial~app-main~page-CMpPiY3-.js",
    ),
    false,
  );
  assert.ok(
    descriptor.pattern.test("app-initial-BTphDPeq.js"),
  );
  assert.equal(descriptor.assetMatch(appshotAvailabilityAtomBundleFixture()), true);
  assert.equal(descriptor.assetMatch("function unrelated(){return `windows`}"), false);
});

test("stages the Linux bare modifier monitor helper and Wayland portal hook", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
  const helperSource = fs.readFileSync(
    path.join(__dirname, "bin", "bare-modifier-monitor"),
    "utf8",
  );
  const electronArgsSource = fs.readFileSync(path.join(__dirname, "electron-args"), "utf8");

  assert.deepEqual(manifest.resources, [
    {
      source: "bin/bare-modifier-monitor",
      target: "resources/native/bare-modifier-monitor",
      mode: "0755",
    },
  ]);
  assert.deepEqual(manifest.runtimeHooks, {
    electronArgs: {
      source: "electron-args",
      name: "electron-args",
      mode: "0644",
    },
  });
  assert.equal(electronArgsSource.trim(), "--enable-features=GlobalShortcutsPortal");
  assert.match(helperSource, /xinput test-xi2 --root/);
  assert.match(helperSource, /stdbuf -oL/);
  assert.doesNotMatch(helperSource, /\bmktemp\s+-u\b/);
  assert.doesNotMatch(helperSource, /xinput list --short/);
  assert.doesNotMatch(helperSource, /xinput test "\$device_id"/);
  assert.doesNotMatch(helperSource, /mkfifo/);
  assert.match(helperSource, /parent_pid="\$PPID"/);
  assert.match(helperSource, /kill -0 "\$parent_pid"/);
  assert.match(helperSource, /read -r -t 1 -u "\$event_fd" line/);
  assert.match(helperSource, /kill "\$monitor_pid"/);
  assert.match(helperSource, /doublealt\|doubleoption\|alt\+alt/);
  assert.match(helperSource, /doubleshift\|shift\+shift\|leftshift\+rightshift/);
  assert.match(helperSource, /Shift_L Shift_R/);
  assert.match(helperSource, /last_tap_code=""/);
  assert.match(helperSource, /\[ "\$code" != "\$last_tap_code" \]/);
  assert.match(helperSource, /date \+%s%N/);
  assert.match(helperSource, /10#\$epoch_nanoseconds \/ 1000000/);
  assert.doesNotMatch(helperSource, /date \+%s%3N/);
  assert.doesNotMatch(helperSource, /while IFS= read -r pending code/);
  execFileSync("bash", ["-n", path.join(__dirname, "bin", "bare-modifier-monitor")]);
});

test("bare modifier monitor emits one transition from one XInput2 stream", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-xinput2-"));
  const binDir = path.join(tempDir, "bin");
  const helper = path.join(__dirname, "bin", "bare-modifier-monitor");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "xmodmap"),
    "#!/bin/sh\nprintf '%s\\n' 'keycode 50 = Shift_L' 'keycode 62 = Shift_R'\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "xinput"),
    [
      "#!/bin/sh",
      "[ \"$1 $2\" = \"test-xi2 --root\" ] || exit 2",
      "printf '%s\\n' \\",
      "  'EVENT type 13 (RawKeyPress)' '    detail: 50' \\",
      "  'EVENT type 14 (RawKeyRelease)' '    detail: 50' \\",
      "  'EVENT type 13 (RawKeyPress)' '    detail: 62' \\",
      "  'EVENT type 14 (RawKeyRelease)' '    detail: 62'",
      "sleep 0.25",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "date"),
    "#!/bin/sh\n[ \"$1\" = \"+%s%N\" ] || exit 2\nprintf '%s\\n' 1787195182868568236\n",
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(helper, ["--key", "DoubleShift", "--immediate"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DISPLAY: ":99",
        PATH: `${binDir}:${process.env.PATH}`,
      },
      timeout: 2_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), ["ready", "down", "up"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bare modifier monitor fails before ready when XInput2 exits during startup", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-xinput2-startup-"));
  const binDir = path.join(tempDir, "bin");
  const helper = path.join(__dirname, "bin", "bare-modifier-monitor");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "xmodmap"),
    "#!/bin/sh\nprintf '%s\\n' 'keycode 50 = Shift_L' 'keycode 62 = Shift_R'\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "xinput"),
    "#!/bin/sh\n[ \"$1 $2\" = \"test-xi2 --root\" ] || exit 2\nexit 2\n",
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(helper, ["--key", "DoubleShift", "--immediate"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DISPLAY: ":99",
        PATH: `${binDir}:${process.env.PATH}`,
      },
      timeout: 2_000,
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(result.stdout, "permission-denied\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("enables AppShots availability atom on Linux", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotAvailabilityPatch,
    appshotAvailabilityAtomBundleFixture(),
  );

  assert.match(
    patched,
    /e===`linux`\/\*codexLinuxAppshotsPlatformAvailable\*\/\|\|e===`macOS`/,
  );
  assert.match(patched, /e===`windows`/);
  assert.equal(matchesLinuxAppshotAvailabilityContract(patched), true);
});

test("rejects the obsolete raw renderer message sender shape", () => {
  const obsolete = "var F=`codex_desktop:message-for-view`;function nS(e,t){e.send(F,t)}";
  assert.equal(applyLinuxAppshotMainProcessPatch(obsolete), obsolete);
});

test("routes AppShots capture through the self-contained Linux feature", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotMainProcessPatch,
    appshotMainProcessBundleFixture(),
  );

  assert.match(
    patched,
    /"linux"===process\.platform\?codexLinuxAppshotFrontmostWindow\(this\.abortController\.signal\):"win32"===process\.platform/,
  );
  assert.match(
    patched,
    /if\("linux"===process\.platform\)return codexLinuxAppshotStartCapture\(\{origin:i,requestId:n,bundleIdentifier:r,windowManager:a,signal:this\.abortController\.signal\}\);/,
  );
  assert.match(patched, /function codexLinuxAppshotBackendPath/);
  assert.match(patched, /codexLinuxAppshotBackendJson\(\[`windows`\],5000,signal\)/);
  assert.match(patched, /codexLinuxAppshotBackendJson\(\[`state`,e\],10000,signal\)/);
  assert.match(patched, /function codexLinuxAppshotPreviousExternalWindow/);
  assert.match(patched, /function codexLinuxAppshotHyprlandPickerData/);
  assert.match(patched, /`hyprland-preview-share-picker`,`hyprland-share-picker`/);
  assert.match(patched, /function codexLinuxAppshotHyprlandPickerConfig/);
  assert.match(patched, /function codexLinuxAppshotHyprlandInstanceSignature/);
  assert.match(patched, /default_page: windows/);
  assert.match(patched, /GDK_BACKEND:`wayland`/);
  assert.match(patched, /XDPH_WINDOW_SHARING_LIST:n\.list/);
  assert.doesNotMatch(patched, /focusHistoryID/);
  assert.match(patched, /function codexLinuxAppshotHyprlandFocusWindow/);
  assert.match(patched, /\[`dispatch`,`hl\.dsp\.focus/);
  assert.match(patched, /\[`dispatch`,`focuswindow`,t\]/);
  assert.match(patched, /function codexLinuxAppshotPrepareWindowForCapture/);
  assert.match(patched, /let codexLinuxAppshotCaptureQueue=Promise\.resolve\(\)/);
  assert.match(patched, /codexLinuxAppshotVerifyCapturedWindow/);
  assert.match(patched, /codexLinuxAppshotRestoreWindow/);
  assert.match(
    patched,
    /codexLinuxAppshotExecFile\(e,`xprop`,\[`-root`,`_NET_CLIENT_LIST_STACKING`\]/,
  );
  assert.match(patched, /function codexLinuxAppshotX11Session/);
  assert.match(patched, /spectacle.*-b.*-n/);
  assert.match(patched, /programs:\[`spectacle`,`\/usr\/bin\/spectacle`\]/);
  assert.match(patched, /codexLinuxAppshotCropWithImageMagick/);
  assert.ok(
    patched.indexOf("await codexLinuxAppshotCropWithImageMagick") <
      patched.indexOf("codexLinuxAppshotCropNativeImage(o,d,c.source===`imagemagick-window`?null:s)"),
  );
  assert.match(patched, /\[linux-appshots\]/);
  assert.match(patched, /codexLinuxAppshotCropRects/);
  assert.match(patched, /codexLinuxAppshotFirstValidCrop/);
  assert.match(patched, /mkdtempSync\(i\.join\(r\.tmpdir\(\),`codex-appshot-`\)\)/);
  assert.match(patched, /chmodSync\(u,448\)/);
  assert.match(patched, /i\.join\(u,`source\.png`\)/);
  assert.match(patched, /i\.join\(u,`crop\.png`\)/);
  assert.match(patched, /rmSync\(u,\{recursive:true,force:true\}\)/);
  assert.doesNotMatch(patched, /i\.join\(r\.tmpdir\(\),`codex-appshot-\$\{/);
  assert.doesNotMatch(patched, /\[`appshot`/);
  assert.doesNotMatch(patched, /bare-modifier-monitor/);
  assert.match(
    patched,
    /function codexLinuxAppshotSend\(e,t,n,r\)\{try\{e\.sendInlineMessageForView\(t,\{requestId:n,type:`computer-use-capture-updated`,update:r\}\)\}catch\{\}\}/,
  );
  assert.doesNotMatch(
    patched,
    /codex_desktop:message-for-view/,
  );
  assert.match(patched, /transitionSnapshotHeight:140/);
  assert.match(patched, /type:`metadata`,app:\{bundleIdentifier:c\.bundleIdentifier/);
  assert.match(patched, /type:`axText`,text:l/);
  assert.match(patched, /type:`screenshot`,screenshotDataURL:u\.dataURL/);
  assert.match(patched, /type:`completed`,transitionSnapshotDataURL:u\.dataURL/);
});

test("enabled AppShots rejects overriding or residual Wayland helper bindings", () => {
  const { applyMainBundlePatchDescriptors } = require("../../scripts/patches/engine.js");
  const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
  const descriptor = { ...descriptors.find(({ id }) => id === "linux-appshots-hotkey"),
    featureId: "appshots", sourceKind: "feature" };
  const current = currentAppshotHotkeyMainBundleFixture();
  const patched = applyLinuxAppshotHotkeyPatch(current);
  for (const invalid of [
    patched + "function codexLinuxAppshotIsWayland(){return false}",
    patched + "codexLinuxAppshotIsWayland=()=>false;",
    current + "function codexLinuxAppshotIsWayland(){return false}",
  ]) {
    const report = createPatchReport();
    report.enabledFeatures = ["appshots"];
    const result = applyMainBundlePatchDescriptors(invalid, [descriptor], {}, report);
    assert.equal(result.patchedSource, invalid);
    assert.equal(result.warnings.length, 1);
    assert.notEqual(report.patches[0].status, "already-applied");
    assert.equal(enabledFeatureFailuresFromReport(report).length, 1);
  }
});

test("enabled AppShots rejects escaped helper bindings before and after patching", () => {
  const { applyMainBundlePatchDescriptors } = require("../../scripts/patches/engine.js");
  const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
  for (const [id, current, apply, names] of [
    ["linux-appshots-main-process", appshotMainProcessBundleFixture(), applyLinuxAppshotMainProcessPatch,
      ["codexLinuxAppshotStartCapt\\u0075re", "codexLinuxAppshotStartCapt\\u{75}re"]],
    ["linux-appshots-hotkey", currentAppshotHotkeyMainBundleFixture(), applyLinuxAppshotHotkeyPatch,
      ["codexLinuxAppshotIsWayl\\u0061nd", "codexLinuxAppshotIsWayl\\u{61}nd"]],
  ]) {
    const descriptor = { ...descriptors.find(descriptor => descriptor.id === id), featureId: "appshots", sourceKind: "feature" };
    for (const original of [current, apply(current)]) for (const name of names) {
      const invalid = original + `function ${name}(){return false}`;
      assert.doesNotThrow(() => new vm.Script(invalid));
      const report = createPatchReport(); report.enabledFeatures = ["appshots"];
      let result;
      captureWarnings(() => { result = applyMainBundlePatchDescriptors(invalid, [descriptor], {}, report); });
      assert.equal(result.patchedSource, invalid);
      assert.equal(result.warnings.length, 1);
      assert.equal(report.patches[0].status === "already-applied", false, `${id}: ${name}`);
      assert.equal(enabledFeatureFailuresFromReport(report).length, 1, `${id}: ${name}`);
    }
  }
});

test("AppShots rejects factories disconnected from the class owning both capture methods", () => {
  const { applyMainBundlePatchDescriptors } = require("../../scripts/patches/engine.js");
  const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
  const descriptor = { ...descriptors.find(({ id }) => id === "linux-appshots-main-process"), featureId: "appshots", sourceKind: "feature" };
  const source = appshotMainProcessBundleFixture();
  const replacementSource = source.replace("?new Capture(", "?new OtherCapture(") + "class OtherCapture{}";
  const context = vm.createContext({ AbortController, process: { platform: "darwin" } });
  vm.runInContext(replacementSource, context);
  const replacement = new context.Owner({ requestComputerUseWorker() {}, subscribeComputerUseCaptureWorkerEvent() {} }).create({}, {}).appshotCapture;
  assert.equal(typeof replacement.getFrontmostWindow, "undefined", "replacement service does not own the adapted methods");
  for (const base of [source, applyLinuxAppshotMainProcessPatch(source)]) {
    const disconnected = base.replace("?new Capture(", "?new OtherCapture(") + "class OtherCapture{}";
    const split = base.replace("}async start(", "}}class OtherCapture extends Base{options;abortController=new AbortController;constructor(e){super(),this.options=e}[Symbol.dispose](){this.abortController.abort()}async start(")
      .replace("?new Capture(", "?new OtherCapture(");
    const wrongScope = `exports.modules={1(e,t,r){"use strict";${base.slice(0, base.indexOf("class Owner"))}},2(e,t,r){"use strict";${base.slice(base.indexOf("class Owner"))}}}`;
    for (const invalid of [disconnected, split, wrongScope,
      base.replace("create(e,m){return", "create(e,m){let Capture=class{};return"),
      base.replace("create(e,m){return", "create(e,m){let Capt\\u0075re=class{};return"),
    ]) {
      assert.doesNotThrow(() => new vm.Script(invalid));
      const report = createPatchReport(); report.enabledFeatures = ["appshots"];
      let result;
      captureWarnings(() => { result = applyMainBundlePatchDescriptors(invalid, [descriptor], {}, report); });
      assert.equal(result.patchedSource, invalid, "do not enable a disconnected service");
      assert.equal(result.warnings.length, 1);
      assert.equal(enabledFeatureFailuresFromReport(report).length, 1);
    }
  }
});

test("AppShots capture owner permits identifier reuse in another Rspack module", () => {
  const source = `exports.modules={1(e,t,r){"use strict";${appshotMainProcessBundleFixture()}},2(e,t,r){"use strict";class Capture{};let alias=Capture}}`;
  const patched = applyLinuxAppshotMainProcessPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyLinuxAppshotMainProcessPatch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
});

test("AppShots owner exposes Linux capture and preserves native platform prerequisites", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  for (const [platform, options, supported] of [
    ["linux", {}, true], ["darwin", {}, false],
    ["darwin", { requestComputerUseWorker() {} }, false],
    ["darwin", { requestComputerUseWorker() {}, subscribeComputerUseCaptureWorkerEvent() {} }, true],
    ["win32", {}, false], ["win32", { windowsCaptureNativeBridge: {} }, true],
    ["freebsd", {}, false],
  ]) {
    const context = vm.createContext({ AbortController, process: { platform } });
    vm.runInContext(patched, context);
    const service = new context.Owner(options).create({}, {}).appshotCapture;
    assert.equal(service != null, supported, platform);
    if (platform === "linux") {
      context.codexLinuxAppshotFrontmostWindow = async () => "selected";
      context.codexLinuxAppshotStartCapture = ({ signal }) => signal === service.abortController.signal ? "capture" : null;
      assert.equal(await service.getFrontmostWindow(), "selected");
      assert.equal(await service.start({}), "capture");
    }
  }
});

test("AppShots disposed queued service performs no capture or renderer operations", async () => {
  const scheduled = [], calls = [];
  const context = vm.createContext({ AbortController, process: { platform: "linux" },
    setTimeout(fn) { scheduled.push(fn); }, console: { warn() {} } });
  vm.runInContext(applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture()), context);
  let release;
  context.blockedQueue = new Promise(resolve => { release = resolve; });
  vm.runInContext("codexLinuxAppshotCaptureQueue = blockedQueue", context);
  context.codexLinuxAppshotFocusedWindow = async () => { calls.push("windows"); throw Error("must not capture"); };
  const service = new (vm.runInContext("Capture", context))({ origin: {}, windowManager: { sendInlineMessageForView() { calls.push("message"); } } });
  const metadata = await service.start({ requestId: "disposed" });
  assert.equal(metadata.animationDuration, 0);
  assert.equal(metadata.transitionSnapshotHeight, 140);
  scheduled.splice(0).forEach(fn => fn());
  service[Symbol.dispose]();
  release();
  await vm.runInContext("codexLinuxAppshotCaptureQueue", context);
  assert.deepEqual(calls, []);
});

test("AppShots reports ordinary queued capture failure", async () => {
  const scheduled = [], updates = [];
  const context = vm.createContext({ AbortController, process: { platform: "linux" },
    setTimeout(fn) { scheduled.push(fn); }, console: { warn() {} } });
  vm.runInContext(applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture()), context);
  context.codexLinuxAppshotFocusedWindow = async () => { throw Error("backend unavailable"); };
  const service = new (vm.runInContext("Capture", context))({ origin: {}, windowManager: {
    sendInlineMessageForView(_origin, message) { updates.push(message.update); },
  } });
  await service.start({ requestId: "failed-request" });
  scheduled.splice(0).forEach(fn => fn());
  await vm.runInContext("codexLinuxAppshotCaptureQueue", context);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].type, "failed");
  assert.equal(updates[0].failureReason, "linux_capture_failed");
});

test("AppShots disposal during capture aborts work and restores focus without messages", async () => {
  const scheduled = [], calls = [], own = { app_id: "codex-desktop", window_id: 1 },
    selected = { app_id: "external", window_id: 2, focused: false },
    report = { backend: "hyprland", focusedWindow: selected, returnWindow: own, windows: [own, selected] };
  const context = vm.createContext({ AbortController, process: { platform: "linux" },
    setTimeout(fn) { scheduled.push(fn); }, console: { warn() {} } });
  vm.runInContext(applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture()), context);
  let finish;
  context.codexLinuxAppshotFocusedWindow = async () => report;
  context.codexLinuxAppshotPrepareWindowForCapture = async () => report;
  context.codexLinuxAppshotAccessibilityNodes = async () => ({ nodes: [], error: null });
  context.codexLinuxAppshotScreenshot = (_window, _windows, signal) => new Promise(resolve => {
    calls.push("screenshot");
    if (signal) signal.addEventListener("abort", () => calls.push("aborted"), { once: true });
    finish = () => resolve({ dataURL: "late screenshot" });
  });
  context.codexLinuxAppshotVerifyCapturedWindow = async () => { calls.push("verify"); };
  context.codexLinuxAppshotRestoreWindow = async window => { assert.equal(window, own); calls.push("restore"); return true; };
  const service = new (vm.runInContext("Capture", context))({ origin: {}, windowManager: { sendInlineMessageForView() { calls.push("message"); } } });
  await service.start({ requestId: "disposed-in-flight" });
  scheduled.splice(0).forEach(fn => fn());
  await new Promise(resolve => setImmediate(resolve));
  service[Symbol.dispose]();
  finish();
  await vm.runInContext("codexLinuxAppshotCaptureQueue", context);
  assert.deepEqual(calls, ["screenshot", "aborted", "restore"]);
});

for (const stage of ["picker", "screenshot", "crop", "accessibility", "focus"]) {
  test(`AppShots cancellation stops ${stage} subprocess work and cleans resources`, async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-abort-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const configDir = path.join(workspace, ".config/hyprland-preview-share-picker");
    fs.mkdirSync(configDir, { recursive: true });
    const config = "default_page: outputs\n";
    fs.writeFileSync(path.join(configDir, "config.yaml"), config);
    const controller = new AbortController(), calls = [];
    let notifyStarted, finishTermination;
    const started = new Promise(resolve => { notifyStarted = resolve; });
    const context = vm.createContext({
      Buffer, setTimeout, console: { warn() {} },
      process: { platform: "linux", pid: 101, env: { HOME: workspace,
        CODEX_LINUX_APPSHOT_PICKER: "/inert/hyprland-preview-share-picker" } },
      require(name) {
        if (name === "node:fs") return { ...fs, accessSync() {} };
        if (name === "node:os") return { ...os, tmpdir: () => workspace };
        if (name === "electron") return { nativeImage: { createFromPath() { calls.push("native-fallback"); throw Error("must not fall back"); } } };
        if (name === "node:child_process") return {
          execFile(program, args, options, callback) {
            calls.push(program);
            assert.equal(options.signal, controller.signal);
            if (stage === "crop" && calls.length === 1) {
              fs.writeFileSync(args.at(-1), "source");
              callback(null, "", "");
              return;
            }
            const child = new (require("node:events").EventEmitter)();
            child.pid = 123;
            child.exitCode = null;
            child.signalCode = null;
            finishTermination = () => { child.signalCode = "SIGTERM"; child.emit("close", null, "SIGTERM"); };
            options.signal.addEventListener("abort", () => callback(Error("aborted"), "", ""), { once: true });
            notifyStarted();
            return child;
          },
        };
        return require(name);
      },
    });
    const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
    vm.runInContext(patched.slice(patched.lastIndexOf(";function codexLinuxAppshotRequire")), context);
    context.codexLinuxAppshotBackendPath = () => "/inert/backend";
    const window = { app_id: "external", window_id: 2, backend: "x11",
      bounds: { x: 0, y: 0, width: 100, height: 100 } };
    const operation = stage === "picker"
      ? context.codexLinuxAppshotHyprlandPickWindow([window], controller.signal)
      : stage === "accessibility"
        ? context.codexLinuxAppshotAccessibilityNodes(window, "external", controller.signal)
        : stage === "focus"
          ? context.codexLinuxAppshotHyprlandFocusWindow(window, controller.signal)
          : context.codexLinuxAppshotScreenshot(window, [window], controller.signal);
    const rejected = assert.rejects(operation, error => error === controller.signal.reason);
    await started;
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    try {
      if (stage === "picker") assert.equal(fs.readdirSync(configDir).length, 2, "keep override until picker exits");
      if (stage === "screenshot" || stage === "crop") assert.equal(fs.readdirSync(workspace).length, 2, "keep capture directory until subprocess exits");
    } finally {
      finishTermination();
    }
    await rejected;
    assert.equal(calls.length, stage === "crop" ? 2 : 1, "no retry, fallback or later capture step");
    assert.deepEqual(fs.readdirSync(workspace), [".config"], "private screenshot directories removed");
    assert.deepEqual(fs.readdirSync(configDir), ["config.yaml"], "picker override removed");
    assert.equal(fs.readFileSync(path.join(configDir, "config.yaml"), "utf8"), config);
  });
}

test("AppShots preserves the capture service abort guard before Linux dispatch", async () => {
  const context = vm.createContext({ AbortController, process: { platform: "linux" } });
  vm.runInContext(applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture()), context);
  const calls = [];
  context.codexLinuxAppshotFrontmostWindow = () => { calls.push("frontmost"); return "external"; };
  context.codexLinuxAppshotStartCapture = (request) => { calls.push(request); return "capture"; };
  const options = { origin: {}, windowManager: {} };
  const service = new (vm.runInContext("Capture", context))(options);
  assert.equal(await service.getFrontmostWindow(), "external");
  assert.equal(await service.start({ bundleIdentifier: "window", requestId: "request" }), "capture");
  assert.equal(calls[1].origin, options.origin);
  assert.equal(calls[1].windowManager, options.windowManager);
  assert.equal(calls[1].requestId, "request");
  assert.equal(calls[1].bundleIdentifier, "window");
  service.abortController.abort();
  assert.equal(await service.getFrontmostWindow(), null);
  assert.equal(await service.start({}), null);
  assert.equal(calls.length, 2);
});

test("AppShots capture patch leaves partial and ambiguous owners unchanged", () => {
  const source = appshotMainProcessBundleFixture();
  const patched = applyLinuxAppshotMainProcessPatch(source);
  for (const invalid of [
    source + source,
    patched + patched,
    source + patched,
    source.replace("getFrontmostWindow(){", "renamed(){"),
    source.replace('appshotCapture:"darwin"', 'renamedCapture:"darwin"'),
    source.replace('globalThis.Owner=Owner;', source.slice(source.indexOf('class Owner'), source.indexOf('globalThis.Owner=Owner;')) + 'globalThis.Owner=Owner;'),
    patched.replace('appshotCapture:"linux"===process.platform||', 'appshotCapture:'),
    patched.replace('"linux"===process.platform?codexLinuxAppshotFrontmostWindow(this.abortController.signal):', ""),
  ]) {
    captureWarnings(() => assert.equal(applyLinuxAppshotMainProcessPatch(invalid), invalid));
  }
});

test("enabled AppShots rejects incomplete or conflicting capture helpers", () => {
  const { applyMainBundlePatchDescriptors } = require("../../scripts/patches/engine.js");
  const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
  const descriptor = {
    ...descriptors.find(({ id }) => id === "linux-appshots-main-process"),
    featureId: "appshots", sourceKind: "feature",
  };
  const current = appshotMainProcessBundleFixture();
  const patched = applyLinuxAppshotMainProcessPatch(current);
  for (const [name, damaged] of [
    ["missing frontmost helper", patched.replace("function codexLinuxAppshotFrontmostWindow(", "function removedFrontmostWindow(")],
    ["damaged backend helper", patched.replace("return require(e)", "return null")],
    ["conflicting frontmost helper", patched + "function codexLinuxAppshotFrontmostWindow(){}"],
    ["residual helper before application", current + "function codexLinuxAppshotFrontmostWindow(){}"],
  ]) {
    assert.notEqual(damaged, patched, name);
    assert.doesNotThrow(() => new vm.Script(damaged), name);
    const report = createPatchReport();
    report.enabledFeatures = ["appshots"];
    const result = applyMainBundlePatchDescriptors(damaged, [descriptor], {}, report);
    assert.equal(result.patchedSource, damaged, name);
    assert.equal(result.warnings.length, 1, name);
    assert.notEqual(report.patches[0].status, "already-applied", name);
    assert.equal(enabledFeatureFailuresFromReport(report).length, 1, name);
  }
});

test("AppShots maps an explicit Hyprland picker selection and keeps X11 stacking fallback", () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const windows = [
    {
      app_id: "codex-desktop",
      focused: true,
      pid: 101,
      title: "ChatGPT",
      window_id: Number.parseInt("0x100", 16),
      wm_class: "codex-desktop",
    },
    {
      app_id: "chromium",
      focused: false,
      pid: 202,
      title: "Example - Chromium",
      window_id: Number.parseInt("0x200", 16),
      wm_class: "chromium",
    },
  ];
  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });

  const portalWindow = {
    app_id: "Xdg-desktop-portal-gtk",
    focused: true,
    pid: 303,
    title: "Select Project Root",
    window_id: Number.parseInt("0x300", 16),
    wm_class: "Xdg-desktop-portal-gtk",
  };
  const pickerData = context.codexLinuxAppshotHyprlandPickerData([
    portalWindow,
    windows[0],
    { ...windows[1], title: "Example [HC>] - Chromium" },
    { ...windows[1], app_id: "hidden", hidden: true, window_id: 0x400 },
  ]);

  assert.equal(pickerData.windowsById.size, 1);
  assert.equal(pickerData.windowsById.get("1")?.app_id, "chromium");
  assert.equal(
    pickerData.list,
    "1[HC>]chromium[HT>]Example   - Chromium[HE>]512[HA>]",
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandPickerSelection(
      "debug output\n[SELECTION]/window:1\n",
    ),
    "1",
  );
  assert.equal(context.codexLinuxAppshotHyprlandPickerSelection("cancelled"), null);
  assert.equal(
    context.codexLinuxAppshotHyprlandPickerSelection(
      "[SELECTION]r/window:not-a-number\n",
    ),
    null,
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandPickerData([portalWindow, windows[0]])
      .windowsById.size,
    0,
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandWindowAddress(windows[1]),
    "address:0x200",
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandWindowAddress({ window_id: "invalid" }),
    null,
  );
  assert.equal(
    context.codexLinuxAppshotUsableBounds({
      bounds: { height: 100, width: 100, x: null, y: 0 },
    }),
    false,
  );
  assert.equal(
    context.codexLinuxAppshotPreviousExternalWindow(
      windows,
      context.codexLinuxAppshotX11StackingCandidates(
        "_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x200, 0x100",
      ),
    )?.app_id,
    "chromium",
  );
  assert.equal(
    context.codexLinuxAppshotPreviousExternalWindow(
      [windows[0]],
      [{ window_id: "0x100" }],
    ),
    null,
  );
  assert.equal(
    context.codexLinuxAppshotPreviousExternalWindow(
      [{ ...windows[1], hidden: true }],
      [{ window_id: "0x200" }],
    ),
    null,
  );
  context.process.env = { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" };
  assert.equal(context.codexLinuxAppshotX11Session(), true);
  context.process.env = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1" };
  assert.equal(context.codexLinuxAppshotX11Session(), false);
});

test("AppShots keeps custom pickers argument-free and forces native Wayland backends", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const pickerPath = "/test/custom-share-picker";
  let invocation = null;
  const fakeFs = {
    ...fs,
    accessSync(target, mode) {
      assert.equal(target, pickerPath);
      assert.equal(mode, fs.constants.X_OK);
    },
  };
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: {
      env: {
        CODEX_LINUX_APPSHOT_PICKER: pickerPath,
        GDK_BACKEND: "x11",
        HOME: "/nonexistent",
        KEEP_ME: "yes",
        QT_QPA_PLATFORM: "xcb",
      },
      pid: 101,
      platform: "linux",
      resourcesPath: "",
    },
    require(moduleName) {
      if (moduleName === "node:fs") return fakeFs;
      if (moduleName === "node:os") return os;
      if (moduleName === "node:path") return path;
      if (moduleName === "node:child_process") {
        return {
          execFile(program, args, options, callback) {
            invocation = { args, options, program };
            callback(null, "[SELECTION]/window:1\n", "");
          },
        };
      }
      throw new Error(`Unexpected module: ${moduleName}`);
    },
    setTimeout,
  });
  const window = {
    app_id: "org.gnome.Nautilus",
    focused: false,
    title: "Documents",
    window_id: 0x200,
    wm_class: "org.gnome.Nautilus",
  };

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  const selected = await context.codexLinuxAppshotHyprlandPickWindow([window]);

  assert.equal(selected?.app_id, window.app_id);
  assert.equal(invocation?.program, pickerPath);
  assert.deepEqual(Array.from(invocation?.args ?? []), []);
  assert.equal(invocation?.options.env.GDK_BACKEND, "wayland");
  assert.equal(invocation?.options.env.QT_QPA_PLATFORM, "wayland");
  assert.equal(invocation?.options.env.KEEP_ME, "yes");
  assert.match(invocation?.options.env.XDPH_WINDOW_SHARING_LIST ?? "", /Documents/);
});

test("AppShots overrides only the picker default page and removes the temporary config", () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-picker-config-"));
  const configDir = path.join(home, ".config", "hyprland-preview-share-picker");
  const configPath = path.join(configDir, "config.yaml");
  const source = [
    'stylesheets: ["../../theme/picker.css"]',
    "default_page: outputs",
    "window:",
    "  width: 1000",
    "",
  ].join("\n");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: { HOME: home }, pid: 101, platform: "linux", resourcesPath: "" },
    require,
    setTimeout,
  });

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, source);

  try {
    vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
    const override = context.codexLinuxAppshotHyprlandPickerConfig({ preview: true });
    const args = Array.from(override.args);

    assert.equal(args[0], "--config");
    assert.equal(path.dirname(args[1]), configDir);
    assert.notEqual(args[1], configPath);
    assert.equal(fs.readFileSync(configPath, "utf8"), source);
    assert.equal(
      fs.readFileSync(args[1], "utf8"),
      source.replace("default_page: outputs", "default_page: windows"),
    );

    override.cleanup();
    assert.equal(fs.existsSync(args[1]), false);

    fs.writeFileSync(configPath, source.replace("default_page: outputs", "default_page: windows"));
    const unchanged = context.codexLinuxAppshotHyprlandPickerConfig({ preview: true });
    assert.deepEqual(Array.from(unchanged.args), []);
    assert.deepEqual(
      Array.from(context.codexLinuxAppshotHyprlandPickerConfig({ preview: false }).args),
      [],
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("AppShots resolves the live Hyprland instance when Electron did not inherit it", () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const fakeFs = {
    ...fs,
    existsSync(target) {
      return target === "/proc/111" || target === "/proc/222";
    },
    readFileSync(target) {
      if (target.endsWith("/older/hyprland.lock")) return "111\nwayland-0\n";
      if (target.endsWith("/matching/hyprland.lock")) return "222\nwayland-1\n";
      throw new Error(`Unexpected read: ${target}`);
    },
    readdirSync(target) {
      assert.equal(target, "/runtime/hypr");
      return ["older", "matching"];
    },
    statSync(target) {
      if (!target.endsWith("/.socket.sock")) throw new Error(`Unexpected stat: ${target}`);
      return {
        isSocket: () => true,
        mtimeMs: target.includes("matching") ? 10 : 20,
      };
    },
  };
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: {
      env: { XDG_RUNTIME_DIR: "/runtime", WAYLAND_DISPLAY: "wayland-1" },
      getuid: () => 1000,
      pid: 101,
      platform: "linux",
      resourcesPath: "",
    },
    require(moduleName) {
      if (moduleName === "node:fs") return fakeFs;
      if (moduleName === "node:path") return path;
      throw new Error(`Unexpected module: ${moduleName}`);
    },
    setTimeout,
  });

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });

  assert.equal(context.codexLinuxAppshotHyprlandInstanceSignature(), "matching");
  assert.deepEqual(
    Array.from(context.codexLinuxAppshotHyprctlArgs(["clients", "-j"])),
    ["-i", "matching", "clients", "-j"],
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandEnv().HYPRLAND_INSTANCE_SIGNATURE,
    "matching",
  );

  context.process.env.HYPRLAND_INSTANCE_SIGNATURE = "inherited";
  assert.deepEqual(
    Array.from(context.codexLinuxAppshotHyprctlArgs(["clients", "-j"])),
    ["clients", "-j"],
  );
});

test("AppShots requires a safe return target before changing Hyprland focus", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  let focusCalls = 0;
  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotHyprlandFocusWindow = async () => {
    focusCalls += 1;
    return true;
  };

  await assert.rejects(
    context.codexLinuxAppshotPrepareWindowForCapture({
      backend: "hyprland",
      focusedWindow: {
        app_id: "chromium",
        bounds: { height: 800, width: 1200, x: 0, y: 0 },
        focused: false,
        window_id: 0x200,
        wm_class: "chromium",
      },
      returnWindow: null,
    }),
    /No safe ChatGPT return target/,
  );
  assert.equal(focusCalls, 0);

  const hiddenReturn = {
    app_id: "codex-desktop",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    hidden: true,
    pid: 101,
    window_id: 0x100,
    wm_class: "codex-desktop",
  };
  assert.equal(context.codexLinuxAppshotValidReturnWindow(hiddenReturn), false);
  assert.equal(
    context.codexLinuxAppshotValidReturnWindow({ ...hiddenReturn, hidden: false }),
    true,
  );
});

test("AppShots rejects changed, hidden, unfocused, or moved capture targets", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const selected = {
    app_id: "chromium",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
    pid: 202,
    window_id: 0x200,
    wm_class: "chromium",
  };
  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });

  assert.equal(
    context.codexLinuxAppshotCaptureReadyWindow([selected], selected, "0:0:1200:800")
      ?.window_id,
    0x200,
  );
  for (const changed of [
    { ...selected, app_id: "other" },
    { ...selected, focused: false },
    { ...selected, hidden: true },
    { ...selected, bounds: { ...selected.bounds, x: 20 } },
  ]) {
    assert.equal(
      context.codexLinuxAppshotCaptureReadyWindow(
        [changed],
        selected,
        "0:0:1200:800",
      ),
      null,
    );
  }

  context.codexLinuxAppshotBackendJson = async () => ({
    backend: "hyprland",
    windows: [{ ...selected, app_id: "other" }],
  });
  await assert.rejects(
    context.codexLinuxAppshotVerifyCapturedWindow(selected, "0:0:1200:800"),
    /changed during capture/,
  );
});

test("AppShots activates a selected Hyprland window and waits for stable bounds", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const selected = {
    app_id: "chromium",
    bounds: { height: 400, width: 600, x: 900, y: 100 },
    focused: false,
    window_id: 0x200,
    wm_class: "chromium",
  };
  const refreshed = {
    ...selected,
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
  };
  const ownWindow = {
    app_id: "codex-desktop",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: false,
    pid: 101,
    window_id: 0x100,
    wm_class: "codex-desktop",
  };
  const focusCalls = [];
  let windowReports = 0;

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotHyprlandFocusWindow = async (window) => {
    focusCalls.push(window.window_id);
    return true;
  };
  context.codexLinuxAppshotBackendJson = async () => {
    windowReports += 1;
    return { backend: "hyprland", windows: [ownWindow, refreshed] };
  };
  context.codexLinuxAppshotDelay = async () => {};

  const prepared = await context.codexLinuxAppshotPrepareWindowForCapture({
    backend: "hyprland",
    focusedWindow: selected,
    returnWindow: ownWindow,
    windows: [ownWindow, selected],
  });

  assert.deepEqual(focusCalls, [0x200]);
  assert.equal(windowReports, 4);
  assert.equal(prepared.focusedWindow.window_id, 0x200);
  assert.equal(prepared.focusedWindow.focused, true);
  assert.equal(prepared.focusedWindow.bounds.width, 1200);
});

function x11AppshotCaptureFixture({ backend = "x11", initiallyFocused = false, failure } = {}) {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const desktop = {
    app_id: "codex-desktop", wm_class: "codex-desktop", pid: 101,
    window_id: 0x100, focused: !initiallyFocused,
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
  };
  const external = {
    app_id: "chromium", wm_class: "chromium", pid: 202,
    window_id: 0x200, focused: initiallyFocused, title: "Example - Chromium",
    bounds: { ...desktop.bounds },
  };
  const updates = [];
  const activations = [];
  let screenshots = 0;
  const context = vm.createContext({
    Buffer, console: { warn() {} }, setTimeout,
    process: { env: { DISPLAY: ":fixture", XDG_SESSION_TYPE: "x11" }, pid: 101, platform: "linux" },
    require(name) {
      assert.equal(name, "node:child_process");
      return { execFile(program, args, _options, callback) {
        const id = backend === "i3" ? Number(args[0].match(/0x[0-9a-f]+/)[0]) : Number(args[2]);
        assert.equal(program, backend === "i3" ? "i3-msg" : "wmctrl");
        assert.deepEqual(Array.from(args), backend === "i3"
          ? [`[id="0x${id.toString(16)}"] focus`] : ["-i", "-a", `0x${id.toString(16)}`]);
        activations.push(id);
        if (failure === "activation-command" && id === external.window_id) {
          callback(new Error("activation failed"), "", "");
          return;
        }
        if (!(failure === "activation-ignored" && id === external.window_id)
            && !(failure === "restore-ignored" && id === desktop.window_id)) {
          desktop.focused = id === desktop.window_id;
          external.focused = id === external.window_id;
        }
        callback(null, backend === "i3" ? '[{"success":true}]' : "", "");
      } };
    },
  });
  vm.runInContext(patched.slice(patched.lastIndexOf(";function codexLinuxAppshotRequire")), context);
  context.codexLinuxAppshotBackendJson = async () => ({
    backend, windows: [structuredClone(desktop), structuredClone(external)],
  });
  context.codexLinuxAppshotX11Stacking = async () => [{ window_id: "0x100" }, { window_id: "0x200" }];
  context.codexLinuxAppshotDelay = async () => {};
  context.codexLinuxAppshotAccessibilityNodes = async () => ({ nodes: [], error: null });
  context.codexLinuxAppshotScreenshot = async (target) => {
    screenshots++;
    assert.equal(target.window_id, external.window_id);
    // Model the actual root screenshot: the covering Desktop supplies the pixels until activation.
    const dataURL = `data:image/png;base64,${desktop.focused ? "DESKTOP" : "CHROMIUM"}`;
    if (failure === "target-changed") external.pid = 999;
    if (failure === "focus-changed") { external.focused = false; desktop.focused = true; }
    if (failure === "bounds-changed") external.bounds.x = 20;
    return { dataURL };
  };
  context.codexLinuxAppshotSend = (_manager, _origin, _request, update) => {
    if (!initiallyFocused) assert.equal(desktop.focused, true, "restore before delivering any content");
    updates.push(update);
  };
  return {
    context, desktop, external, updates, activations,
    screenshots: () => screenshots,
    capture: () => context.codexLinuxAppshotCapture({ origin: "fixture", requestId: "fixture", windowManager: {} }),
  };
}

for (const backend of ["x11", "i3"]) {
  test(`AppShots activates the covered ${backend} target and restores Desktop before delivery`, async () => {
    const fixture = x11AppshotCaptureFixture({ backend });
    await fixture.capture();
    assert.equal(fixture.updates.find((update) => update.type === "metadata").app.name, "chromium");
    assert.equal(fixture.updates.find((update) => update.type === "screenshot").screenshotDataURL,
      "data:image/png;base64,CHROMIUM");
    assert.deepEqual(fixture.activations, [0x200, 0x100]);
    assert.equal(fixture.updates.at(-1).type, "completed");
  });
}

for (const failure of ["activation-command", "activation-ignored", "target-changed", "focus-changed", "bounds-changed", "restore-ignored"]) {
  test(`AppShots delivers no X11 attachment on ${failure}`, async () => {
    const fixture = x11AppshotCaptureFixture({ failure });
    await assert.rejects(fixture.capture(), /activate|capture-ready|changed during capture|focus restoration/);
    assert.deepEqual(fixture.updates, []);
    assert.equal(fixture.activations.at(-1), 0x100);
    if (failure.startsWith("activation")) assert.equal(fixture.screenshots(), 0);
  });
}

test("AppShots rejects an unfocused X11 fallback from an unsupported compositor backend", async () => {
  const fixture = x11AppshotCaptureFixture({ backend: "unsupported" });
  await assert.rejects(fixture.capture(), /Unsupported.*capture/);
  assert.deepEqual(fixture.updates, []);
  assert.deepEqual(fixture.activations, []);
  assert.equal(fixture.screenshots(), 0);
});

test("AppShots verifies an already focused X11 target without a focus handoff", async () => {
  const fixture = x11AppshotCaptureFixture({ initiallyFocused: true });
  await fixture.capture();
  assert.equal(fixture.updates.find((update) => update.type === "screenshot").screenshotDataURL,
    "data:image/png;base64,CHROMIUM");
  assert.deepEqual(fixture.activations, []);
  assert.equal(fixture.external.focused, true);

  const changed = x11AppshotCaptureFixture({ initiallyFocused: true, failure: "target-changed" });
  await assert.rejects(changed.capture(), /changed during capture/);
  assert.deepEqual(changed.updates, []);
});

test("AppShots restores ChatGPT after successful and failed Hyprland capture", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const ownWindow = {
    app_id: "codex-desktop",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
    pid: 101,
    window_id: 0x100,
    wm_class: "codex-desktop",
  };
  const selected = {
    app_id: "chromium",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
    title: "Example - Chromium",
    window_id: 0x200,
    wm_class: "chromium",
  };
  const report = {
    backend: "hyprland",
    focusedWindow: selected,
    returnWindow: ownWindow,
    windows: [{ ...ownWindow, focused: false }, selected],
  };
  const restoreCalls = [];
  const updates = [];
  const trace = [];

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotFocusedWindow = async () => report;
  context.codexLinuxAppshotPrepareWindowForCapture = async () => report;
  context.codexLinuxAppshotAccessibilityNodes = async () => ({
    error: null,
    nodes: [],
  });
  context.codexLinuxAppshotAccessibilityText = () => "accessibility text";
  context.codexLinuxAppshotVerifyCapturedWindow = async () => {
    trace.push("verify-captured-target");
    return selected;
  };
  context.codexLinuxAppshotScreenshot = async () => ({
    dataURL: "data:image/png;base64,AA==",
  });
  context.codexLinuxAppshotSend = (_manager, _origin, _requestId, update) => {
    updates.push(update.type);
    trace.push(`send:${update.type}`);
  };
  context.codexLinuxAppshotRestoreWindow = async (window) => {
    restoreCalls.push(window.window_id);
    trace.push(`restore:${window.window_id}`);
    return true;
  };

  await context.codexLinuxAppshotCapture({
    bundleIdentifier: "chromium",
    origin: "view",
    requestId: "success",
    windowManager: {},
  });
  assert.deepEqual(updates, ["metadata", "axText", "screenshot", "completed"]);
  assert.deepEqual(restoreCalls, [0x100]);
  assert.deepEqual(trace, [
    "verify-captured-target",
    "restore:256",
    "send:metadata",
    "send:axText",
    "send:screenshot",
    "send:completed",
  ]);

  restoreCalls.length = 0;
  trace.length = 0;
  context.codexLinuxAppshotScreenshot = async () => {
    throw new Error("Expected capture failure");
  };
  await assert.rejects(
    context.codexLinuxAppshotCapture({
      bundleIdentifier: "chromium",
      origin: "view",
      requestId: "failure",
      windowManager: {},
    }),
    /Expected capture failure/,
  );
  assert.deepEqual(restoreCalls, [0x100]);
  assert.deepEqual(trace, ["restore:256"]);

  updates.length = 0;
  restoreCalls.length = 0;
  trace.length = 0;
  context.codexLinuxAppshotScreenshot = async () => ({
    dataURL: "data:image/png;base64,AA==",
  });
  context.codexLinuxAppshotRestoreWindow = async (window) => {
    restoreCalls.push(window.window_id);
    trace.push(`restore-failed:${window.window_id}`);
    return false;
  };
  await assert.rejects(
    context.codexLinuxAppshotCapture({
      bundleIdentifier: "chromium",
      origin: "view",
      requestId: "restore-failure",
      windowManager: {},
    }),
    /Could not verify ChatGPT focus restoration/,
  );
  assert.deepEqual(updates, []);
  assert.deepEqual(restoreCalls, [0x100]);
  assert.deepEqual(trace, ["verify-captured-target", "restore-failed:256"]);
});

test("AppShots prefers direct X11 window capture before root screenshot fallback", () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    process: { env: {}, pid: 101, platform: "linux" },
    require() {
      throw new Error("No module access expected");
    },
  });

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });

  const directCapture = context.codexLinuxAppshotScreenshotCommands({
    backend: "x11",
    window_id: 0x200,
  })[0];
  assert.equal(directCapture.source, "imagemagick-window");
  assert.deepEqual(Array.from(directCapture.programs), ["import", "/usr/bin/import"]);
  assert.deepEqual(Array.from(directCapture.args), ["-window", "0x200"]);
  assert.equal(directCapture.output, "append");
  for (const window_id of [0, -1, NaN, 1.5, "invalid", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      context.codexLinuxAppshotScreenshotCommands({ backend: "x11", window_id })[0].source,
      "grim",
    );
  }
  assert.equal(
    context.codexLinuxAppshotScreenshotCommands({
      backend: "wayland",
      window_id: 0x200,
    })[0].source,
    "grim",
  );
});

test("AppShots captures accessibility and pixels concurrently", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const ownWindow = {
    app_id: "codex-desktop",
    focused: false,
    pid: 101,
    window_id: 0x100,
  };
  const selected = {
    app_id: "chromium",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
    window_id: 0x200,
  };
  const report = {
    backend: "hyprland",
    focusedWindow: selected,
    returnWindow: ownWindow,
    windows: [ownWindow, selected],
  };
  let releaseAccessibility;
  let screenshotStarted = false;

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotFocusedWindow = async () => report;
  context.codexLinuxAppshotPrepareWindowForCapture = async () => report;
  context.codexLinuxAppshotAccessibilityNodes = () =>
    new Promise((resolve) => {
      releaseAccessibility = () => resolve({ error: null, nodes: [] });
    });
  context.codexLinuxAppshotAccessibilityText = () => "";
  context.codexLinuxAppshotVerifyCapturedWindow = async () => selected;
  context.codexLinuxAppshotScreenshot = async () => {
    screenshotStarted = true;
    return { dataURL: "data:image/png;base64,AA==" };
  };
  context.codexLinuxAppshotRestoreWindow = async () => true;
  context.codexLinuxAppshotSend = () => {};

  const capture = context.codexLinuxAppshotCapture({
    bundleIdentifier: "chromium",
    origin: "view",
    requestId: "parallel",
    windowManager: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screenshotStarted, true);
  releaseAccessibility();
  await capture;
});

test("AppShots serializes capture transactions", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const scheduled = [];
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
  });
  const started = [];
  const releases = [];
  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotCapture = ({ requestId }) =>
    new Promise((resolve) => {
      started.push(requestId);
      releases.push(resolve);
    });
  context.codexLinuxAppshotSend = () => {};

  context.codexLinuxAppshotStartCapture({
    bundleIdentifier: "first",
    origin: "view",
    requestId: "first",
    windowManager: {},
  });
  context.codexLinuxAppshotStartCapture({
    bundleIdentifier: "second",
    origin: "view",
    requestId: "second",
    windowManager: {},
  });
  scheduled.splice(0).forEach((callback) => callback());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);

  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "second"]);
  releases.shift()();
  await vm.runInContext("codexLinuxAppshotCaptureQueue", context);
});

test("AppShots preserves window captures and cleans private temporary directories", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-private-capture-"));
  const captureDirs = [];
  const chmodModes = [];
  let failCaptures = false;
  let failDirectCapture = false;
  const cropArgs = [];

  assert.ok(helperStart >= 0);

  const fakeFs = {
    ...fs,
    mkdtempSync(prefix) {
      const captureDir = fs.mkdtempSync(prefix);
      captureDirs.push(captureDir);
      return captureDir;
    },
    chmodSync(target, mode) {
      chmodModes.push(mode);
      fs.chmodSync(target, mode);
    },
  };
  const fakeChildProcess = {
    execFile(program, args, options, callback) {
      if (failCaptures) {
        callback(new Error("Expected capture failure"), "", "expected failure");
        return;
      }
      if (program.endsWith("import") && args[1] === "0x200") {
        if (failDirectCapture) callback(new Error("Direct capture unavailable"), "", "");
        else {
          fs.writeFileSync(args.at(-1), "window source");
          callback(null, "", "");
        }
        return;
      }
      if (program.endsWith("grim")) {
        fs.writeFileSync(args.at(-1), "source");
        callback(null, "", "");
        return;
      }
      if (program.endsWith("identify")) {
        callback(null, "100 100", "");
        return;
      }
      if (program.endsWith("convert")) {
        cropArgs.push(args[2]);
        fs.writeFileSync(args.at(-1), "crop");
        callback(null, "", "");
        return;
      }
      callback(new Error(`Unexpected program: ${program}`), "", "unexpected program");
    },
  };
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: process.pid, platform: "linux", resourcesPath: "" },
    require(moduleName) {
      if (moduleName === "node:fs") return fakeFs;
      if (moduleName === "node:os") return { tmpdir: () => tempRoot };
      if (moduleName === "node:path") return path;
      if (moduleName === "node:child_process") return fakeChildProcess;
      if (moduleName === "electron") {
        return {
          nativeImage: {
            createFromPath: () => ({
              getSize: () => ({ width: 0, height: 0 }),
            }),
          },
        };
      }
      throw new Error(`Unexpected module: ${moduleName}`);
    },
    setTimeout,
  });

  try {
    vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
    const result = await context.codexLinuxAppshotScreenshot(
      { bounds: { height: 40, width: 50, x: 0, y: 0 } },
      [],
    );

    assert.equal(result?.width, 50);
    assert.equal(result?.height, 40);
    assert.match(result?.dataURL ?? "", /^data:image\/png;base64,/);
    assert.equal(captureDirs.length, 1);
    assert.equal(fs.existsSync(captureDirs[0]), false);

    for (const backend of ["x11", "i3"]) {
      const direct = await context.codexLinuxAppshotScreenshot(
        { backend, window_id: 0x200, bounds: { x: 20, y: 30, width: 50, height: 40 } },
        [],
      );
      assert.equal(direct.width, 100);
      assert.equal(direct.height, 100);
      assert.equal(cropArgs.at(-1), "100x100+0+0");
      assert.match(direct.source, /^imagemagick-window:/);
    }
    failDirectCapture = true;
    const fallback = await context.codexLinuxAppshotScreenshot(
      { backend: "x11", window_id: 0x200, bounds: { x: 20, y: 30, width: 50, height: 40 } },
      [],
    );
    assert.equal(fallback.width, 50);
    assert.equal(fallback.height, 40);
    assert.equal(cropArgs.at(-1), "50x40+20+30");
    assert.match(fallback.source, /^grim:/);

    const nativeCrops = [];
    const nativeImage = {
      createFromPath: () => ({
        getSize: () => ({ width: 100, height: 100 }),
        crop: (rect) => {
          nativeCrops.push({ ...rect });
          return { getSize: () => ({ width: rect.width, height: rect.height }) };
        },
      }),
    };
    const native = context.codexLinuxAppshotCropNativeImage(nativeImage, "source.png", null);
    assert.equal(native.width, 100);
    assert.equal(native.height, 100);
    assert.deepEqual(nativeCrops, [{ x: 0, y: 0, width: 100, height: 100 }]);
    assert.equal(context.codexLinuxAppshotCropNativeImage({
      createFromPath: () => ({ getSize: () => ({ width: NaN, height: NaN }) }),
    }, "invalid.png", null), null);

    failCaptures = true;
    const failedResult = await context.codexLinuxAppshotScreenshot(
      { bounds: { height: 40, width: 50, x: 0, y: 0 } },
      [],
    );

    assert.equal(failedResult, null);
    assert.ok(captureDirs.length > 1);
    assert.deepEqual(chmodModes, captureDirs.map(() => 0o700));
    assert.ok(captureDirs.every((captureDir) => !fs.existsSync(captureDir)));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("current AppShots hotkey owner supports Linux and registers a saved bare-modifier shortcut", () => {
  const pristine = currentAppshotHotkeyMainBundleFixture();
  const patched = applyPatchTwice(applyLinuxAppshotHotkeyPatch, pristine);

  assert.equal(matchesLinuxAppshotHotkeyContract(pristine), true);
  assert.equal(matchesLinuxAppshotHotkeyContract(patched), true);
  assert.match(patched, /"linux"===process\.platform\|\|"darwin"===process\.platform/);
  assert.match(patched, /"darwin"!==process\.platform&&"linux"!==process\.platform/);
  assert.match(patched, /"shift","super","meta","win"/);
  assert.match(patched, /"linux"===process\.platform\?null:"DoubleCommand"/);

  const context = vm.createContext({
    process: { env: { XDG_SESSION_TYPE: "x11" }, platform: "linux" },
  });
  vm.runInContext(patched, context);
  const noSavedShortcut = new context.AppshotHotkeys({ getStored() {} });
  assert.equal(noSavedShortcut.getState().supported, true);
  assert.equal(noSavedShortcut.getState().configuredHotkey, null);
  assert.equal(noSavedShortcut.getState().linuxWayland, false);
  assert.equal(noSavedShortcut.getState().isActive, false);

  const savedShortcut = new context.AppshotHotkeys({ getStored: () => "DoubleAlt" });
  assert.equal(savedShortcut.getState().supported, true);
  assert.equal(savedShortcut.getState().isActive, true);
  assert.equal(context.registered.hotkey, "DoubleAlt");
  assert.equal(context.hotkeyEligible("DoubleAlt"), true);
  assert.ok(["shift", "super", "meta", "win"].every((modifier) => context.modifiers.has(modifier)));
});

test("AppShots hotkey Linux eligibility remains disabled for Wayland bare modifiers", () => {
  const patched = applyLinuxAppshotHotkeyPatch(currentAppshotHotkeyMainBundleFixture());
  const context = vm.createContext({
    process: { env: { WAYLAND_DISPLAY: "wayland-0" }, platform: "linux" },
  });
  vm.runInContext(patched, context);
  assert.equal(context.hotkeyEligible("DoubleAlt"), false);
  assert.equal(new context.AppshotHotkeys({ getStored() {} }).getState().linuxWayland, true);
});

test("AppShots hotkey patch fails closed for missing, partial, duplicate, and ambiguous owners", () => {
  const pristine = currentAppshotHotkeyMainBundleFixture();
  const patched = applyLinuxAppshotHotkeyPatch(pristine);
  const partial = patched.replace(
    '"linux"===process.platform||"darwin"===process.platform',
    '"darwin"===process.platform',
  );
  const missing = "globalThis.appshotHotkeyState=`appshot-hotkey-state`";
  const retired = pristine.replace('let r=zk(e)??Qk(e)', 'let r=zk(e)');
  const mixedContracts = `${pristine}function(e,t,n="press"){var a,b;let c,d;if("darwin"!==process.platform)return null;let r=zk(e);}`;
  for (const source of [
    missing,
    retired,
    mixedContracts,
    partial,
    pristine + pristine,
    patched + patched,
    pristine + patched,
  ]) {
    assert.equal(matchesLinuxAppshotHotkeyContract(source), false);
    assert.deepEqual(captureWarnings(() => {
      assert.equal(applyLinuxAppshotHotkeyPatch(source), source);
    }), [
      "WARN: Could not find one complete current AppShots hotkey owner - skipping Linux AppShots hotkey patch",
    ]);
  }
});
