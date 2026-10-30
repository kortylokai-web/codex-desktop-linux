"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

// Detection only: escaped spellings can bind the same JavaScript identifier.
// Decode conservatively for validation; never emit these normalized bytes.
function decodeJavaScriptIdentifierEscapesForValidation(source) {
  return source.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,
    (match, braced, fixed) => {
      const code = Number.parseInt(braced ?? fixed, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    });
}

const APPSHOT_HELPER_MARKER = "codexLinuxAppshotStartCapture";
const APPSHOT_AVAILABILITY_MARKER = "codexLinuxAppshotsPlatformAvailable";
const IDENT = "[A-Za-z_$][\\w$]*";
const CURRENT_APPSHOT_AVAILABILITY = new RegExp(
  `(requirements\\?\\.allowAppshots!==!1\\}function (${IDENT})\\((${IDENT})\\)\\{return )` +
    `\\3===\\\`macOS\\\`\\|\\|\\3===\\\`windows\\\`\\}`,
  "g",
);
const PATCHED_APPSHOT_AVAILABILITY = new RegExp(
  `requirements\\?\\.allowAppshots!==!1\\}function ${IDENT}\\((${IDENT})\\)\\{return ` +
    `\\1===\\\`linux\\\`\\/\\*${APPSHOT_AVAILABILITY_MARKER}\\*\\/\\|\\|` +
    `\\1===\\\`macOS\\\`\\|\\|\\1===\\\`windows\\\`\\}`,
);

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function applyLinuxAppshotAvailabilityPatch(currentSource) {
  if (currentSource.includes(APPSHOT_AVAILABILITY_MARKER)) {
    return currentSource;
  }
  const matches = [...currentSource.matchAll(CURRENT_APPSHOT_AVAILABILITY)];
  if (matches.length === 1) {
    return currentSource.replace(
      CURRENT_APPSHOT_AVAILABILITY,
      (_match, prefix, _functionName, platformVar) =>
        `${prefix}${platformVar}===\`linux\`/*${APPSHOT_AVAILABILITY_MARKER}*/||${platformVar}===\`macOS\`||${platformVar}===\`windows\`}`,
    );
  }

  if (currentSource.includes("macOS") || currentSource.includes("appshot")) {
    warn("Could not find AppShots availability gate", "Linux AppShots availability patch");
  }
  return currentSource;
}

function matchesLinuxAppshotAvailabilityContract(source) {
  CURRENT_APPSHOT_AVAILABILITY.lastIndex = 0;
  return [...source.matchAll(CURRENT_APPSHOT_AVAILABILITY)].length === 1 ||
    PATCHED_APPSHOT_AVAILABILITY.test(source);
}

function linuxAppshotWaylandHelperSource() {
  return "function codexLinuxAppshotIsWayland(){return process.platform===`linux`&&((process.env.XDG_SESSION_TYPE||``).toLowerCase()===`wayland`||!!process.env.WAYLAND_DISPLAY)}";
}

function appshotHotkeyPatterns(source) {
  // Rspack inlines the native registration function; bind eligibility to its normalizer.
  const registrationPrefix = `function\\((${IDENT}),(${IDENT}),(${IDENT})="press"\\)\\{(var ${IDENT}(?:,${IDENT})*;let ${IDENT}(?:,${IDENT})*;)`;
  const registrations = [...source.matchAll(new RegExp(
    registrationPrefix + `if\\("darwin"!==process\\.platform(?:&&"linux"!==process\\.platform)?\\)return null;let ${IDENT}=(${IDENT})\\(\\1\\)(?:\\?\\?${IDENT}\\(\\1\\))?;`, "g",
  ))];
  const normalize = registrations.length === 1
    ? registrations[0][5].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : "(?!)";
  return [
    {
      current: new RegExp(`function (${IDENT})\\((${IDENT}),(${IDENT})=process\\.platform\\)\\{return"darwin"===\\3&&null!=(${normalize})\\(\\2\\)\\}`, "g"),
      patched: new RegExp(`function (${IDENT})\\((${IDENT}),(${IDENT})=process\\.platform\\)\\{return\\("darwin"===\\3\\|\\|"linux"===\\3&&!codexLinuxAppshotIsWayland\\(\\)\\)&&null!=(${normalize})\\(\\2\\)\\}`, "g"),
      replace: (_match, fn, hotkey, platform, normalize) =>
        `function ${fn}(${hotkey},${platform}=process.platform){return("darwin"===${platform}||"linux"===${platform}&&!codexLinuxAppshotIsWayland())&&null!=${normalize}(${hotkey})}`,
    },
    {
      current: new RegExp(registrationPrefix + `if\\("darwin"!==process\\.platform\\)return null;let (${IDENT})=(${IDENT})\\(\\1\\)\\?\\?(${IDENT})\\(\\1\\);`, "g"),
      patched: new RegExp(registrationPrefix + `if\\("darwin"!==process\\.platform&&"linux"!==process\\.platform\\)return null;let (${IDENT})=(${IDENT})\\(\\1\\)\\?\\?(${IDENT})\\(\\1\\);`, "g"),
      replace: (_match, hotkey, handlers, trigger, declarations, value, normalize, fallback) =>
        `function(${hotkey},${handlers},${trigger}="press"){${declarations}if("darwin"!==process.platform&&"linux"!==process.platform)return null;let ${value}=${normalize}(${hotkey})??${fallback}(${hotkey});`,
    },
    {
      current: /new Set\(\[\.\.\.([A-Za-z_$][\w$]*),"shift"\]\)/g,
      patched: /new Set\(\[\.\.\.([A-Za-z_$][\w$]*),"shift","super","meta","win"\]\)/g,
      replace: (_match, base) => `new Set([...${base},"shift","super","meta","win"])`,
    },
    {
      current: /void 0===([A-Za-z_$][\w$]*)\?this\.configuredHotkey="win32"===process\.platform\?"DoubleAlt":"DoubleCommand":this\.configuredHotkey=\1/g,
      patched: /void 0===([A-Za-z_$][\w$]*)\?this\.configuredHotkey="win32"===process\.platform\?"DoubleAlt":"linux"===process\.platform\?null:"DoubleCommand":this\.configuredHotkey=\1/g,
      replace: (_match, stored) => `void 0===${stored}?this.configuredHotkey="win32"===process.platform?"DoubleAlt":"linux"===process.platform?null:"DoubleCommand":this.configuredHotkey=${stored}`,
    },
    {
      current: /supported:this\.enabled&&\("darwin"===process\.platform\|\|"win32"===process\.platform&&null!=this\.windowsCaptureNativeBridge&&!this\.windowsCaptureNativeBridgeFailed\),configuredHotkey:this\.configuredHotkey,isActive:null!=this\.registration/g,
      patched: /supported:this\.enabled&&\("linux"===process\.platform\|\|"darwin"===process\.platform\|\|"win32"===process\.platform&&null!=this\.windowsCaptureNativeBridge&&!this\.windowsCaptureNativeBridgeFailed\),configuredHotkey:this\.configuredHotkey,isActive:null!=this\.registration,linuxWayland:codexLinuxAppshotIsWayland\(\)/g,
      replace: 'supported:this.enabled&&("linux"===process.platform||"darwin"===process.platform||"win32"===process.platform&&null!=this.windowsCaptureNativeBridge&&!this.windowsCaptureNativeBridgeFailed),configuredHotkey:this.configuredHotkey,isActive:null!=this.registration,linuxWayland:codexLinuxAppshotIsWayland()',
    },
  ];
}

