"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const test = require("node:test");
const descriptors = require("./patch.js");

// The current selector boundary: unified prerequisites, platform, feature flag,
// Windows/macOS service availability, followed by independent browser selection.
const fs = require("node:fs");
const selector = fs.readFileSync(path.join(__dirname, "fixtures/current-unified.js"), "utf8");
const currentBanner = selector.match(/CUA_REPL_ENABLED_SURFACES:s\.join\(","\),.*?\[constants\.Il\]:JSON\.stringify\(l\)/u)[0];
function patch(source) {
  return descriptors.find(descriptor => descriptor.id === "unified-runtime").apply(source);
}
function surfaces(source, platform, { ready = true, enabled = true, legacy = false, nativeEnabled = true } = {}) {
  const select = vm.runInNewContext(`(${source.slice(0, source.indexOf("async function configure"))})`);
  return Array.from(select(ready, { platform }, { computerUse: enabled, browser: true },
    { enabled: platform === "linux" ? nativeEnabled : legacy, paths: { serviceAppPath: legacy ? "/service" : null } }).cuaReplSurfaces);
}
test("unified Linux native selection uses the native setting and retains browser control", () => {
  assert.deepEqual(surfaces(selector, "linux"), ["browser"]);
  assert.deepEqual(surfaces(patch(selector), "linux"), ["browser", "computer"]);
  assert.match(patch(selector), /build\(\{\.\.\.e,accessBootstrapPath:bootstrap\},i\)/);
  assert.match(patch(selector), /function build\(\{browserBackends:b,deferTools:d,surfaces:s,nodeRepl:n,accessBootstrapPath:a\},codexLinuxCuaPluginRoot\)/);
  assert.ok(patch(selector).includes('.sky=codexLinuxCuaPluginRoot.replace(/\\/$/,"")+"/scripts/native-service.mjs"'));
  assert.match(patch(selector), /NODE_REPL_JS_BANNER:.*native-client\.mjs/);
  assert.match(patch(selector), /CODEX_LINUX_CUA_HOST_SOCKET:process\.env\.CODEX_LINUX_CUA_HOST_SOCKET/);
});
test("unified prerequisites, native feature flag, and other platforms retain their gates", () => {
  const result = patch(selector);
  assert.deepEqual(surfaces(result, "linux", { ready: false }), []);
  assert.deepEqual(surfaces(result, "linux", { enabled: false }), ["browser"]);
  assert.deepEqual(surfaces(result, "linux", { nativeEnabled: false }), ["browser"]);
  assert.deepEqual(surfaces(result, "darwin"), ["browser"]);
  assert.deepEqual(surfaces(result, "darwin", { legacy: true }), ["browser", "computer"]);
  assert.deepEqual(surfaces(result, "win32", { legacy: true }), ["browser", "computer"]);
  assert.equal(patch(result), result);
});
test("unified selector drift and ambiguous owners fail the build", () => {
  assert.throws(() => patch(selector.replace("null!=u.paths.serviceAppPath", "u.paths.serviceAppPath")), /unified.*contract/i);
  assert.throws(() => patch(selector + selector), /unified.*contract/i);
  assert.throws(() => patch(selector.replace("@oai/sky/service", "@oai/sky/changed")), /unified.*contract/i);
  assert.throws(() => patch(selector.replace("CUA_REPL_ENABLED_SURFACES:s", "CUA_REPL_ENABLED_SURFACES:other")), /unified.*contract/i);
});

test("disabled native access does not leave a second native Node REPL service enabled", () => {
  const patched = patch(selector);
  const select = vm.runInNewContext(`(${patched.slice(0, patched.indexOf("async function configure"))})`);
  assert.equal(select(true, { platform: "linux" }, { computerUse: true },
    { enabled: false, paths: {} }).computerUse, false);
});

test("unified mode rejects appended gates and changed companion selectors", () => {
  for (const source of [selector, patch(selector)]) {
    const changed = source.replace(",h=[]", "&&t.newRequiredGate,h=[]");
    assert.throws(() => patch(changed), /unified.*contract/i);
    assert.throws(() => patch(selector + changed), /unified.*contract/i);
  }
});

test("unified service patch scopes the plugin root and current env-key alias to its owner", () => {
  const current =
    'function unrelated(){let other=path().join(otherRoot,".mcp.json");return other}' +
    selector.replace("[constants.Il]", "[constants.Gl]");
  const patched = patch(current);

  assert.ok(patched.includes('codexLinuxCuaPluginRoot.replace(/\\/$/,"")+"/scripts/native-service.mjs"'));
  assert.match(patched, /\[constants\.Gl\]:JSON\.stringify\(l\)/u);
  assert.ok(!patched.includes('otherRoot.replace(/\\/$/,"")+"/scripts/native-service.mjs"'));
  assert.equal(patch(patched), patched);
});

