"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { findMatchingBrace } = require("../lib/minified-js.js");

const COMPUTER_USE_UI_ENV_VAR = "CODEX_LINUX_ENABLE_COMPUTER_USE_UI";
const COMPUTER_USE_UI_SETTINGS_KEY = "codex-linux-computer-use-ui-enabled";
const COMPUTER_USE_CURSOR_HANDLER_MARKER =
  "setRemoteHostedPIPContentComputerUseCursorLocationHandler";
const LINUX_COMPUTER_USE_CURSOR_BRIDGE_MARKER =
  "codexLinuxRegisterComputerUseCursorHandler";

function linuxComputerUseCursorBridgeRuntimeSource() {
  return [
    "function codexLinuxComputerUseCursorComponent(e){return typeof e==`string`&&e!==`.`&&e!==`..`&&/^[A-Za-z0-9._-]+$/.test(e)}function codexLinuxComputerUseCursorSocketPath(){let e=process.env.XDG_RUNTIME_DIR?.trim();if(!e)return null;let t=require(`node:path`);if(!t.isAbsolute(e))return null;let n=(process.env.CODEX_LINUX_APP_ID||process.env.CODEX_APP_ID||`codex-desktop`).trim();codexLinuxComputerUseCursorComponent(n)||(n=`codex-desktop`);let r=process.env.CODEX_LINUX_INSTANCE_ID?.trim()||``;if(r&&!codexLinuxComputerUseCursorComponent(r))return null;let i=r?t.join(e,n,`instances`,r,`computer-use-cursor.sock`):t.join(e,n,`computer-use-cursor.sock`);return Buffer.byteLength(i,`utf8`)<=100?i:null}",
    "function codexLinuxRegisterComputerUseCursorHandler(e){let t=codexLinuxRegisterComputerUseCursorHandler;t.handler=e;if(t.server!=null)return!0;let n=codexLinuxComputerUseCursorSocketPath();if(n==null)return!1;try{let r=require(`node:path`),i=require(`node:fs`),a=require(`node:net`),o=require(`electron`),s=r.dirname(n),l=typeof process.getuid==`function`?process.getuid():null,u=i.lstatSync(process.env.XDG_RUNTIME_DIR.trim());if(!u.isDirectory()||u.isSymbolicLink()||l!=null&&u.uid!==l||(u.mode&63)!==0)return!1;i.mkdirSync(s,{recursive:!0,mode:448});let c=i.lstatSync(s);if(!c.isDirectory()||c.isSymbolicLink()||l!=null&&c.uid!==l)return!1;i.chmodSync(s,448);if(i.existsSync(n)){let e=i.lstatSync(n);if(!(e.isSocket()||e.isSymbolicLink())||l!=null&&e.uid!==l)return!1;i.unlinkSync(n)}let d=()=>{let e=t.socketIdentity;t.socketIdentity=null;if(e==null)return;try{let r=i.lstatSync(n);r.dev===e.dev&&r.ino===e.ino&&r.isSocket()&&i.unlinkSync(n)}catch{}},p=()=>{t.timer!=null&&(clearTimeout(t.timer),t.timer=null);let e=t.server;t.server=null;try{e?.close()}catch{}d()},m=()=>{try{let e=t.handler;if(typeof e!=`function`)return;let n=o.screen.getCursorScreenPoint();e({isActive:!0,x:n.x,y:n.y}),t.timer!=null&&clearTimeout(t.timer),t.timer=setTimeout(()=>{try{let e=t.handler;typeof e==`function`&&e({isActive:!1,x:n.x,y:n.y})}catch{}finally{t.timer=null}},900),t.timer.unref?.()}catch{}},f=a.createServer(e=>{let t=``,n=!1;e.setEncoding(`utf8`),e.setTimeout(250,()=>e.destroy()),e.on(`error`,()=>{}),e.on(`data`,r=>{if(n)return;t+=r;if(t.length>64){n=!0,e.destroy();return}if(t.includes(`\n`)){n=!0,t.trim()===`pointer`&&m(),e.end()}})});return t.server=f,f.on(`error`,()=>{t.server===f&&(t.server=null),d()}),f.listen(n,()=>{try{i.chmodSync(n,384);let e=i.lstatSync(n);if(!e.isSocket()||l!=null&&e.uid!==l)throw Error(`unsafe cursor socket`);t.socketIdentity={dev:e.dev,ino:e.ino},f.unref()}catch{p()}}),t.cleanupRegistered||(t.cleanupRegistered=!0,o.app.once(`before-quit`,p)),!0}catch{return t.server=null,!1}}",
  ].join("");
}

