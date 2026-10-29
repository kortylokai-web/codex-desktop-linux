"use strict";

const fs = require("node:fs");
const { readMainProcessModules } = require("../../lib/assets.js");
const { escapeRegExp, findMatchingBrace } = require("../../lib/minified-js.js");

const HELPER_NAME = "codexLinuxQuitDialogParent";
const HELPER_SOURCE =
  "let codexLinuxQuitPromptPending=!1;" +
  `function ${HELPER_NAME}(e){` +
  "let t=require(`electron`).BrowserWindow,n=t.getFocusedWindow();" +
  "if(n!=null&&!n.isDestroyed()&&n.isVisible())return n;" +
  "n=e.windowManager.getPrimaryWindow();" +
  "if(n!=null&&!n.isDestroyed()&&n.isVisible())return n;" +
  "return t.getAllWindows().find(e=>!e.isDestroyed()&&e.isVisible())??null}";
const IDENT = "[A-Za-z_$][\\w$]*";

function quitFunctionRange(source) {
  const markers = [...source.matchAll(/messageId:"desktop\.quitConfirmation\.quit"/g)];
  if (markers.length !== 1) {
    throw new Error("Expected exactly one official Quit confirmation anchor");
  }
  const candidates = [...source.matchAll(/function\(\{isWindows:[^}]+\}\)\{/g)]
    .map((match) => {
      const bodyStart = match.index + match[0].length;
      return { start: match.index, bodyStart, end: findMatchingBrace(source, bodyStart - 1) + 1 };
    })
    .filter(({ bodyStart, end }) => bodyStart < markers[0].index && end > markers[0].index);
  if (candidates.length !== 1) {
    throw new Error("Could not isolate official Quit handler");
  }
  const range = candidates[0];
  const body = source.slice(range.start, range.end);
  if (!body.includes('.app.on("before-quit",') || !body.includes(".markAppQuitting()")) {
    throw new Error("Official Quit handler contract changed");
  }
  return { ...range, body };
}

function applyQuitConfirmationFocus(source) {
  const { start, bodyStart, end, body } = quitFunctionRange(source);
  const header = source.slice(start, bodyStart);
  const binding = (name) => {
    const matches = [...header.matchAll(new RegExp(`${name}:(${IDENT})(?=,|\\})`, "g"))];
    if (matches.length !== 1) throw new Error(`Official Quit binding changed: ${name}`);
    return matches[0][1];
  };
  const windows = binding("windows");
  const quitState = binding("quitState");
  const beforeQuit = [...body.matchAll(new RegExp(`(${IDENT})\\.app\\.on\\("before-quit",(${IDENT})=>\\{`, "g"))];
  if (beforeQuit.length !== 1) throw new Error("Expected one official before-quit handler");
  const [, appAlias, eventName] = beforeQuit[0];
  const guard = `if(codexLinuxQuitPromptPending){${eventName}.preventDefault();return}`;
  const asynchronousConfirmation = (options) =>
    `${eventName}.preventDefault();codexLinuxQuitPromptPending=!0;` +
    `let codexLinuxParent=${HELPER_NAME}(${windows});` +
    `let codexLinuxOptions=${options};` +
    `Promise.resolve().then(()=>codexLinuxParent?` +
    `${appAlias}.dialog.showMessageBox(codexLinuxParent,codexLinuxOptions):` +
    `${appAlias}.dialog.showMessageBox(codexLinuxOptions)).then(e=>{` +
    `codexLinuxQuitPromptPending=!1;if(e.response===0){` +
    `${quitState}.markQuitApproved();${appAlias}.app.quit()}}).catch(e=>{` +
    "codexLinuxQuitPromptPending=!1;" +
    "console.error(`[codex-desktop] Quit confirmation failed`,e)});return";

  if (source.includes(HELPER_NAME) || source.includes("codexLinuxQuitPromptPending")) {
    const optionsStart = body.indexOf("let codexLinuxOptions=") + "let codexLinuxOptions=".length;
    const optionsEnd = findMatchingBrace(body, optionsStart);
    const options = body.slice(optionsStart, optionsEnd + 1);
    if (body.startsWith(header + HELPER_SOURCE) &&
        body.includes(beforeQuit[0][0] + guard) &&
        body.includes(asynchronousConfirmation(options)) &&
        source.split(`function ${HELPER_NAME}(`).length === 2 &&
        !body.includes("showMessageBoxSync(")) {
      return source;
    }
    throw new Error("Incomplete Quit confirmation focus patch");
  }

  const confirmation = new RegExp(
    `0!==${escapeRegExp(appAlias)}\\.dialog\\.showMessageBoxSync\\((\\{[\\s\\S]*?\\})\\)` +
    `\\?${escapeRegExp(eventName)}\\.preventDefault\\(\\):\\(` +
    `${escapeRegExp(quitState)}\\.markQuitApproved\\(\\),${IDENT}=!0,` +
    `${escapeRegExp(windows)}\\.markAppQuitting\\(\\)\\)`, "g",
  );
  if ([...body.matchAll(confirmation)].length !== 1) {
    throw new Error("Expected one official synchronous Quit confirmation");
  }
  let patchedBody = body.replace(confirmation, (_match, options) => asynchronousConfirmation(options));
  patchedBody = patchedBody.replace(beforeQuit[0][0], beforeQuit[0][0] + guard);
  patchedBody = header + HELPER_SOURCE + patchedBody.slice(header.length);
  return source.slice(0, start) + patchedBody + source.slice(end);
}

function patchRequiredCoreBlockers(extractedDir) {
  const candidates = readMainProcessModules(extractedDir)
    .filter(({ source }) => source.includes("desktop.quitConfirmation.quit"));
  if (candidates.length !== 1) {
    throw new Error("Expected exactly one official main-process Quit module");
  }
  const [{ file, source }] = candidates;
  const patched = applyQuitConfirmationFocus(source);
  if (patched !== source) fs.writeFileSync(file, patched, "utf8");
  return { changed: patched !== source };
}

const descriptors = [{
  id: "quit-confirmation-focus",
  phase: "extracted-app:pre-webview",
  ciPolicy: "required-upstream",
  apply: patchRequiredCoreBlockers,
}];

module.exports = {
  HELPER_SOURCE,
  applyQuitConfirmationFocus,
  patchRequiredCoreBlockers,
  descriptors,
};