test("unified banner patch edits only the validated service owner", () => {
  const unrelatedBanner =
    `function unrelated(s){let constants={},l={},n={};return{env:{${currentBanner}}}}`;
  const current = unrelatedBanner + selector;
  const patched = patch(current);

  assert.equal(patched.slice(0, unrelatedBanner.length), unrelatedBanner);
  assert.equal((patched.match(/NODE_REPL_JS_BANNER:/gu) ?? []).length, 1);
});

test("unified banner patch rejects duplicate banners inside the service owner", () => {
  assert.notEqual(patch(selector), selector);
  const duplicate = selector.replace(currentBanner, `${currentBanner},duplicate:{${currentBanner}}`);
  assert.equal(duplicate.split(currentBanner).length - 1, 2);

  assert.throws(() => patch(duplicate), /unified.*contract/i);
});

test("unified helper uses a fresh binding across minified parameter and local collisions", async () => {
  // Rspack destructures the helper parameters in a separate minified scope.
  // Copying its caller's root alias into that formal list can duplicate any
  // binding, while a local collision can shadow or redeclare the injected root.
  for (const root of ["b", "d", "s", "n", "l"]) {
    const current = selector.replace("i=(0,constants.Kt)", `${root}=(0,constants.Kt)`)
      .replaceAll("join(i,", `join(${root},`);
    assert.doesNotThrow(() => new vm.Script(current));
    const patched = patch(current);
    assert.doesNotThrow(() => new vm.Script(patched));
    assert.equal(patch(patched), patched);
    const { initialize, threadConfig } = vm.runInNewContext(`${patched};({initialize,threadConfig})`, {
      lookup: () => ({ plugin: { localVersion: "latest", name: "cua" }, marketplace: { name: "bundled" } }),
      path: () => path,
      constants: { Il: "services", Kt: () => "/trusted-plugin" },
      require, process: { env: { CODEX_LINUX_CUA_HOST_SOCKET: "/runtime/cua.sock" } },
    });
    const selection = {
      browserBackends: ["native"], cuaReplSurfaces: ["computer"], nodeRepl: { env: {} },
      desktopFeatureAvailability: { deferCuaTools: true },
    };
    const cached = await initialize({ selection });
    assert.equal(cached.cuaReplEnabled, true);
    assert.equal(cached.selection, selection);
    assert.equal(selection.codexLinuxCuaPluginRoot, "/trusted-plugin");
    const result = await threadConfig({ cached, features: { browserUseTinysky: true } });
    assert.equal(result.env.CUA_REPL_ENABLED_SURFACES, "computer");
    assert.equal(JSON.parse(result.env.services).sky, "/trusted-plugin/scripts/native-service.mjs");
    assert.equal(result.env.CODEX_LINUX_CUA_HOST_SOCKET, "/runtime/cua.sock");
    assert.equal(result.env.NODE_REPL_JS_BANNER,
      'await import("@oai/cua/tinyskyAlt");await(await import("/trusted-plugin/scripts/native-client.mjs")).installLinuxComputerUse(cua);');
  }
});

test("unified helper avoids existing generated names in locals and nested scopes", () => {
  const current = selector.replace("let l={};return s.includes",
    "let codexLinuxCuaPluginRoot=1;function nested(codexLinuxCuaPluginRoot1){return codexLinuxCuaPluginRoot1}let l={};return s.includes");
  const patched = patch(current);
  assert.match(patched, /nodeRepl:n,accessBootstrapPath:a\},codexLinuxCuaPluginRoot2\)/);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.equal(patch(patched), patched);
});

test("unified helper avoids an escaped lexical binding when allocating its plugin root", async () => {
  const current = selector.replace("let l={};return s.includes",
    String.raw`let codexLinuxCuaPluginR\u006fot=1;let l={};return s.includes`);
  assert.notEqual(patch(selector), selector);
  assert.doesNotThrow(() => new vm.Script(current));
  const patched = patch(current);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.equal(patch(patched), patched);
  const { initialize, threadConfig } = vm.runInNewContext(`${patched};({initialize,threadConfig})`, {
    lookup: () => ({ plugin: { localVersion: "verified", name: "cua" }, marketplace: { name: "bundled" } }),
    path: () => path,
    constants: { Il: "services", Kt: () => "/trusted-plugin" },
    require, process: { env: {} },
  });
  const selection = {
    browserBackends: ["native"], cuaReplSurfaces: ["computer"], nodeRepl: { env: {} },
    desktopFeatureAvailability: { deferCuaTools: true },
  };
  const cached = await initialize({ selection });
  const result = await threadConfig({ cached, features: { browserUseTinysky: true } });
  assert.equal(JSON.parse(result.env.services).sky, "/trusted-plugin/scripts/native-service.mjs");
  assert.ok(result.env.NODE_REPL_JS_BANNER.includes('/trusted-plugin/scripts/native-client.mjs'));
});