function appshotHotkeyState(source) {
  const patterns = appshotHotkeyPatterns(source);
  const currentCounts = patterns.map(({ current }) => [...source.matchAll(current)].length);
  const patchedCounts = patterns.map(({ patched }) => [...source.matchAll(patched)].length);
  const helper = linuxAppshotWaylandHelperSource();
  const helperCount = source.split(helper).length - 1;
  if (currentCounts.every((count) => count === 1) &&
      patchedCounts.every((count) => count === 0) && helperCount === 0 &&
      !decodeJavaScriptIdentifierEscapesForValidation(source).includes("codexLinuxAppshotIsWayland")) {
    return { kind: "current", patterns };
  }
  if (currentCounts.every((count) => count === 0) &&
      patchedCounts.every((count) => count === 1) && helperCount === 1 &&
      [...decodeJavaScriptIdentifierEscapesForValidation(source.replace(helper, "")).matchAll(/\bcodexLinuxAppshotIsWayland\b/g)].length === 2) {
    return { kind: "patched", patterns };
  }
  if (currentCounts.every(count => count === 0) && patchedCounts.every(count => count === 0) &&
      !/appshotHotkey|appshot-hotkey-state|codexLinuxAppshotIsWayland/.test(
        decodeJavaScriptIdentifierEscapesForValidation(source))) return { kind: "absent" };
  return { kind: "invalid" };
}

function matchesLinuxAppshotHotkeyContract(source) {
  const state = appshotHotkeyState(source);
  return state.kind === "current" || state.kind === "patched";
}

function applyLinuxAppshotHotkeyPatch(source) {
  const state = appshotHotkeyState(source);
  if (state.kind === "patched") return source;
  if (state.kind !== "current") {
    if (source.includes("appshotHotkey") || source.includes("appshot-hotkey-state")) {
      warn("Could not find one complete current AppShots hotkey owner", "Linux AppShots hotkey patch");
    }
    return source;
  }
  let patched = source;
  for (const { current, replace } of state.patterns) patched = patched.replace(current, replace);
  patched = linuxAppshotWaylandHelperSource() + patched;
  return appshotHotkeyState(patched).kind === "patched" ? patched : source;
}