function applyLinuxComputerUseAvatarCursorBridgePatch(source) {
  const pattern = /function\((?<handler>[\w$]+),\{addon:[\w$]+,electronAppPath:[\w$]+,platform:(?<platform>[\w$]+)=process\.platform,resourcesPath:[\w$]+=process\.resourcesPath\}=\{\}\)\{(?<linux>if\("linux"===\k<platform>\)return codexLinuxRegisterComputerUseCursorHandler\(\k<handler>\);)?if\("darwin"===\k<platform>\)try\{/g;
  const matches = [...source.matchAll(pattern)].filter(match => {
    // Locate the body after the destructured options, not its default object.
    const body = match.index + match[0].indexOf("){", match[0].indexOf("={}")) + 1;
    const end = findMatchingBrace(source, body);
    return source.slice(body, end).includes(COMPUTER_USE_CURSOR_HANDLER_MARKER);
  });
  const markerCount = source.split(COMPUTER_USE_CURSOR_HANDLER_MARKER).length - 1;
  if (matches.length !== 1 || markerCount !== 1) {
    console.warn("WARN: Could not identify unique current Computer Use cursor registration - skipping Linux avatar cursor bridge patch");
    return source;
  }
  const match = matches[0];
  const runtime = linuxComputerUseCursorBridgeRuntimeSource();
  const runtimeNames = [
    LINUX_COMPUTER_USE_CURSOR_BRIDGE_MARKER,
    "codexLinuxComputerUseCursorComponent",
    "codexLinuxComputerUseCursorSocketPath",
  ];
  const runtimeCount = source.split(runtime).length - 1;
  const remainder = source.replace(runtime, "").replace(match.groups.linux ?? "", "");
  if (match.groups.linux != null && runtimeCount === 1 &&
      !runtimeNames.some(name => remainder.includes(name))) return source;
  if (match.groups.linux != null || runtimeNames.some(name => source.includes(name))) {
    console.warn("WARN: Incomplete Linux avatar cursor bridge runtime or dispatch guard");
    return source;
  }
  const guard = `if("darwin"===${match.groups.platform})try{`;
  const replacement = match[0].replace(guard,
    `if("linux"===${match.groups.platform})return codexLinuxRegisterComputerUseCursorHandler(${match.groups.handler});${guard}`);
  return runtime + source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

// Computer Use has two postures: the bundled plugin gate is default-on Linux
// platform glue; the visible UI gates remain opt-in because they bypass rollout
// checks in upstream webview code.
function isComputerUseUiEnabled(env = process.env) {
  if (env[COMPUTER_USE_UI_ENV_VAR] === "1") {
    return true;
  }
  return readComputerUseUiSettingsFlag(env);
}

function readComputerUseUiSettingsFlag(env) {
  const settingsPath = computerUseUiSettingsPath(env);
  if (settingsPath == null) {
    return false;
  }
  try {
    if (!fs.existsSync(settingsPath)) {
      return false;
    }
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    return parsed[COMPUTER_USE_UI_SETTINGS_KEY] === true;
  } catch {
    return false;
  }
}

function computerUseUiSettingsPath(env) {
  const override = env.CODEX_LINUX_SETTINGS_FILE;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  const xdgConfig = env.XDG_CONFIG_HOME;
  const home = env.HOME;
  const configHome = (xdgConfig && xdgConfig.length > 0)
    ? xdgConfig
    : home
      ? path.join(home, ".config")
      : null;
  if (configHome == null) {
    return null;
  }
  const appId = computerUseUiSettingsAppId(env);
  return path.join(configHome, appId, "settings.json");
}

function computerUseUiSettingsAppId(env) {
  const appId = env.CODEX_LINUX_APP_ID || env.CODEX_APP_ID || "codex-desktop";
  return /^[A-Za-z0-9._-]+$/.test(appId) ? appId : "codex-desktop";
}

function applyLinuxComputerUseFeaturePatch(source) {
  const pattern = /let (?<gate>[\w$]+)=(?<linux>"linux"===(?<linuxPlatform>[\w$]+)\?\{\.\.\.(?<linuxFeatures>[\w$]+),computerUse:!0\}:)?"win32"===(?<platform>[\w$]+)&&"1"===(?<env>[\w$]+)\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE\?\{\.\.\.(?<features>[\w$]+),computerUse:!0\}:\k<features>,/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    console.warn("WARN: Could not find unique current Computer Use desktop feature gate - skipping Linux Computer Use feature patch");
    return source;
  }
  const match = matches[0];
  const { gate, linux, linuxPlatform, linuxFeatures, platform, features } = match.groups;
  if (linux != null) {
    if (linuxPlatform !== platform || linuxFeatures !== features) console.warn("WARN: Inconsistent Linux Computer Use desktop feature gate");
    return source;
  }
  const replacement = match[0].replace(`let ${gate}=`, `let ${gate}="linux"===${platform}?{...${features},computerUse:!0}:`);
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

function applyCurrentComputerUseHostPlatformContract(currentSource) {
  const contractPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{areRequirementsPending:([A-Za-z_$][\w$]*),areRequiredFeaturesEnabled:([A-Za-z_$][\w$]*),enabled:([A-Za-z_$][\w$]*),isBrowserAndComputerUseAllowed:([A-Za-z_$][\w$]*),isAnyFeatureLoading:([A-Za-z_$][\w$]*),isComputerUseGateEnabled:([A-Za-z_$][\w$]*),isHostCompatiblePlatform:([^,{}]+),isPlatformLoading:([A-Za-z_$][\w$]*),windowType:`electron`\}\)/g;
  const candidates = [];
  let match;
  while ((match = contractPattern.exec(currentSource)) != null) {
    const context = currentSource.slice(Math.max(0, match.index - 1200), match.index + match[0].length);
    if (!context.includes("featureName:`computer_use`")) {
      continue;
    }

    const hostExpression = match[9];
    const pristine = hostExpression.match(
      /^([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)$/,
    );
    const patched = hostExpression.match(
      /^([A-Za-z_$][\w$]*)===`linux`\|\|([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)$/,
    );
    let kind = "malformed";
    let platformVar = null;
    if (pristine != null) {
      kind = "pristine";
      platformVar = pristine[2];
    } else if (patched != null && patched[1] === patched[3]) {
      kind = "patched";
      platformVar = patched[1];
    }
    candidates.push({ hostExpression, kind, match, platformVar });
  }

  if (candidates.length !== 1 || candidates[0].kind === "malformed") {
    return null;
  }

  const candidate = candidates[0];
  if (candidate.kind === "patched") {
    return currentSource;
  }

  const hostExpressionStart = candidate.match.index +
    candidate.match[0].indexOf(candidate.hostExpression);
  const hostExpressionEnd = hostExpressionStart + candidate.hostExpression.length;
  return currentSource.slice(0, hostExpressionStart) +
    `${candidate.platformVar}===\`linux\`||${candidate.hostExpression}` +
    currentSource.slice(hostExpressionEnd);
}

function matchesLinuxComputerUseHostPlatformContract(currentSource) {
  return applyCurrentComputerUseHostPlatformContract(currentSource) != null;
}

function applyLinuxComputerUseHostPlatformPatch(currentSource) {
  const patchedSource = applyCurrentComputerUseHostPlatformContract(currentSource);
  if (patchedSource != null) {
    return patchedSource;
  }

  console.warn(
    "WARN: Could not find current Computer Use host-platform gate — skipping Linux Computer Use host-platform patch",
  );
  return currentSource;
}

module.exports = {
  COMPUTER_USE_UI_ENV_VAR,
  COMPUTER_USE_UI_SETTINGS_KEY,
  applyLinuxComputerUseAvatarCursorBridgePatch,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseHostPlatformPatch,
  isComputerUseUiEnabled,
  linuxComputerUseCursorBridgeRuntimeSource,
  matchesLinuxComputerUseHostPlatformContract,
};