test("unified helper validates caller and helper root relationships separately", () => {
  const patched = patch(selector);
  assert.throws(() => patch(patched.replace("accessBootstrapPath:bootstrap},i)", "accessBootstrapPath:bootstrap},other)")), /unified.*contract/i);
  assert.throws(() => patch(patched.replace(
    'codexLinuxCuaPluginRoot.replace(/\\/$/,"")+"/scripts/native-service.mjs"',
    'other.replace(/\\/$/,"")+"/scripts/native-service.mjs"')), /unified.*contract/i);
  assert.throws(() => patch(patched.replace(
    'codexLinuxCuaPluginRoot.replace(/\\/$/,"")+"/scripts/native-client.mjs"',
    'other.replace(/\\/$/,"")+"/scripts/native-client.mjs"')), /unified.*contract/i);
});

test("unified thread configuration retains the trusted root per cached connection", async () => {
  const resolutions = [];
  const { initialize, threadConfig } = vm.runInNewContext(`${patch(selector)};({initialize,threadConfig})`, {
    lookup: () => ({ plugin: { localVersion: "verified-version", name: "cua" }, marketplace: { name: "bundled" } }),
    path: () => path,
    constants: { Il: "services", Kt: metadata => {
      resolutions.push(metadata);
      return path.join(metadata.codexHome, "trusted-plugin");
    } },
    require, process: { env: { CODEX_LINUX_CUA_HOST_SOCKET: "/runtime/cua.sock" } },
  });
  const cache = [];
  for (const home of ["/first", "/second"]) {
    const selection = {
      codexHome: home, marketplaceName: "bundled", browserBackends: ["native"],
      cuaReplSurfaces: ["browser", "computer"], nodeRepl: { env: { existing: "kept" } },
      desktopFeatureAvailability: { deferCuaTools: true },
    };
    cache.push(await initialize({ selection }));
  }
  assert.equal(resolutions.length, 2);
  assert.equal(resolutions[0].localVersion, "verified-version");
  for (const cached of cache.reverse()) {
    const config = await threadConfig({ cached, features: { browserUseTinysky: true }, nodeRepl: { env: { perThread: "private-env" } } });
    const expectedRoot = path.join(cached.selection.codexHome, "trusted-plugin");
    assert.equal(JSON.parse(config.env.services).sky, path.join(expectedRoot, "scripts/native-service.mjs"));
    assert.equal(JSON.parse(config.env.services).browser, "@oai/browser-desktop/service");
    assert.equal(config.env.perThread, "private-env");
    assert.equal(config.env.CODEX_LINUX_CUA_HOST_SOCKET, "/runtime/cua.sock");
    assert.ok(config.env.NODE_REPL_JS_BANNER.includes(path.join(expectedRoot, "scripts/native-client.mjs")));
  }
  assert.equal(resolutions.length, 2, "thread resumes reuse verified metadata without another lookup");
  delete cache[0].selection.codexLinuxCuaPluginRoot;
  await assert.rejects(threadConfig({ cached: cache[0], features: { browserUseTinysky: true } }),
    /Linux Computer Use trusted plugin root is unavailable/);
});

test("unified browser-only thread configuration receives its banner root", async () => {
  const { initialize, threadConfig } = vm.runInNewContext(`${patch(selector)};({initialize,threadConfig})`, {
    lookup: () => ({ plugin: { localVersion: "verified-version", name: "cua" }, marketplace: { name: "bundled" } }),
    path: () => path, constants: { Il: "services", Kt: () => "/trusted-plugin" }, require, process: { env: {} },
  });
  const selection = {
    browserBackends: ["native"], cuaReplSurfaces: ["browser"], nodeRepl: { env: {} },
    desktopFeatureAvailability: { deferCuaTools: true },
  };
  const cached = await initialize({ selection });
  const config = await threadConfig({ cached, features: { browserUseTinysky: true } });
  assert.equal(JSON.parse(config.env.services).sky, undefined);
  assert.ok(config.env.NODE_REPL_JS_BANNER.includes("/trusted-plugin/scripts/native-client.mjs"));
  cached.cuaReplEnabled = false;
  delete selection.codexLinuxCuaPluginRoot;
  assert.equal((await threadConfig({ cached, features: { browserUseTinysky: true } })).enabled, false);
});