function appshotCapturePatterns() {
  return [
    {
      current: /appshotCapture:"darwin"===process\.platform&&null!=this\.options\.requestComputerUseWorker&&null!=this\.options\.subscribeComputerUseCaptureWorkerEvent\|\|"win32"===process\.platform&&null!=this\.options\.windowsCaptureNativeBridge\?new [A-Za-z_$][\w$]*\(\{origin:[A-Za-z_$][\w$]*,settings:this\.settings,windowManager:[A-Za-z_$][\w$]*,requestComputerUseCaptureWorker:this\.options\.requestComputerUseWorker,subscribeComputerUseCaptureWorkerEvent:this\.options\.subscribeComputerUseCaptureWorkerEvent,windowsCaptureNativeBridge:this\.options\.windowsCaptureNativeBridge\}\):void 0/g,
      patched: /appshotCapture:"linux"===process\.platform\|\|"darwin"===process\.platform&&null!=this\.options\.requestComputerUseWorker&&null!=this\.options\.subscribeComputerUseCaptureWorkerEvent\|\|"win32"===process\.platform&&null!=this\.options\.windowsCaptureNativeBridge\?new [A-Za-z_$][\w$]*\(\{origin:[A-Za-z_$][\w$]*,settings:this\.settings,windowManager:[A-Za-z_$][\w$]*,requestComputerUseCaptureWorker:this\.options\.requestComputerUseWorker,subscribeComputerUseCaptureWorkerEvent:this\.options\.subscribeComputerUseCaptureWorkerEvent,windowsCaptureNativeBridge:this\.options\.windowsCaptureNativeBridge\}\):void 0/g,
      replace: match => match.replace('appshotCapture:', 'appshotCapture:"linux"===process.platform||'),
    },
    {
      current: /async getFrontmostWindow\(\)\{return this\.abortController\.signal\.aborted\?null:(?="win32"===process\.platform)/g,
      patched: /async getFrontmostWindow\(\)\{return this\.abortController\.signal\.aborted\?null:"linux"===process\.platform\?codexLinuxAppshotFrontmostWindow\(this\.abortController\.signal\):(?="win32"===process\.platform)/g,
      replace: 'async getFrontmostWindow(){return this.abortController.signal.aborted?null:"linux"===process.platform?codexLinuxAppshotFrontmostWindow(this.abortController.signal):',
    },
    {
      current: new RegExp(`(async start\\(\\{animationDestination:(${IDENT}),animationPresentationStyle:(${IDENT}),bundleIdentifier:(${IDENT}),requestId:(${IDENT})\\}\\)\\{let\\{origin:(${IDENT}),settings:${IDENT},windowManager:(${IDENT}),requestComputerUseCaptureWorker:${IDENT},subscribeComputerUseCaptureWorkerEvent:${IDENT},windowsCaptureNativeBridge:${IDENT}\\}=this\\.options;if\\(this\\.abortController\\.signal\\.aborted\\)return null;)(?!if\\("linux")`, "g"),
      patched: new RegExp(`async start\\(\\{animationDestination:(${IDENT}),animationPresentationStyle:(${IDENT}),bundleIdentifier:(${IDENT}),requestId:(${IDENT})\\}\\)\\{let\\{origin:(${IDENT}),settings:${IDENT},windowManager:(${IDENT}),requestComputerUseCaptureWorker:${IDENT},subscribeComputerUseCaptureWorkerEvent:${IDENT},windowsCaptureNativeBridge:${IDENT}\\}=this\\.options;if\\(this\\.abortController\\.signal\\.aborted\\)return null;if\\("linux"===process\\.platform\\)return codexLinuxAppshotStartCapture\\(\\{origin:\\5,requestId:\\4,bundleIdentifier:\\3,windowManager:\\6,signal:this\\.abortController\\.signal\\}\\);`, "g"),
      replace: (_match, prefix, _destination, _style, bundle, request, origin, manager) => `${prefix}if("linux"===process.platform)return codexLinuxAppshotStartCapture({origin:${origin},requestId:${request},bundleIdentifier:${bundle},windowManager:${manager},signal:this.abortController.signal});`,
    },
  ];
}

function matchesAppshotCaptureOwner(source, patterns, kind) {
  const matches = patterns.map(pattern => [...source.matchAll(pattern[kind])]);
  if (!matches.every(found => found.length === 1)) return false;
  const [factory, frontmost, start] = matches.map(found => found[0]);
  const headers = [...source.matchAll(new RegExp(
    `class (${IDENT}) extends ${IDENT}(?:\\.${IDENT})?\\{options;abortController=new AbortController;constructor\\((${IDENT})\\)\\{super\\(\\),this\\.options=\\2\\}\\[Symbol\\.dispose\\]\\(\\)\\{this\\.abortController\\.abort\\(\\)\\}`,
    "g",
  ))].filter(header => header.index + header[0].length === frontmost.index);
  if (headers.length !== 1) return false;
  const header = headers[0], name = header[1];
  // Both contracts must be adjacent methods of that class, not unrelated matches.
  const frontmostEnd = findMatchingBrace(source, source.indexOf("{", frontmost.index));
  if (frontmostEnd + 1 !== start.index ||
      factory[0].match(/\?new ([A-Za-z_$][\w$]*)\(/)?.[1] !== name) return false;

  // Rspack module functions own these bindings. Do not brace-scan entire modules:
  // regex literals can contain braces. Headers delimit the conservative scope.
  const modules = [...source.matchAll(new RegExp(
    `(?:^|[{},])\\d+\\(${IDENT}(?:,${IDENT})*\\)\\{"use strict";`, "g",
  ))];
  const moduleAt = index => modules.findLastIndex(module => module.index < index);
  const moduleIndex = moduleAt(header.index);
  if (moduleIndex !== moduleAt(factory.index)) return false;
  const scope = source.slice(moduleIndex < 0 ? 0 : modules[moduleIndex].index,
    modules[moduleIndex + 1]?.index ?? source.length);
  // Exactly the declaration and factory reference are allowed. This also rejects
  // same-name local shadow bindings, assignments and escaped identifier aliases.
  const references = [...decodeJavaScriptIdentifierEscapesForValidation(scope).matchAll(new RegExp(
    `(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, "g",
  ))];
  return references.length === 2;
}

function appshotCaptureState(source) {
  const patterns = appshotCapturePatterns();
  const counts = (key) => patterns.map((pattern) => [...source.matchAll(pattern[key])].length);
  const current = counts("current"), patched = counts("patched");
  const runtime = appendLinuxAppshotHelper("");
  const runtimeNames = new Set(runtime.match(/\bcodexLinuxAppshot[\w$]+/g));
  const outsideRuntime = decodeJavaScriptIdentifierEscapesForValidation(source.replace(runtime, ""));
  const references = [...outsideRuntime.matchAll(/\bcodexLinuxAppshot[\w$]+/g)]
    .map(([name]) => name).filter(name => runtimeNames.has(name));
  const completeRuntime = source.includes(runtime) && references.length === 2 &&
    references.includes("codexLinuxAppshotFrontmostWindow") && references.includes(APPSHOT_HELPER_MARKER);
  if (current.every(count => count === 0) && patched.every(count => count === 1) && completeRuntime &&
      matchesAppshotCaptureOwner(source, patterns, "patched")) return { kind: "patched", patterns };
  if (!source.includes(".sendInlineMessageForView(") ||
      !current.every(count => count === 1) || !patched.every(count => count === 0) ||
      source.includes(runtime) || references.length !== 0 ||
      !matchesAppshotCaptureOwner(source, patterns, "current")) {
    const candidate = current.some(count => count > 0) || patched.some(count => count > 0) ||
      /appshotCapture:|async getFrontmostWindow\(\)\{return this\.abortController\.signal\.aborted|async start\(\{animationDestination:/.test(source) ||
      source.includes(runtime) || references.length > 0;
    return { kind: candidate ? "invalid" : "absent", patterns };
  }
  return { kind: "current", patterns };
}

function applyLinuxAppshotMainProcessPatch(source) {
  const state = appshotCaptureState(source);
  if (state.kind === "patched") return source;
  if (state.kind !== "current") {
    warn("Could not find one complete current AppShots capture owner", "Linux AppShots main-process patch");
    return source;
  }
  let result = source;
  for (const { current, replace } of state.patterns) result = result.replace(current, replace);
  return appendLinuxAppshotHelper(result);
}

function appendLinuxAppshotHelper(source) {
  return `${source}
;function codexLinuxAppshotRequire(e){return require(e)}
function codexLinuxAppshotBackendPath(){let e=codexLinuxAppshotRequire(\`node:fs\`),t=codexLinuxAppshotRequire(\`node:path\`),n=codexLinuxAppshotRequire(\`node:os\`),r=process.env.CODEX_ELECTRON_RESOURCES_PATH||process.resourcesPath,i=process.env.CODEX_HOME||(process.env.HOME?t.join(process.env.HOME,\`.codex\`):t.join(n.homedir(),\`.codex\`)),a=[process.env.CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE,r&&t.join(r,\`plugins\`,\`openai-bundled\`,\`plugins\`,\`unified-computer-use\`,\`bin\`,\`codex-computer-use-linux\`),i&&t.join(i,\`plugins\`,\`cache\`,\`openai-bundled\`,\`unified-computer-use\`,\`latest\`,\`bin\`,\`codex-computer-use-linux\`)];for(let t of a){if(typeof t!=\`string\`||t.length===0)continue;try{if(e.existsSync(t))return t}catch{}}return null}
async function codexLinuxAppshotBackendJson(e,t=10000,signal){codexLinuxAppshotCheck(signal);let n=codexLinuxAppshotBackendPath();if(n==null)throw Error(\`Linux Computer Use backend is not installed\`);let r=codexLinuxAppshotRequire(\`node:child_process\`),i;try{i=await codexLinuxAppshotExecFile(r,n,e,{encoding:\`utf8\`,timeout:t,maxBuffer:67108864,signal})}catch(e){codexLinuxAppshotCheck(signal);throw Error((e.codexStderr||e.message||\`Linux Computer Use backend failed\`).trim())}try{return JSON.parse(i.stdout)}catch{throw Error(\`Linux Computer Use backend returned invalid JSON\`)}}
function codexLinuxAppshotCheck(signal){signal?.throwIfAborted()}
function codexLinuxAppshotFirstString(...e){for(let t of e)if(typeof t==\`string\`&&t.trim().length>0)return t.trim();return null}
function codexLinuxAppshotWindowForRenderer(e){if(e==null||typeof e!=\`object\`)return null;let t=codexLinuxAppshotFirstString(e.app_id,e.wm_class,e.title,\`Linux app\`),n=codexLinuxAppshotFirstString(e.app_id,e.wm_class,e.pid!=null?\`pid:\${e.pid}\`:null,e.window_id!=null?\`window:\${e.window_id}\`:null,t),r=codexLinuxAppshotFirstString(e.title);return{name:t,appName:t,bundleIdentifier:n,windowTitle:r,iconSmallDataURL:null,appIconDataUrl:null}}
function codexLinuxAppshotFocusedWindowFromReport(e){let t=Array.isArray(e?.windows)?e.windows:[],n=t.find(e=>e?.focused)||null;return{focusedWindow:n,windows:t,backend:codexLinuxAppshotFirstString(e?.backend)}}
function codexLinuxAppshotOwnWindow(e){if(e==null||typeof e!=\`object\`)return!1;let t=[e.app_id,e.wm_class,e.title].filter(e=>typeof e==\`string\`).join(\` \`).toLowerCase();return Number(e.pid)===process.pid||t.includes(\`codex-desktop\`)||t.includes(\`chatgpt community\`)}
function codexLinuxAppshotOwnOrPortalWindow(e){if(codexLinuxAppshotOwnWindow(e))return!0;let t=[e?.app_id,e?.wm_class,e?.title].filter(e=>typeof e==\`string\`).join(\` \`).toLowerCase();return t.includes(\`xdg-desktop-portal\`)}
function codexLinuxAppshotWindowId(e){if(typeof e===\`number\`&&Number.isFinite(e))return e;if(typeof e!==\`string\`||!/^0x[0-9a-f]+$/i.test(e))return null;let t=Number.parseInt(e.slice(2),16);return Number.isSafeInteger(t)?t:null}
function codexLinuxAppshotPreviousExternalWindow(e,t){let n=Array.isArray(e)?e:[],r=Array.isArray(t)?t:[];for(let e of r){if(e?.mapped===!1||e?.hidden===!0)continue;let t=codexLinuxAppshotWindowId(e?.window_id??e?.address),r=codexLinuxAppshotFirstString(e?.wm_class,e?.app_id,e?.class,e?.initialClass),i=n.find(n=>t!=null&&Number(n?.window_id)===t||e?.pid!=null&&Number.isFinite(Number(e.pid))&&Number(n?.pid)===Number(e.pid)&&codexLinuxAppshotFirstString(n?.wm_class,n?.app_id)===r);if(i!=null&&i?.hidden!==!0&&!codexLinuxAppshotOwnOrPortalWindow(i))return i}return null}
function codexLinuxAppshotExecutablePath(e){let t=codexLinuxAppshotRequire(\`node:fs\`),n=codexLinuxAppshotRequire(\`node:path\`),r=[];for(let t of Array.isArray(e)?e:[])typeof t===\`string\`&&t.length>0&&(t.includes(n.sep)?r.push(t):r.push(...String(process.env.PATH||\`\`).split(n.delimiter).filter(Boolean).map(e=>n.join(e,t))));for(let e of r)try{t.accessSync(e,t.constants.X_OK);return e}catch{}return null}
function codexLinuxAppshotHyprlandPicker(){let e=codexLinuxAppshotExecutablePath([process.env.CODEX_LINUX_APPSHOT_PICKER,\`hyprland-preview-share-picker\`,\`hyprland-share-picker\`]);if(e==null)return null;let t=codexLinuxAppshotRequire(\`node:path\`).basename(e);return{path:e,preview:t===\`hyprland-preview-share-picker\`}}
function codexLinuxAppshotHyprlandPickerConfig(e){if(e?.preview!==!0)return{args:[],cleanup:()=>{}};let t=codexLinuxAppshotRequire(\`node:fs\`),n=codexLinuxAppshotRequire(\`node:path\`),r=codexLinuxAppshotRequire(\`node:os\`),i=process.env.HOME||r.homedir(),a=n.join(i,\`.config\`,\`hyprland-preview-share-picker\`,\`config.yaml\`);try{if(!t.existsSync(a))return{args:[],cleanup:()=>{}};let r=t.readFileSync(a,\`utf8\`),i=[...r.matchAll(/^default_page\\s*:\\s*([^\\r\\n#]+).*$/gm)];if(i.length!==1||i[0][1].trim().toLowerCase()===\`windows\`)return{args:[],cleanup:()=>{}};let o=r.slice(0,i[0].index)+\`default_page: windows\`+r.slice(i[0].index+i[0][0].length),s=n.join(n.dirname(a),\`.codex-appshots-\${process.pid}-\${codexLinuxAppshotRequire(\`node:crypto\`).randomBytes(8).toString(\`hex\`)}.yaml\`);t.writeFileSync(s,o,{encoding:\`utf8\`,flag:\`wx\`,mode:384});return{args:[\`--config\`,s],cleanup:()=>{try{t.unlinkSync(s)}catch{}}}}catch(e){return codexLinuxAppshotWarn(\`hyprland-picker-config-override-failed\`,{message:e instanceof Error?e.message:String(e)}),{args:[],cleanup:()=>{}}}}
function codexLinuxAppshotHyprlandInstanceSignature(){let e=codexLinuxAppshotFirstString(process.env.HYPRLAND_INSTANCE_SIGNATURE);if(e!=null)return e;let t=codexLinuxAppshotRequire(\`node:fs\`),n=codexLinuxAppshotRequire(\`node:path\`),r=process.env.XDG_RUNTIME_DIR||(typeof process.getuid===\`function\`?\`/run/user/\${process.getuid()}\`:null);if(r==null)return null;let i=n.join(r,\`hypr\`),a=codexLinuxAppshotFirstString(process.env.WAYLAND_DISPLAY),o=[];try{for(let e of t.readdirSync(i)){let r=n.join(i,e),s=n.join(r,\`.socket.sock\`),c=n.join(r,\`hyprland.lock\`);try{if(!t.statSync(s).isSocket())continue;let r=t.readFileSync(c,\`utf8\`).split(/\\r?\\n/),i=Number(r[0]),l=codexLinuxAppshotFirstString(r[1]);if(!Number.isInteger(i)||i<=0||!t.existsSync(\`/proc/\${i}\`))continue;o.push({signature:e,display:l,displayMatch:a!=null&&l===a,modified:t.statSync(s).mtimeMs})}catch{}}}catch{return null}o.sort((e,t)=>Number(t.displayMatch)-Number(e.displayMatch)||t.modified-e.modified||e.signature.localeCompare(t.signature));return o[0]?.signature??null}
function codexLinuxAppshotHyprlandEnv(){let e={...process.env},t=codexLinuxAppshotHyprlandInstanceSignature();return codexLinuxAppshotFirstString(e.HYPRLAND_INSTANCE_SIGNATURE)==null&&t!=null&&(e.HYPRLAND_INSTANCE_SIGNATURE=t),e}
function codexLinuxAppshotHyprctlArgs(e){let t=codexLinuxAppshotHyprlandInstanceSignature();return codexLinuxAppshotFirstString(process.env.HYPRLAND_INSTANCE_SIGNATURE)==null&&t!=null?[\`-i\`,t,...e]:e}
function codexLinuxAppshotPickerClean(e){let t=String(e??\`\`);for(let e of [\`[HC>]\`,\`[HT>]\`,\`[HE>]\`,\`[HA>]\`,\`\\r\`,\`\\n\`,\`\\t\`])t=t.split(e).join(\` \`);return t.trim()}
function codexLinuxAppshotHyprlandPickerData(e){let t=[],n=new Map,r=1;for(let i of Array.isArray(e)?e:[]){if(i?.hidden===!0||codexLinuxAppshotOwnOrPortalWindow(i))continue;let e=Number(i?.window_id),a=codexLinuxAppshotFirstString(i?.wm_class,i?.app_id,\`Linux app\`),o=codexLinuxAppshotFirstString(i?.title,a);if(!Number.isSafeInteger(e)||e<=0)continue;let s=String(r++);t.push(\`\${s}[HC>]\${codexLinuxAppshotPickerClean(a)}[HT>]\${codexLinuxAppshotPickerClean(o)}[HE>]\${e}[HA>]\`),n.set(s,i)}return{list:t.join(\`\`),windowsById:n}}
function codexLinuxAppshotHyprlandPickerSelection(e){if(typeof e!==\`string\`)return null;let t=\`[SELECTION]\`,n=e.lastIndexOf(t);if(n<0)return null;let r=e.slice(n+t.length).split(\`\\n\`,1)[0],i=\`/window:\`,a=r.indexOf(i);if(a<0)return null;let o=r.slice(a+i.length).trim();return o.length>0&&[...o].every(e=>e>=\`0\`&&e<=\`9\`)?o:null}
async function codexLinuxAppshotHyprlandPickWindow(e,signal){codexLinuxAppshotCheck(signal);let t=codexLinuxAppshotHyprlandPicker(),n=codexLinuxAppshotHyprlandPickerData(e);if(t==null||n.windowsById.size===0)return null;let r=codexLinuxAppshotRequire(\`node:child_process\`),i=codexLinuxAppshotHyprlandPickerConfig(t);try{let result=await codexLinuxAppshotExecFile(r,t.path,i.args,{encoding:\`utf8\`,timeout:120000,maxBuffer:1048576,signal,env:{...codexLinuxAppshotHyprlandEnv(),GDK_BACKEND:\`wayland\`,QT_QPA_PLATFORM:\`wayland\`,XDPH_WINDOW_SHARING_LIST:n.list}}),selection=codexLinuxAppshotHyprlandPickerSelection(result.stdout);return selection==null?null:n.windowsById.get(selection)??null}catch{codexLinuxAppshotCheck(signal);return null}finally{i.cleanup()}}
function codexLinuxAppshotHyprlandWindowAddress(e){let t=Number(e?.window_id);return Number.isSafeInteger(t)&&t>0?\`address:0x\${t.toString(16)}\`:null}
async function codexLinuxAppshotHyprlandFocusWindow(e,signal){codexLinuxAppshotCheck(signal);let t=codexLinuxAppshotHyprlandWindowAddress(e);if(t==null)return!1;let n=codexLinuxAppshotRequire(\`node:child_process\`),r={encoding:\`utf8\`,timeout:5000,maxBuffer:1048576,signal,env:codexLinuxAppshotHyprlandEnv()};try{let e=await codexLinuxAppshotExecFile(n,\`hyprctl\`,codexLinuxAppshotHyprctlArgs([\`dispatch\`,\`hl.dsp.focus({ window = "\${t}" })\`]),r);if(String(e.stdout||\`\`).trim()===\`ok\`)return!0}catch{codexLinuxAppshotCheck(signal)}try{let e=await codexLinuxAppshotExecFile(n,\`hyprctl\`,codexLinuxAppshotHyprctlArgs([\`dispatch\`,\`focuswindow\`,t]),r);return String(e.stdout||\`\`).trim()===\`ok\`}catch{codexLinuxAppshotCheck(signal);return!1}}
function codexLinuxAppshotManagedCapture(e){return e===\`hyprland\`||e===\`x11\`||e===\`i3\`}
async function codexLinuxAppshotFocusWindow(e,t,signal){codexLinuxAppshotCheck(signal);if(t===\`hyprland\`)return codexLinuxAppshotHyprlandFocusWindow(e,signal);let n=Number(e?.window_id);if(!Number.isSafeInteger(n)||n<=0||!(t===\`x11\`||t===\`i3\`))return!1;let r=codexLinuxAppshotRequire(\`node:child_process\`),i=\`0x\${n.toString(16)}\`;try{let e=await codexLinuxAppshotExecFile(r,t===\`i3\`?\`i3-msg\`:\`wmctrl\`,t===\`i3\`?[\`[id="\${i}"] focus\`]:[\`-i\`,\`-a\`,i],{encoding:\`utf8\`,timeout:5000,maxBuffer:1048576,signal});if(t===\`x11\`)return!0;let n=JSON.parse(e.stdout);return Array.isArray(n)&&n.length>0&&n.every(e=>e?.success===!0)}catch{codexLinuxAppshotCheck(signal);return!1}}
function codexLinuxAppshotDelay(e){return new Promise(t=>setTimeout(t,e))}
function codexLinuxAppshotWindowById(e,t){let n=Number(t?.window_id);return Number.isSafeInteger(n)?(Array.isArray(e)?e:[]).find(e=>Number(e?.window_id)===n)??null:null}
function codexLinuxAppshotUsableBounds(e){let t=e?.bounds;if(t==null||t.x==null||t.y==null||t.width==null||t.height==null)return!1;let n=[t.x,t.y,t.width,t.height].map(Number);return n.every(Number.isFinite)&&n[2]>0&&n[3]>0}
function codexLinuxAppshotBoundsKey(e){let t=e?.bounds;return codexLinuxAppshotUsableBounds(e)?[t.x,t.y,t.width,t.height].map(Number).join(\`:\`):null}
function codexLinuxAppshotWindowIdentity(e){if(e==null)return null;let t=Number(e.window_id),n=Number(e.pid),r=codexLinuxAppshotFirstString(e.app_id),i=codexLinuxAppshotFirstString(e.wm_class);return Number.isSafeInteger(t)&&t>0?\`window:\${t}:pid:\${Number.isFinite(n)?n:\`\`}:app:\${r??\`\`}:class:\${i??\`\`}\`:Number.isFinite(n)&&(r!=null||i!=null)?\`process:\${n}:app:\${r??\`\`}:class:\${i??\`\`}\`:null}
function codexLinuxAppshotSameWindow(e,t){let n=codexLinuxAppshotWindowIdentity(e),r=codexLinuxAppshotWindowIdentity(t);return n!=null&&n===r}
function codexLinuxAppshotCaptureReadyWindow(e,t,n=null){let r=codexLinuxAppshotWindowById(e,t);return r!=null&&codexLinuxAppshotSameWindow(r,t)&&r.focused===!0&&r.hidden!==!0&&r.mapped!==!1&&codexLinuxAppshotUsableBounds(r)&&(n==null||codexLinuxAppshotBoundsKey(r)===n)?r:null}
function codexLinuxAppshotValidReturnWindow(e){return codexLinuxAppshotOwnWindow(e)&&codexLinuxAppshotWindowIdentity(e)!=null&&e.hidden!==!0&&e.mapped!==!1&&codexLinuxAppshotUsableBounds(e)}
async function codexLinuxAppshotWaitForWindow(e,t=null,r=null,signal){codexLinuxAppshotCheck(signal);let n=null;for(let i=0;i<40;i++){let a=await codexLinuxAppshotBackendJson([\`windows\`],5000,signal),o=codexLinuxAppshotFocusedWindowFromReport(a);if(r!=null&&o.backend!==r)throw Error(\`AppShot window backend changed during capture\`);let s=codexLinuxAppshotCaptureReadyWindow(o.windows,e,t),c=s==null?null:codexLinuxAppshotBoundsKey(s);if(c!=null&&c===n)return{...o,focusedWindow:s};n=c,await codexLinuxAppshotDelay(50)}throw Error(\`Linux window did not become capture-ready\`)}
async function codexLinuxAppshotPrepareWindowForCapture(e,signal){codexLinuxAppshotCheck(signal);if(e?.focusedWindow==null)return e;if(!codexLinuxAppshotManagedCapture(e.backend)){if(e.focusedWindow.focused!==!0)throw Error(\`Unsupported Linux backend for unfocused window capture\`);return e}if(e.backend===\`hyprland\`||e.focusedWindow.focused!==!0){if(!codexLinuxAppshotValidReturnWindow(e.returnWindow)||codexLinuxAppshotSameWindow(e.focusedWindow,e.returnWindow))throw Error(\`No safe ChatGPT return target for Linux capture\`);if(!await codexLinuxAppshotFocusWindow(e.focusedWindow,e.backend,signal))throw Error(\`Could not activate selected Linux window\`)}let t=await codexLinuxAppshotWaitForWindow(e.focusedWindow,null,e.backend,signal);await codexLinuxAppshotDelay(100);let n=await codexLinuxAppshotWaitForWindow(t.focusedWindow,codexLinuxAppshotBoundsKey(t.focusedWindow),e.backend,signal);return{...e,...n,focusedWindow:n.focusedWindow}}
async function codexLinuxAppshotVerifyCapturedWindow(e,t,n=null,signal){let r=await codexLinuxAppshotBackendJson([\`windows\`],5000,signal),i=codexLinuxAppshotFocusedWindowFromReport(r),a=codexLinuxAppshotCaptureReadyWindow(i.windows,e,t);if(a==null||n!=null&&i.backend!==n)throw Error(\`Selected Linux window changed during capture\`);return a}
// Focus restoration is cleanup and deliberately does not use the aborted capture signal.
async function codexLinuxAppshotRestoreWindow(e,t=\`hyprland\`){if(!await codexLinuxAppshotFocusWindow(e,t))return!1;try{await codexLinuxAppshotWaitForWindow(e,null,t);return!0}catch{return!1}}
function codexLinuxAppshotPickerWindowForRenderer(){let e=\`window...\`;try{let t=String(codexLinuxAppshotRequire(\`electron\`).app.getLocale()||\`\`).toLowerCase();t.startsWith(\`es\`)&&(e=\`una ventana...\`),t.startsWith(\`zh\`)&&(e=\`窗口...\`)}catch{}return{name:e,appName:e,bundleIdentifier:\`codex-linux-appshot-picker\`,windowTitle:null,iconSmallDataURL:null,appIconDataUrl:null}}
function codexLinuxAppshotX11StackingCandidates(e){if(typeof e!==\`string\`)return[];let t=e.match(/0x[0-9a-f]+/gi)||[];return t.reverse().map(e=>({window_id:e}))}
async function codexLinuxAppshotX11Stacking(signal){let e=codexLinuxAppshotRequire(\`node:child_process\`);try{let t=await codexLinuxAppshotExecFile(e,\`xprop\`,[\`-root\`,\`_NET_CLIENT_LIST_STACKING\`],{encoding:\`utf8\`,timeout:2000,maxBuffer:1048576,signal});return codexLinuxAppshotX11StackingCandidates(t.stdout)}catch{codexLinuxAppshotCheck(signal);return[]}}
function codexLinuxAppshotX11Session(){let e=(process.env.XDG_SESSION_TYPE||\`\`).toLowerCase();return e===\`x11\`||e!==\`wayland\`&&!!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY}
async function codexLinuxAppshotResolvedWindow(e,signal){codexLinuxAppshotCheck(signal);let t=codexLinuxAppshotFocusedWindowFromReport(e);if(!codexLinuxAppshotOwnOrPortalWindow(t.focusedWindow))return t;let n=[];(t.backend===\`x11\`||t.backend===\`i3\`||codexLinuxAppshotX11Session())&&(n=await codexLinuxAppshotX11Stacking(signal));t.focusedWindow=codexLinuxAppshotPreviousExternalWindow(t.windows,n);return t}
async function codexLinuxAppshotFocusedWindow(e=!1,signal){let t=await codexLinuxAppshotBackendJson([\`windows\`],5000,signal),n=codexLinuxAppshotFocusedWindowFromReport(t),r=n.windows.find(e=>e?.focused&&codexLinuxAppshotValidReturnWindow(e))??n.windows.find(e=>codexLinuxAppshotValidReturnWindow(e))??null,i=n.backend===\`hyprland\`&&codexLinuxAppshotHyprlandPicker()!=null&&codexLinuxAppshotHyprlandPickerData(n.windows).windowsById.size>0;if(i){if(!e)return{...n,focusedWindow:null,picker:!0,returnWindow:r};if(r==null)throw Error(\`No ChatGPT window available for AppShots restoration\`);n.focusedWindow=await codexLinuxAppshotHyprlandPickWindow(n.windows,signal);return{...n,picker:!0,returnWindow:r}}return{...await codexLinuxAppshotResolvedWindow(t,signal),returnWindow:r}}
async function codexLinuxAppshotFrontmostWindow(signal){if(process.platform!==\`linux\`)return null;try{let e=await codexLinuxAppshotFocusedWindow(!1,signal);codexLinuxAppshotCheck(signal);return e.picker?codexLinuxAppshotPickerWindowForRenderer():codexLinuxAppshotWindowForRenderer(e.focusedWindow)}catch{return null}}
function codexLinuxAppshotSend(e,t,n,r){try{e.sendInlineMessageForView(t,{requestId:n,type:\`computer-use-capture-updated\`,update:r})}catch{}}
let codexLinuxAppshotCaptureQueue=Promise.resolve();
function codexLinuxAppshotStartCapture({origin:e,requestId:t,bundleIdentifier:n,windowManager:r,signal}){if(signal?.aborted||process.platform!==\`linux\`)return null;setTimeout(()=>{let i=()=>{codexLinuxAppshotCheck(signal);return codexLinuxAppshotCapture({origin:e,requestId:t,bundleIdentifier:n,windowManager:r,signal})};codexLinuxAppshotCaptureQueue=codexLinuxAppshotCaptureQueue.then(i,i).catch(n=>{if(signal?.aborted)return;codexLinuxAppshotWarn(\`capture-failed\`,{requestId:t,message:n instanceof Error?n.message:String(n)}),codexLinuxAppshotSend(r,e,t,{type:\`failed\`,failureReason:\`linux_capture_failed\`})})},0);return{animationDuration:0,transitionSnapshotHeight:140,transitionSpringDampingFraction:1,transitionSpringResponse:0}}
async function codexLinuxAppshotCapture({origin:e,requestId:t,bundleIdentifier:n,windowManager:r,signal}){codexLinuxAppshotCheck(signal);let i=await codexLinuxAppshotFocusedWindow(!0,signal),a=i.focusedWindow,o=i.returnWindow,v=codexLinuxAppshotManagedCapture(i.backend)&&a!=null,s=v&&(i.backend===\`hyprland\`||a.focused!==!0),b=i.backend,c=null,l=null,u=null,d=!s;try{codexLinuxAppshotCheck(signal);i=await codexLinuxAppshotPrepareWindowForCapture(i,signal),a=i.focusedWindow,c=codexLinuxAppshotWindowForRenderer(a);if(c==null)throw Error(\`No selected Linux AppShot window\`);let results=await Promise.allSettled([codexLinuxAppshotAccessibilityNodes(a,c.bundleIdentifier,signal),codexLinuxAppshotScreenshot(a,i.windows,signal)]);codexLinuxAppshotCheck(signal);for(let result of results)if(result.status===\`rejected\`)throw result.reason;let[e,t]=results.map(result=>result.value);if(t==null||typeof t.dataURL!=\`string\`||t.dataURL.length===0)throw Error(\`Linux AppShot screenshot was empty\`);v&&await codexLinuxAppshotVerifyCapturedWindow(a,codexLinuxAppshotBoundsKey(a),b,signal),l=codexLinuxAppshotAccessibilityText(a,e.nodes,e.error),u=t}finally{if(s){if(o==null||!await codexLinuxAppshotRestoreWindow(o,b)){codexLinuxAppshotWarn(\`appshot-restore-focus-failed\`,{windowId:o?.window_id});throw Error(\`Could not verify ChatGPT focus restoration\`)}d=!0}}codexLinuxAppshotCheck(signal);if(!d)throw Error(\`ChatGPT focus restoration was not verified\`);codexLinuxAppshotSend(r,e,t,{type:\`metadata\`,app:{bundleIdentifier:c.bundleIdentifier,name:c.name,windowTitle:c.windowTitle,iconSmallDataURL:null}}),typeof l==\`string\`&&l.length>0&&codexLinuxAppshotSend(r,e,t,{type:\`axText\`,text:l}),codexLinuxAppshotSend(r,e,t,{type:\`screenshot\`,screenshotDataURL:u.dataURL}),codexLinuxAppshotSend(r,e,t,{type:\`completed\`,transitionSnapshotDataURL:u.dataURL})}
async function codexLinuxAppshotAccessibilityNodes(e,t,signal){codexLinuxAppshotCheck(signal);let n=[],r=new Set,a=o=>{let s=codexLinuxAppshotFirstString(o);s!=null&&!r.has(s)&&(r.add(s),n.push(s))};a(t),a(e?.app_id),a(e?.wm_class),a(e?.title),a(\`electron\`);let o=null;for(let e of n){try{let t=await codexLinuxAppshotBackendJson([\`state\`,e],10000,signal);if(Array.isArray(t)&&t.length>0)return{nodes:t,candidate:e,error:null}}catch(e){codexLinuxAppshotCheck(signal);o=e}}return{nodes:[],candidate:null,error:o instanceof Error?o.message:String(o||\`\`)}}
function codexLinuxAppshotAccessibilityText(e,t,n){let r=codexLinuxAppshotFirstString(e?.app_id,e?.wm_class,\`Linux app\`),i=codexLinuxAppshotFirstString(e?.title,\`\`),a=[\`Linux AppShot accessibility snapshot\`,\`Application: \${r}\`,\`Window: "\${i}"\`,\`\`,\`Elements:\`];if(!Array.isArray(t)||t.length===0){n&&a.push(\`- error text="\${String(n).slice(0,240)}"\`);return a.join(\`\\n\`)}for(let e of t.slice(0,120))a.push(codexLinuxAppshotNodeLine(e));return a.join(\`\\n\`)}
function codexLinuxAppshotNodeLine(e){let t=Number.isFinite(e?.depth)?Math.max(0,Math.min(12,e.depth)):0,n=\`  \`.repeat(t),r=codexLinuxAppshotFirstString(e?.role,\`node\`),i=codexLinuxAppshotFirstString(e?.name),a=codexLinuxAppshotFirstString(e?.text),o=Array.isArray(e?.states)?e.states.filter(Boolean).slice(0,8).join(\`,\`):null,s=e?.bounds?\` bounds=\${Math.round(Number(e.bounds.width)||0)}x\${Math.round(Number(e.bounds.height)||0)}+\${Math.round(Number(e.bounds.x)||0)}+\${Math.round(Number(e.bounds.y)||0)}\`:\`\`;return\`\${n}- \${r}\${i?\` name="\${codexLinuxAppshotCleanText(i,120)}"\`:\`\`}\${a?\` text="\${codexLinuxAppshotCleanText(a,160)}"\`:\`\`}\${s}\${o?\` states=\${o}\`:\`\`}\`}
function codexLinuxAppshotCleanText(e,t){return String(e).replace(/[\\r\\n\\t]+/g,\` \`).replace(/"/g,\`'\`).trim().slice(0,t)}
function codexLinuxAppshotScreenshotCommands(e){let t=codexLinuxAppshotWindowId(e?.window_id),n=Number.isSafeInteger(t)&&t>0&&(e?.backend===\`x11\`||e?.backend===\`i3\`)?[{source:\`imagemagick-window\`,programs:[\`import\`,\`/usr/bin/import\`],args:[\`-window\`,\`0x\${t.toString(16)}\`],output:\`append\`}]:[];return[...n,{source:\`grim\`,programs:[\`grim\`,\`/usr/bin/grim\`],args:[],output:\`append\`},{source:\`spectacle\`,programs:[\`spectacle\`,\`/usr/bin/spectacle\`],args:[\`-b\`,\`-n\`],output:[\`-o\`]},{source:\`gnome-screenshot\`,programs:[\`gnome-screenshot\`,\`/usr/bin/gnome-screenshot\`],args:[],output:[\`-f\`]},{source:\`maim\`,programs:[\`maim\`,\`/usr/bin/maim\`],args:[],output:\`append\`},{source:\`scrot\`,programs:[\`scrot\`,\`/usr/bin/scrot\`],args:[],output:\`append\`},{source:\`imagemagick-import\`,programs:[\`import\`,\`/usr/bin/import\`],args:[\`-window\`,\`root\`],output:\`append\`}]}
async function codexLinuxAppshotScreenshot(e,t,signal){
codexLinuxAppshotCheck(signal);
let n=codexLinuxAppshotRequire(\`node:fs\`),r=codexLinuxAppshotRequire(\`node:os\`),i=codexLinuxAppshotRequire(\`node:path\`),a=codexLinuxAppshotRequire(\`node:child_process\`),o=codexLinuxAppshotRequire(\`electron\`).nativeImage,s=codexLinuxAppshotCropRects(e,t);
if(s.length===0)return codexLinuxAppshotWarn(\`screenshot-crop-missing\`,{hasBounds:e?.bounds!=null}),null;
for(let c of codexLinuxAppshotScreenshotCommands(e))for(let l of c.programs){
let u=null;
try{
u=n.mkdtempSync(i.join(r.tmpdir(),\`codex-appshot-\`)),n.chmodSync(u,448);let d=i.join(u,\`source.png\`),f=i.join(u,\`crop.png\`),p=c.output===\`append\`?[...c.args,d]:[...c.args,...c.output,d];
await codexLinuxAppshotExecFile(a,l,p,{timeout:15000,maxBuffer:8388608,signal});
if(!n.existsSync(d)){codexLinuxAppshotWarn(\`screenshot-output-missing\`,{source:c.source,program:l});continue}
let e=n.statSync(d);if(e.size<=0){codexLinuxAppshotWarn(\`screenshot-output-empty\`,{source:c.source,program:l});continue}
let t=await codexLinuxAppshotCropWithImageMagick({childProcess:a,fs:n,sourcePath:d,tmpPath:f,cropRects:c.source===\`imagemagick-window\`?null:s,signal});
if(t!=null)return{dataURL:t.dataURL,width:t.width,height:t.height,source:\`\${c.source}:imagemagick-window-crop\`};
let h=codexLinuxAppshotCropNativeImage(o,d,c.source===\`imagemagick-window\`?null:s);
if(h!=null)return{dataURL:h.image.toDataURL(),width:h.width,height:h.height,source:\`\${c.source}:feature-window-crop\`}
}catch(e){codexLinuxAppshotCheck(signal);codexLinuxAppshotWarn(\`screenshot-command-failed\`,{source:c.source,program:l,message:e instanceof Error?e.message:String(e),stderr:typeof e?.codexStderr===\`string\`?e.codexStderr.slice(0,200):\`\`})}
finally{if(u!=null)try{n.rmSync(u,{recursive:true,force:true})}catch{}}
}
return codexLinuxAppshotWarn(\`screenshot-all-commands-failed\`,{commandCount:codexLinuxAppshotScreenshotCommands(e).length}),null
}
// AbortError clears execFile's timeout. Allow 250ms for cooperative shutdown,
// then force termination; resources and focus remain held until child close.
function codexLinuxAppshotExecFile(e,t,n,r){codexLinuxAppshotCheck(r?.signal);return new Promise((i,a)=>{let closed=!1,finish=null,timer=null;const child=e.execFile(t,n,r,(e,t,n)=>{if(r?.signal?.aborted){let reject=()=>{timer!=null&&clearTimeout(timer);a(r.signal.reason)};if(child.pid!=null&&!closed){finish=reject,timer=setTimeout(()=>{try{child.kill(\`SIGKILL\`)}catch(e){codexLinuxAppshotWarn(\`capture-force-stop-failed\`,{message:e instanceof Error?e.message:String(e)})}},250),timer.unref?.()}else reject();return}if(e!=null){e.codexStderr=String(n||\`\`);a(e);return}i({stdout:t,stderr:n})});child.once(\`close\`,()=>{closed=!0,finish?.()})})}
function codexLinuxAppshotCropNativeImage(e,t,n){let r=e.createFromPath(t),i=r.getSize();if(i.width<=0||i.height<=0)return codexLinuxAppshotWarn(\`screenshot-native-image-empty\`,{}),null;let a=codexLinuxAppshotFirstValidCrop(n,i);if(a==null)return codexLinuxAppshotWarn(\`screenshot-native-crop-invalid\`,{width:i.width,height:i.height,cropCount:n?.length??0}),null;let o=r.crop(a),s=o.getSize();return s.width<=0||s.height<=0?(codexLinuxAppshotWarn(\`screenshot-native-crop-empty\`,a),null):{image:o,width:s.width,height:s.height}}
async function codexLinuxAppshotCropWithImageMagick({childProcess:e,fs:t,sourcePath:n,tmpPath:r,cropRects:i,signal}){codexLinuxAppshotCheck(signal);try{let a=await codexLinuxAppshotExecFirst(e,[\`identify\`,\`/usr/bin/identify\`],[\`-format\`,\`%w %h\`,n],{timeout:5000,maxBuffer:1024,signal},\`screenshot-identify-failed\`),o=String(a.stdout||\`\`).trim().split(/\\s+/).map(Number),s={width:o[0],height:o[1]},c=codexLinuxAppshotFirstValidCrop(i,s);if(c==null)return codexLinuxAppshotWarn(\`screenshot-identify-crop-invalid\`,{width:s.width,height:s.height,cropCount:i?.length??0}),null;await codexLinuxAppshotExecFirst(e,[\`convert\`,\`/usr/bin/convert\`],[n,\`-crop\`,\`\${c.width}x\${c.height}+\${c.x}+\${c.y}\`,\`+repage\`,r],{timeout:10000,maxBuffer:8388608,signal},\`screenshot-convert-failed\`);if(!t.existsSync(r)||t.statSync(r).size<=0)return codexLinuxAppshotWarn(\`screenshot-convert-output-empty\`,{}),null;return{dataURL:\`data:image/png;base64,\${t.readFileSync(r).toString(\`base64\`)}\`,width:c.width,height:c.height}}catch(e){codexLinuxAppshotCheck(signal);return codexLinuxAppshotWarn(\`screenshot-imagemagick-crop-failed\`,{message:e instanceof Error?e.message:String(e),stderr:typeof e?.codexStderr===\`string\`?e.codexStderr.slice(0,200):\`\`}),null}}
async function codexLinuxAppshotExecFirst(e,t,n,r,i){let a=null;for(let o of t)try{return await codexLinuxAppshotExecFile(e,o,n,r)}catch(e){codexLinuxAppshotCheck(r?.signal);a=e;codexLinuxAppshotWarn(i,{program:o,message:e instanceof Error?e.message:String(e),stderr:typeof e?.codexStderr===\`string\`?e.codexStderr.slice(0,200):\`\`})}throw a??Error(\`No command available\`)}
function codexLinuxAppshotWarn(e,t={}){try{console.warn(\`[linux-appshots] \${e}\`,t)}catch{}}
function codexLinuxAppshotCropRects(e,t){let n=e?.bounds;if(n==null)return[];let r=[n.x,n.y,n.width,n.height].map(Number);if(!r.every(Number.isFinite)||r[2]<=0||r[3]<=0)return[];let i=Math.round(r[0]),a=Math.round(r[1]),o=Math.round(r[2]),s=Math.round(r[3]),c=[{x:i,y:a,width:o,height:s}],l=Array.isArray(t)?t:[],u=l.map(e=>Number(e?.bounds?.x)).filter(Number.isFinite),d=l.map(e=>Number(e?.bounds?.y)).filter(Number.isFinite);if(u.length>0||d.length>0){let e=u.length>0?Math.min(...u):0,t=d.length>0?Math.min(...d):0;c.push({x:Math.round(i-e),y:Math.round(a-t),width:o,height:s})}return c.push({x:0,y:0,width:o,height:s}),codexLinuxAppshotUniqueCropRects(c)}
function codexLinuxAppshotUniqueCropRects(e){let t=new Set,n=[];for(let r of e){let e=\`\${r.x}:\${r.y}:\${r.width}:\${r.height}\`;t.has(e)||(t.add(e),n.push(r))}return n}
function codexLinuxAppshotFirstValidCrop(e,t){if(e===null)return codexLinuxAppshotClampCrop({x:0,y:0,width:t.width,height:t.height},t);for(let n of e){let e=codexLinuxAppshotClampCrop(n,t);if(e!=null)return e}return null}
function codexLinuxAppshotClampCrop(e,t){if(!Number.isFinite(t?.width)||!Number.isFinite(t?.height)||t.width<=0||t.height<=0)return null;let n=Math.max(0,e.x),r=Math.max(0,e.y),i=Math.min(e.width,t.width-n),a=Math.min(e.height,t.height-r);return!Number.isFinite(i)||!Number.isFinite(a)||i<=0||a<=0?null:{x:n,y:r,width:i,height:a}}
`;
}

// Capture and hotkey owners may occupy different Rspack chunks. Validate the
// entire feature before writing either owner; per-chunk clean misses cannot
// establish already-applied state or hide conflicting owners elsewhere.
function applyLinuxAppshotsMainProcessChunks(extractedDir) {
  const main = findMainProcessChunks(extractedDir);
  if (main == null) {
    warn("Could not find main-process chunks", "Linux AppShots main-process patch");
    return { changed: false };
  }
  const chunks = main.chunks.map(name => ({
    file: path.join(main.buildDir, name),
    source: fs.readFileSync(path.join(main.buildDir, name), "utf8"),
  }));
  const contracts = [
    { name: "capture", state: appshotCaptureState, apply: applyLinuxAppshotMainProcessPatch },
    { name: "hotkey", state: appshotHotkeyState, apply: applyLinuxAppshotHotkeyPatch },
  ];
  const owners = [];
  for (const contract of contracts) {
    const states = chunks.map(chunk => contract.state(chunk.source));
    const matches = states.flatMap((state, index) => state.kind === "current" || state.kind === "patched" ? [index] : []);
    if (matches.length !== 1 || states.some(state => state.kind === "invalid")) {
      warn(`Could not find one complete AppShots ${contract.name} owner across main-process chunks`, "Linux AppShots main-process patch");
      return { changed: false };
    }
    owners.push({ ...contract, index: matches[0] });
  }
  const replacements = chunks.map(chunk => chunk.source);
  for (const owner of owners) replacements[owner.index] = owner.apply(replacements[owner.index]);
  // Verify final composition too, including when both owners share one chunk.
  for (const owner of owners) {
    if (owner.state(replacements[owner.index]).kind !== "patched") {
      warn(`Could not validate patched AppShots ${owner.name} owner`, "Linux AppShots main-process patch");
      return { changed: false };
    }
  }
  let changed = false;
  chunks.forEach((chunk, index) => {
    if (replacements[index] !== chunk.source) {
      fs.writeFileSync(chunk.file, replacements[index], "utf8");
      changed = true;
    }
  });
  return { changed };
}

const descriptors = [
  {
    id: "linux-appshots-main-process",
    phase: "extracted-app:pre-webview",
    order: 142,
    apply: applyLinuxAppshotsMainProcessChunks,
  },
  {
    id: "linux-appshots-availability",
    phase: "webview-asset",
    order: 1090,
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: matchesLinuxAppshotAvailabilityContract,
    missingDescription: "AppShots availability bundle",
    skipDescription: "Linux AppShots availability patch",
    apply: applyLinuxAppshotAvailabilityPatch,
  },
];

module.exports = {
  applyLinuxAppshotAvailabilityPatch,
  applyLinuxAppshotHotkeyPatch,
  applyLinuxAppshotMainProcessPatch,
  matchesLinuxAppshotAvailabilityContract,
  matchesLinuxAppshotHotkeyContract,
  descriptors,
};
