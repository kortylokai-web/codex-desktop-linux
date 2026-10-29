#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  applyQuitConfirmationFocus,
  descriptors,
  patchRequiredCoreBlockers,
} = require("./patch.js");

// This shape comes from the signed official Linux main bundle. Keep the
// fixture independent of patch.js so upstream confirmation drift is visible.
const OFFICIAL_BUNDLE =
  'const register=function({isWindows:e,disableQuitConfirmationPrompt:t,quitState:r,windows:n}){' +
  'let y=!1,v=!1;ea.app.on("before-quit",i=>{' +
  'if(e||r.canQuitWithoutPrompt()||t){v=!0,n.markAppQuitting();return}' +
  'let u="Quit?";0!==ea.dialog.showMessageBoxSync({message:u,buttons:[{messageId:"desktop.quitConfirmation.quit"},"Cancel"]})' +
  '?i.preventDefault():(r.markQuitApproved(),v=!0,n.markAppQuitting())}),' +
  'ea.app.on("will-quit",t=>{Promise.allSettled([flush(),save()]).then(()=>ea.app.quit())})};' +
  'function next(){}';

test("one required descriptor owns the portable Quit repair", () => {
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].id, "quit-confirmation-focus");
  assert.equal(descriptors[0].phase, "extracted-app:pre-webview");
  assert.equal(descriptors[0].ciPolicy, "required-upstream");
  assert.equal(Object.hasOwn(descriptors[0], "appliesTo"), false);
});

test("required core descriptor discovers renamed modules without touching shell startup", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "required-core-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildDir = path.join(root, ".vite", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  const main = path.join(buildDir, "early-bootstrap-renamed.cjs");
  const shell = path.join(buildDir, "shell-fixture.js");
  const shellSource = 'async function upstreamShell(){await app.whenReady();return loadShell()}';
  fs.writeFileSync(main, OFFICIAL_BUNDLE);
  fs.writeFileSync(shell, shellSource);
  assert.deepEqual(patchRequiredCoreBlockers(root), { changed: true });
  assert.match(fs.readFileSync(main, "utf8"), /codexLinuxQuitDialogParent/);
  assert.equal(fs.readFileSync(shell, "utf8"), shellSource);
  assert.deepEqual(patchRequiredCoreBlockers(root), { changed: false });

  const duplicate = path.join(buildDir, "other-name.mjs");
  fs.writeFileSync(main, OFFICIAL_BUNDLE);
  fs.copyFileSync(main, duplicate);
  assert.throws(() => patchRequiredCoreBlockers(root), /exactly one official main-process Quit module/);
  assert.equal(fs.readFileSync(main, "utf8"), OFFICIAL_BUNDLE);
  assert.equal(fs.readFileSync(shell, "utf8"), shellSource);
});

function window(id, { destroyed = false, visible = true } = {}) {
  return {
    id,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
  };
}

function harness({ focused = window(7), primary = window(3), others = [], dialogFailure = null } = {}) {
  const handlers = new Map();
  const dialogCalls = [];
  const errors = [];
  let resolveDialog;
  let prevented = 0;
  let accepted = 0;
  let quitCalls = 0;
  let approved = false;
  const emitBeforeQuit = () => {
    const event = { preventDefault: () => { prevented += 1; } };
    for (const handler of handlers.get("before-quit") ?? []) {
      handler(event);
    }
  };
  const context = {
    Promise,
    console: { error: (...args) => errors.push(args) },
    require: (name) => {
      assert.equal(name, "electron");
      return {
        BrowserWindow: {
          getFocusedWindow: () => focused,
          getAllWindows: () => others,
        },
      };
    },
    ea: {
      app: {
        on: (name, callback) => handlers.set(name, [...handlers.get(name) ?? [], callback]),
        quit: () => {
          quitCalls += 1;
          emitBeforeQuit();
        },
      },
      dialog: {
        showMessageBoxSync: () => {
          throw new Error("synchronous dialog must not run");
        },
        showMessageBox: (...args) => {
          dialogCalls.push(args);
          if (dialogFailure) return Promise.reject(dialogFailure);
          return new Promise((resolve) => { resolveDialog = resolve; });
        },
      },
    },
  };
  const register = vm.runInNewContext(
    `${applyQuitConfirmationFocus(OFFICIAL_BUNDLE)};register`,
    context,
  );
  register({
    isWindows: false,
    quitState: {
      canQuitWithoutPrompt: () => approved,
      markQuitApproved: () => { approved = true; },
    },
    windows: {
      windowManager: { getPrimaryWindow: () => primary },
      markAppQuitting: () => { accepted += 1; },
    },
  });
  return {
    answer: (response) => resolveDialog({ response }),
    dialogCalls,
    emitBeforeQuit,
    errors,
    get accepted() { return accepted; },
    get prevented() { return prevented; },
    get quitCalls() { return quitCalls; },
  };
}

const tick = () => new Promise(setImmediate);