test("unified propagation rejects missing, ambiguous, or changed builder consumers", () => {
  for (const changed of [
    selector + "build(extra)",
    selector + "const alias=build;",
    selector + "configure(extra)",
    selector.replace("return {selection:selection", "return {selection:other"),
    selector.replace("selection=posture?.selection", "selection=other?.selection"),
    selector.replace("selection={...selection,", "selection={...other,"),
    // The retired pre-26.1021 thread configuration without the principal lookup.
    selector.replace("principal=local?await connection.getAuthenticatedPrincipal().catch(()=>null):null,", ""),
  ]) {
    assert.throws(() => patch(changed), /unified.*contract/i);
  }
  assert.doesNotThrow(() => patch(selector + "function unrelated(){return constants.build(extra)}"));
  const patched = patch(selector);
  for (const changed of [
    patched.replace("codexLinuxCuaContext:selection", "codexLinuxCuaContext:other"),
    patched.replace(",selection.codexLinuxCuaPluginRoot)", ")"),
    patched.replace("e.codexLinuxCuaContext.codexLinuxCuaPluginRoot=i;", ""),
  ]) {
    assert.throws(() => patch(changed), /unified.*contract/i);
  }
});


test("unified configuration tolerates an upstream parameter shadowing the path module", async () => {
  const shadowed = selector.replace("browserBackends:b", "browserBackends:path");
  const patched = patch(shadowed);
  assert.notEqual(patched, shadowed);
  assert.equal(patch(patched), patched);
  const { initialize, threadConfig } = vm.runInNewContext(`${patched};({initialize,threadConfig})`, {
    lookup: () => ({ plugin: { localVersion: "verified", name: "cua" }, marketplace: { name: "bundled" } }),
    path: () => path, constants: { Il: "services", Kt: () => "/trusted-plugin" },
    require, process: { env: {} },
  });
  const selection = {
    browserBackends: ["native"], cuaReplSurfaces: ["browser", "computer"], nodeRepl: { env: {} },
    desktopFeatureAvailability: { deferCuaTools: true },
  };
  const cached = await initialize({ selection });
  assert.equal(cached.cuaReplEnabled, true);
  const config = await threadConfig({ cached, features: { browserUseTinysky: true } });
  assert.deepEqual(JSON.parse(config.env.services), {
    browser: "@oai/browser-desktop/service", sky: "/trusted-plugin/scripts/native-service.mjs",
  });
  assert.equal(config.env.NODE_REPL_JS_BANNER,
    'await import("@oai/cua/tinyskyAlt");await(await import("/trusted-plugin/scripts/native-client.mjs")).installLinuxComputerUse(cua);');
});

test("Rspack modules keep unrelated aliases and class private names outside builder consumers", () => {
  const current = `function injectedFeatureHelper(){}exports.modules={1(e,t,r){"use strict";${selector};class Private{#build;#configure;read(){return this.#build}}},2(e,t,r){"use strict";let build=Symbol("other");let configure=Symbol("other")}}`;
  const patched = patch(current);
  assert.notEqual(patched, current);
  assert.equal(patch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
});


test("unified emitted native and browser configuration cannot capture a shadowed native resolver", async () => {
  const start = selector.indexOf("function build(");
  const end = selector.indexOf("async function initialize(");
  const builderShadow = selector.slice(0, start) +
    selector.slice(start, end).replace("browserBackends:b", "browserBackends:require") + selector.slice(end);
  const cases = [
    builderShadow,
    `exports.modules={1(e,t,require){"use strict";${selector};t.api={initialize,threadConfig}}}`,
    `exports.modules={1(e,t,r){"use strict";let require=null;${selector};t.api={initialize,threadConfig}}}`,
  ];
  for (const current of cases) {
    const patched = patch(current);
    assert.doesNotThrow(() => new vm.Script(patched));
    assert.equal(patch(patched), patched);
    const context = {
      exports: {}, require, path: () => path,
      lookup: () => ({ plugin: { localVersion: "verified", name: "cua" }, marketplace: { name: "bundled" } }),
      constants: { Il: "services", Kt: () => "/trusted-plugin/" }, process: { env: {} },
    };
    let api;
    if (current.startsWith("exports.modules")) {
      vm.runInNewContext(patched, context);
      const output = {};
      context.exports.modules[1]({}, output, null);
      api = output.api;
    } else api = vm.runInNewContext(`${patched};({initialize,threadConfig})`, context);
    for (const surfaces of [["computer"], ["browser"]]) {
      const selection = {
        browserBackends: ["native"], cuaReplSurfaces: surfaces, nodeRepl: { env: {} },
        desktopFeatureAvailability: { deferCuaTools: true },
      };
      const cached = await api.initialize({ selection });
      const config = await api.threadConfig({ cached, features: { browserUseTinysky: true } });
      assert.equal(config.env.CUA_REPL_ENABLED_SURFACES, surfaces[0]);
      assert.equal(JSON.parse(config.env.services).sky,
        surfaces[0] === "computer" ? "/trusted-plugin/scripts/native-service.mjs" : undefined);
      assert.ok(config.env.NODE_REPL_JS_BANNER.includes('"/trusted-plugin/scripts/native-client.mjs"'));
    }
  }
});