test("patches only the official confirmation and is idempotent", () => {
  const patched = applyQuitConfirmationFocus(OFFICIAL_BUNDLE);
  assert.match(patched, /codexLinuxQuitDialogParent\(n\)/);
  assert.match(patched, /dialog\.showMessageBox\(codexLinuxParent,codexLinuxOptions\)/);
  assert.doesNotMatch(patched, /showMessageBoxSync\(/);
  assert.match(patched, /Promise\.allSettled\(\[flush\(\),save\(\)\]\)/);
  assert.equal(applyQuitConfirmationFocus(patched), patched);
  new vm.Script(patched);
});

test("fails closed when the official Quit confirmation changes or is ambiguous", () => {
  assert.throws(
    () => applyQuitConfirmationFocus(OFFICIAL_BUNDLE.replace("showMessageBoxSync", "showMessageBox")),
    /Expected one official synchronous Quit confirmation/,
  );
  assert.throws(
    () => applyQuitConfirmationFocus(OFFICIAL_BUNDLE.replace("quitState:r", "quitStateChanged:r")),
    /Official Quit binding changed: quitState/,
  );
  assert.throws(
    () => applyQuitConfirmationFocus(OFFICIAL_BUNDLE.replace("markQuitApproved", "approveQuit")),
    /Expected one official synchronous Quit confirmation/,
  );
  assert.throws(
    () => applyQuitConfirmationFocus(`${OFFICIAL_BUNDLE}${OFFICIAL_BUNDLE}`),
    /Expected exactly one official Quit confirmation anchor/,
  );
});

test("parents the confirmation, prevents reentrancy, and resumes Quit on approval", async () => {
  const app = harness();
  app.emitBeforeQuit();
  assert.equal(app.prevented, 1);
  assert.equal(app.dialogCalls.length, 0);
  await tick();
  assert.equal(app.dialogCalls.length, 1);
  assert.equal(app.dialogCalls[0][0].id, 7);
  assert.equal(app.dialogCalls[0][1].message, "Quit?");

  app.emitBeforeQuit();
  assert.equal(app.prevented, 2);
  assert.equal(app.dialogCalls.length, 1);

  app.answer(0);
  await tick();
  assert.equal(app.quitCalls, 1);
  assert.equal(app.accepted, 1);
  assert.deepEqual(app.errors, []);
});

test("uses the visible primary window and allows a later Quit after cancellation", async () => {
  const app = harness({ focused: null });
  app.emitBeforeQuit();
  await tick();
  assert.equal(app.dialogCalls[0][0].id, 3);
  app.answer(1);
  await tick();
  assert.equal(app.quitCalls, 0);
  assert.equal(app.accepted, 0);

  app.emitBeforeQuit();
  await tick();
  assert.equal(app.dialogCalls.length, 2);
  app.answer(0);
  await tick();
  assert.equal(app.accepted, 1);
});

test("falls back to another visible live window", async () => {
  const app = harness({
    focused: window(2, { destroyed: true }),
    primary: window(3, { visible: false }),
    others: [window(4, { visible: false }), window(5)],
  });
  app.emitBeforeQuit();
  await tick();
  assert.equal(app.dialogCalls[0][0].id, 5);
  app.answer(1);
  await tick();
  assert.equal(app.accepted, 0);
});

test("uses an unparented asynchronous dialog when no live visible window exists", async () => {
  const app = harness({ focused: null, primary: null });
  app.emitBeforeQuit();
  await tick();
  assert.equal(app.dialogCalls[0].length, 1);
  assert.equal(app.dialogCalls[0][0].message, "Quit?");
  app.answer(1);
  await tick();
  assert.equal(app.accepted, 0);
});

test("dialog failures keep the app open and allow another Quit attempt", async () => {
  const app = harness({ dialogFailure: new Error("dialog unavailable") });
  app.emitBeforeQuit();
  await tick();
  assert.equal(app.errors.length, 1);
  assert.equal(app.accepted, 0);
  assert.equal(app.quitCalls, 0);
  app.emitBeforeQuit();
  await tick();
  assert.equal(app.dialogCalls.length, 2);
});

test("rejects a partial patch instead of treating it as already applied", () => {
  const patched = applyQuitConfirmationFocus(OFFICIAL_BUNDLE);
  assert.throws(() => applyQuitConfirmationFocus(
    patched.replace("if(codexLinuxQuitPromptPending)", "if(false)")), /Incomplete Quit confirmation focus patch/);
});

test("applies the required Quit repair to the uniquely anchored signed module", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, (t) => {
  const { readMainProcessModules } = require("../../lib/assets.js");
  const candidates = readMainProcessModules(process.env.CODEX_SIGNED_EXTRACTED_APP)
    .filter(({ source }) => source.includes("desktop.quitConfirmation.quit"));
  assert.equal(candidates.length, 1,
    `expected one signed Quit anchor, found: ${candidates.map(({ name }) => name).join(", ")}`);
  const source = candidates[0].source;
  const patched = applyQuitConfirmationFocus(source);
  assert.notEqual(patched, source);
  assert.match(patched, /function codexLinuxQuitDialogParent\(/);
  assert.match(patched, /codexLinuxQuitPromptPending=!0/);
  assert.equal(applyQuitConfirmationFocus(patched), patched);
  new vm.Script(patched);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signed-required-core-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtureBuild = path.join(root, ".vite", "build");
  fs.mkdirSync(fixtureBuild, { recursive: true });
  fs.writeFileSync(path.join(fixtureBuild, "renamed-main.js"), source);
  assert.deepEqual(patchRequiredCoreBlockers(root), { changed: true });
  assert.equal(fs.readFileSync(path.join(fixtureBuild, "renamed-main.js"), "utf8"), patched);
});
