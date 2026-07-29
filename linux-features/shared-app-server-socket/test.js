#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const vm = require("node:vm");

const {
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
  criticalFailuresFromReport,
} = require("../../scripts/lib/patch-report.js");
const {
  applyMainBundlePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  attachmentTransportClassSource,
  applySharedAppServerSocketPatch,
  descriptors,
  sharedTransportClassSource,
} = require("./patch.js");

const socketEnvHook = path.join(__dirname, "socket-env.sh");
const expectedPatchSentinel = "/*codex-linux:shared-app-server-socket:v2*/";
const unixSocketPathMaxBytes = 107;
const attachmentSelectorSource =
  "if(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY===`1`){if(e.hostConfig.kind!==`local`)throw Error(`external app-server socket mode requires a local host`);if(!process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET)throw Error(`external app-server socket mode requires CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET`);return new CodexLinuxExternalAppServerSocketTransport(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET)}";

function withFeatureConfig(enabled, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-socket-feature-"));
  const configPath = path.join(tempDir, "features.json");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;

  try {
    fs.writeFileSync(configPath, `${JSON.stringify({ enabled })}\n`);
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    return callback(path.resolve(__dirname, ".."));
  } finally {
    if (originalConfig == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function makeUnixSocketTempDir() {
  return fs.mkdtempSync("/tmp/cas-");
}

function assertUnixSocketPath(socketPath) {
  const byteLength = Buffer.byteLength(socketPath);
  if (byteLength > unixSocketPathMaxBytes) {
    throw new RangeError(
      `Unix socket path is ${byteLength} bytes; maximum is ${unixSocketPathMaxBytes}: ${socketPath}`,
    );
  }
}

function captureBoundedStderr(stream, maxBytes = 4000) {
  let stderr = Buffer.alloc(0);
  stream?.on("data", (chunk) => {
    stderr = Buffer.concat([stderr, Buffer.from(chunk)]);
    if (stderr.length > maxBytes) stderr = stderr.subarray(stderr.length - maxBytes);
  });
  return () => stderr.toString("utf8");
}

async function waitForSocket(socketPath, child, readStderr = () => "") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) {
      const stderr = readStderr().trim();
      throw new Error(
        `app-server exited before creating its socket (${child.exitCode})${
          stderr === "" ? "" : `\n${stderr}`
        }`,
      );
    }
    try {
      if (fs.statSync(socketPath).isSocket()) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for the app-server socket");
}

async function readWebSocketUpgrade(child) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for WebSocket upgrade")),
      5000,
    );
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onError = (error) => finish(error);
    const onData = (chunk) => {
      chunks.push(chunk);
      const response = Buffer.concat(chunks).toString("utf8");
      if (response.includes("\r\n\r\n")) finish(null, response);
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
  });
}

async function stopChild(child) {
  if (child == null || child.exitCode != null || child.signalCode != null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill();
  await closed;
}

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.signalCode = "SIGTERM";
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  };
  return child;
}

function nonExitingChild() {
  const child = fakeChild();
  child.killSignals = [];
  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    child.killSignals.push(signal);
    if (signal === "SIGKILL") {
      child.signalCode = "SIGKILL";
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    }
    return true;
  };
  return child;
}

function loadInjectedTransport({ spawnImpl, WebSocketImpl = null, fsImpl = fs, timeoutCapMs = null } = {}) {
  class DefaultWebSocket extends EventEmitter {
    constructor(_url, options) {
      super();
      this.stream = options.createConnection();
      queueMicrotask(() => this.emit("open"));
    }

    terminate() {
      this.terminated = true;
      this.stream?.destroy();
    }
  }
  class Adapter {
    constructor(socket) {
      this.socket = socket;
    }
  }
  const namespace = {
    WS: WebSocketImpl ?? DefaultWebSocket,
    keepAlive() {},
    Adapter,
  };
  const source = sharedTransportClassSource({
    namespace: "n",
    webSocketClass: "WS",
    webSocketUrl: "url",
    keepAlive: "keepAlive",
    adapterClass: "Adapter",
  });
  const context = {
    n: namespace,
    url: "ws://localhost/rpc",
    process,
    console,
    require(id) {
      if (id === "node:child_process") return { spawn: spawnImpl };
      if (id === "node:fs") return fsImpl;
      return require(id);
    },
    setTimeout(callback, delay, ...args) {
      const timer = setTimeout(
        callback,
        timeoutCapMs == null ? delay : Math.min(delay, timeoutCapMs),
        ...args,
      );
      if (timeoutCapMs != null) timer.unref = () => timer;
      return timer;
    },
    clearTimeout,
  };
  vm.runInNewContext(`${source};globalThis.Transport=CodexLinuxSharedAppServerSocketTransport`, context);
  return { Transport: context.Transport, namespace };
}

function loadInjectedAttachmentTransport({
  AdapterImpl = null,
  processImpl = process,
  spawnImpl,
  WebSocketImpl = null,
  fsImpl = fs,
  keepAliveImpl = () => {},
  timeoutCapMs = null,
} = {}) {
  assert.equal(
    typeof attachmentTransportClassSource,
    "function",
    "attachment-only transport source must be exported",
  );
  class DefaultWebSocket extends EventEmitter {
    constructor(_url, options) {
      super();
      this.stream = options.createConnection();
      queueMicrotask(() => this.emit("open"));
    }

    terminate() {
      this.terminated = true;
      this.stream?.destroy();
    }
  }
  class DefaultAdapter {
    constructor(socket) {
      this.socket = socket;
    }
  }
  const namespace = {
    WS: WebSocketImpl ?? DefaultWebSocket,
    keepAlive: keepAliveImpl,
    Adapter: AdapterImpl ?? DefaultAdapter,
  };
  const source = attachmentTransportClassSource({
    namespace: "n",
    webSocketClass: "WS",
    webSocketUrl: "url",
    keepAlive: "keepAlive",
    adapterClass: "Adapter",
  });
  const context = {
    n: namespace,
    url: "ws://localhost/rpc",
    process: processImpl,
    console,
    require(id) {
      if (id === "node:child_process") return { spawn: spawnImpl };
      if (id === "node:fs") return fsImpl;
      return require(id);
    },
    setTimeout(callback, delay, ...args) {
      const timer = setTimeout(
        callback,
        timeoutCapMs == null ? delay : Math.min(delay, timeoutCapMs),
        ...args,
      );
      if (timeoutCapMs != null) timer.unref = () => timer;
      return timer;
    },
    clearTimeout,
  };
  vm.runInNewContext(
    `${source};globalThis.Transport=CodexLinuxExternalAppServerSocketTransport`,
    context,
  );
  return { Transport: context.Transport, namespace, source };
}

function pathIdentity(candidate) {
  try {
    const stat = fs.lstatSync(candidate);
    return {
      device: stat.dev,
      inode: stat.ino,
      mode: stat.mode,
      type: stat.isSocket() ? "socket" : stat.isSymbolicLink() ? "symlink" : "other",
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function trackedAttachmentFs({ afterFstat = null } = {}) {
  const opened = [];
  const openFds = new Set();
  const closed = [];
  const fsImpl = {
    ...fs,
    openSync(candidate, flags, ...args) {
      const fd = fs.openSync(candidate, flags, ...args);
      opened.push({ candidate, fd, flags });
      openFds.add(fd);
      return fd;
    },
    fstatSync(fd, ...args) {
      const stat = fs.fstatSync(fd, ...args);
      afterFstat?.(fd, stat);
      return stat;
    },
    closeSync(fd) {
      const result = fs.closeSync(fd);
      if (openFds.delete(fd)) closed.push(fd);
      return result;
    },
  };
  return { closed, fsImpl, opened, openFds };
}

async function assertAttachmentValidationRejects({
  expectedError,
  fsImpl = fs,
  processImpl = process,
  socketPath,
}) {
  const before = pathIdentity(socketPath);
  let spawnCalls = 0;
  const { Transport } = loadInjectedAttachmentTransport({
    fsImpl,
    processImpl,
    spawnImpl() {
      spawnCalls += 1;
      return fakeChild();
    },
  });
  const transport = new Transport(socketPath);
  try {
    await assert.rejects(transport.connect(), expectedError);
    assert.equal(spawnCalls, 0, "validation rejection must happen before proxy spawn");
    assert.deepEqual(
      pathIdentity(socketPath),
      before,
      "validation rejection must preserve the configured endpoint inode and path",
    );
    assert.equal(
      fs.existsSync(`${socketPath}.lock`),
      false,
      "attachment validation must never create a bridge ownership lock",
    );
  } finally {
    transport.dispose();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function listenUnix(socketPath) {
  assertUnixSocketPath(socketPath);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

async function closeServer(server) {
  if (server == null) return;
  await new Promise((resolve) => server.close(resolve));
}

function syntheticBundle() {
  return [
    "var Ky=class{options;kind=`websocket`;logger=r.i(`AppServerTransportSshWebsocket`);proxyStreams=new Set;supportsReconnect(){return!0}",
    "async connect(){let t={current:null},r=new n.zn(Fy,{perMessageDeflate:!1,createConnection:()=>",
    "(t.current=this.createSshProxyStream(),t.current)});return n.Ln(r,{onPongTimeout:()=>r.terminate()}),new n.Rn(r)}};",
    "function n6(e){let t=Jy(e.hostConfig);if(t)return Z.info(`selected app-server transport`),new Ky(t);",
    "if(e.transportKind===`remote-control`)return new Remote(e);",
    "if(n.io(e.hostConfig))return new Wsl({hostConfig:e.hostConfig,repoRoot:e.repoRoot,resourcesPath:e.resourcesPath,defaultOriginator:e.defaultOriginator});",
    "let r=r6(e.hostConfig);if(r){e.desktopAuthAppServerClient;let t=p8(e.hostConfig,r);return new n.Fn({hostConfig:e.hostConfig,websocketUrl:r,getWebsocketProtocols:void 0,...t==null?{}:{socksProxyUrl:t}})}",
    "return new n.Nn({hostConfig:e.hostConfig,repoRoot:e.repoRoot,resourcesPath:e.resourcesPath,defaultOriginator:e.defaultOriginator})}function afterFactory(){}",
  ].join("");
}

test("filesystem Unix socket fixtures use a compact private path budget", () => {
  assert.equal(
    typeof makeUnixSocketTempDir,
    "function",
    "compact Unix socket fixture helper must exist",
  );
  assert.equal(
    typeof assertUnixSocketPath,
    "function",
    "Unix socket path budget guard must exist",
  );
  const tempDir = makeUnixSocketTempDir();
  try {
    assert.match(tempDir, /^\/tmp\/cas-[^/]+$/);
    assert.equal(fs.statSync(tempDir).mode & 0o777, 0o700);
    const nestedSocketPath = path.join(tempDir, "real-root", "nested", "app-server.sock");
    assert.doesNotThrow(() => assertUnixSocketPath(nestedSocketPath));
    assert.ok(Buffer.byteLength(nestedSocketPath) <= 107);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Unix socket path budget rejects paths longer than 107 bytes", () => {
  assert.equal(
    typeof assertUnixSocketPath,
    "function",
    "Unix socket path budget guard must exist",
  );
  assert.doesNotThrow(() => assertUnixSocketPath(`/tmp/${"x".repeat(102)}`));
  assert.throws(
    () => assertUnixSocketPath(`/tmp/${"x".repeat(103)}`),
    /Unix socket path is 108 bytes; maximum is 107/,
  );
});

test("waitForSocket includes bounded authority stderr on early exit", async () => {
  assert.equal(
    typeof captureBoundedStderr,
    "function",
    "bounded stderr capture helper must exist",
  );
  const stderr = new PassThrough();
  const readStderr = captureBoundedStderr(stderr);
  const ended = once(stderr, "end");
  stderr.end(`${"x".repeat(5000)}\nError: path must be shorter than SUN_LEN\n`);
  await ended;
  await assert.rejects(
    waitForSocket("/missing/socket", { exitCode: 1 }, readStderr),
    (error) => {
      assert.match(error.message, /path must be shorter than SUN_LEN/);
      assert.ok(Buffer.byteLength(error.message) <= 4100);
      return true;
    },
  );
});

function partialPatchStates() {
  const source = syntheticBundle();
  const symbols = {
    namespace: "n",
    webSocketClass: "zn",
    webSocketUrl: "Fy",
    keepAlive: "Ln",
    adapterClass: "Rn",
  };
  const ownerSelector =
    "if(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET&&e.hostConfig.kind===`local`)return new CodexLinuxSharedAppServerSocketTransport(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET);";
  const completePatch = applySharedAppServerSocketPatch(source);
  const withoutAttachmentSelector = completePatch.replace(attachmentSelectorSource, "");
  const ownerSelectorEnd = withoutAttachmentSelector.indexOf(ownerSelector) + ownerSelector.length;
  const misorderedCompletePatch =
    withoutAttachmentSelector.slice(0, ownerSelectorEnd) +
    attachmentSelectorSource +
    withoutAttachmentSelector.slice(ownerSelectorEnd);
  return {
    "marker only": `${expectedPatchSentinel}${source}`,
    "attachment class only": `class CodexLinuxExternalAppServerSocketTransport{}${source}`,
    "attachment selector only": source.replace(
      "function n6(e){",
      `function n6(e){${attachmentSelectorSource}`,
    ),
    "prior shared-authority patch only": source
      .replace("function n6(e){", `${sharedTransportClassSource(symbols)}function n6(e){`)
      .replace("let r=r6(e.hostConfig);", `${ownerSelector}let r=r6(e.hostConfig);`),
    "complete patch with attachment selector after shared selector": misorderedCompletePatch,
  };
}

test("shared-app-server-socket stays disabled until explicitly enabled", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });
  withFeatureConfig(["shared-app-server-socket"], (featuresRoot) => {
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).map((entry) => entry.id),
      ["feature:shared-app-server-socket:main-process-shared-app-server-socket"],
    );
  });
});

test("feature stages only the socket environment hook", () => {
  withFeatureConfig(["shared-app-server-socket"], (featuresRoot) => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-socket-app-"));
    try {
      const plan = stageEnabledLinuxFeatureInstall(appDir, { featuresRoot });
      assert.deepEqual(
        plan.runtimeHooks.map((hook) => [hook.key, path.basename(hook.target), hook.mode.toString(8)]),
        [["launcher", "shared-app-server-socket-socket-env.sh", "755"]],
      );
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });
});

test("patch selects the bridge only for the local host and is idempotent", () => {
  const source = syntheticBundle();
  const patched = applySharedAppServerSocketPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applySharedAppServerSocketPatch(patched), patched);
  assert.equal(patched.split(expectedPatchSentinel).length - 1, 1);
  assert.match(patched, /CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET/);
  assert.match(patched, /hostConfig\.kind===`local`/);
  assert.match(patched, /app-server`,\s*`proxy`,\s*`--sock`/);
  assert.match(patched, /app-server`,\s*`--listen`,\s*`unix:\/\//);
  assert.match(patched, /await this\.ensureAuthority\(\)/);
  assert.match(patched, /e\.once\(`close`,t\);try\{e\.kill\(\)/);
  assert.match(patched, /openSync\(this\.lockPath,`wx`,384\)/);
  assert.match(patched, /\/proc\/\$\{e\}\/stat/);
  assert.match(patched, /reclaimStaleLock/);
  assert.match(patched, /this\.sameIdentity\(this\.socketIdentity,e\)/);
  assert.match(patched, /requires CODEX_CLI_PATH/);
  assert.match(patched, /new n\.zn\(Fy,/);
  assert.match(patched, /new n\.Rn\(/);
  assert.match(patched, /supportsReconnect\(\)\{return!0\}/);
});

test("patch rejects every inconsistent or misordered state before attachment mode can run", async (t) => {
  for (const [name, source] of Object.entries(partialPatchStates())) {
    await t.test(name, () => {
      assert.throws(
        () => applySharedAppServerSocketPatch(source),
        /inconsistent shared app-server socket patch state/,
      );
    });
  }
});

test("production patch engine records feature drift and partial states as required failures", async (t) => {
  const cases = {
    "unsupported bundle drift": "unrelated bundle",
    "inconsistent partial patch state": partialPatchStates()["marker only"],
  };

  for (const [name, source] of Object.entries(cases)) {
    await t.test(name, () => {
      const report = createPatchReport();
      const { patchedSource } = applyMainBundlePatchDescriptors(
        source,
        descriptors,
        {},
        report,
      );
      const entry = report.patches.find(
        (patch) => patch.name === "main-process-shared-app-server-socket",
      );

      assert.equal(patchedSource, source);
      assert.equal(entry?.status, "failed-required");
      assert.equal(entry?.ciPolicy, "required-upstream");
      assert.ok(
        criticalFailuresFromReport(report).some(
          (failure) => failure.name === "main-process-shared-app-server-socket",
        ),
      );
    });
  }
});

test("candidate patch gate aborts on feature drift and partial patch states", async (t) => {
  const cases = {
    "unsupported bundle drift": "unrelated bundle",
    "inconsistent partial patch state": partialPatchStates()["marker only"],
  };

  for (const [name, source] of Object.entries(cases)) {
    await t.test(name, () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shared-socket-required-gate-"));
      const featuresRoot = path.join(tempRoot, "linux-features");
      const featureDir = path.join(featuresRoot, "shared-app-server-socket");
      const extractedDir = path.join(tempRoot, "app-extracted");
      const buildDir = path.join(extractedDir, ".vite", "build");
      const reportPath = path.join(tempRoot, "patch-report.json");
      fs.mkdirSync(featureDir, { recursive: true });
      fs.mkdirSync(buildDir, { recursive: true });
      fs.copyFileSync(path.join(__dirname, "feature.json"), path.join(featureDir, "feature.json"));
      fs.copyFileSync(path.join(__dirname, "patch.js"), path.join(featureDir, "patch.js"));
      fs.copyFileSync(path.join(__dirname, "README.md"), path.join(featureDir, "README.md"));
      fs.writeFileSync(
        path.join(featuresRoot, "features.json"),
        `${JSON.stringify({ enabled: ["shared-app-server-socket"] })}\n`,
      );
      fs.writeFileSync(path.join(buildDir, "main.js"), source);
      fs.writeFileSync(path.join(extractedDir, "package.json"), "{}\n");

      try {
        const result = spawnSync(
          process.execPath,
          [
            path.join(__dirname, "..", "..", "scripts", "patch-linux-window-ui.js"),
            "--enforce-critical",
            "--report-json",
            reportPath,
            extractedDir,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              CODEX_LINUX_FEATURES_CONFIG: path.join(featuresRoot, "features.json"),
              CODEX_LINUX_FEATURES_ROOT: featuresRoot,
            },
          },
        );
        assert.equal(
          fs.existsSync(reportPath),
          true,
          `candidate patch gate must write its report before exiting\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        const featureEntry = report.patches.find(
          (patch) =>
            patch.name ===
            "feature:shared-app-server-socket:main-process-shared-app-server-socket",
        );

        assert.equal(result.status, 1);
        assert.equal(featureEntry?.status, "failed-required");
        assert.equal(featureEntry?.ciPolicy, "required-upstream");
        assert.match(
          result.stderr,
          /feature:shared-app-server-socket:main-process-shared-app-server-socket \(failed-required\)/,
        );
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test("patch selects attachment-only transport only for explicit local mode and fails closed", () => {
  const patched = applySharedAppServerSocketPatch(syntheticBundle());
  assert.match(patched, /CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY===`1`/);
  assert.match(patched, /new CodexLinuxExternalAppServerSocketTransport/);

  const select = (env, hostKind = "local") => {
    const context = {
      process: { env },
      require,
      console,
      setTimeout,
      clearTimeout,
      r: { i: () => null },
      Z: { info() {} },
      Jy: () => null,
      n: {
        io: () => false,
        WS: class {},
        keepAlive() {},
        Adapter: class {},
      },
      Fy: "ws://localhost/rpc",
    };
    vm.runInNewContext(`${patched};globalThis.selectTransport=n6`, context);
    return context.selectTransport({ hostConfig: { kind: hostKind } });
  };

  const socketPath = "/tmp/gate4-attachment-only.sock";
  const attachment = select({
    CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY: "1",
    CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET: socketPath,
  });
  assert.equal(attachment.constructor.name, "CodexLinuxExternalAppServerSocketTransport");
  assert.equal(attachment.socketPath, socketPath);

  const owner = select({
    CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY: "true",
    CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET: socketPath,
  });
  assert.equal(owner.constructor.name, "CodexLinuxSharedAppServerSocketTransport");

  assert.throws(
    () => select({ CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY: "1" }),
    /requires CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET/,
  );
  assert.throws(
    () =>
      select(
        {
          CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY: "1",
          CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET: socketPath,
        },
        "ssh",
      ),
    /requires a local host/,
  );
});

test("attachment-only transport source excludes authority lifecycle primitives", () => {
  const { source } = loadInjectedAttachmentTransport({
    spawnImpl() {
      return fakeChild();
    },
  });
  assert.match(source, /app-server`,\s*`proxy`,\s*`--sock`/);
  for (const prohibited of [
    /app-server`,\s*`--listen`/,
    /acquireOwnership/,
    /ensureAuthority/,
    /lockIdentity/,
    /releaseOwnedPaths/,
    /socketIdentity/,
    /startAuthority/,
    /stopAuthority/,
    /unlinkSync/,
  ]) {
    assert.doesNotMatch(source, prohibited);
  }
});

test("attachment-only transport inode-binds the validated parent across a path swap", async () => {
  const tempDir = makeUnixSocketTempDir();
  const parentDir = path.join(tempDir, "authority");
  const heldParentDir = path.join(tempDir, "authority-held");
  const replacementDir = path.join(tempDir, "replacement");
  const socketPath = path.join(parentDir, "app-server.sock");
  const replacementSocketPath = path.join(replacementDir, "app-server.sock");
  fs.mkdirSync(parentDir, { mode: 0o700 });
  fs.mkdirSync(replacementDir, { mode: 0o700 });
  const originalServer = await listenUnix(socketPath);
  const replacementServer = await listenUnix(replacementSocketPath);
  fs.chmodSync(socketPath, 0o600);
  fs.chmodSync(replacementSocketPath, 0o600);
  const originalIdentity = pathIdentity(socketPath);
  const replacementIdentity = pathIdentity(replacementSocketPath);
  let swapped = false;
  const tracking = trackedAttachmentFs({
    afterFstat() {
      if (swapped) return;
      fs.renameSync(parentDir, heldParentDir);
      fs.renameSync(replacementDir, parentDir);
      swapped = true;
    },
  });
  const proxy = fakeChild();
  let spawnedSocketPath = null;
  let spawnedSocketIdentity = null;
  const { Transport } = loadInjectedAttachmentTransport({
    fsImpl: tracking.fsImpl,
    spawnImpl(_command, args) {
      spawnedSocketPath = args.at(-1);
      spawnedSocketIdentity = pathIdentity(spawnedSocketPath);
      return proxy;
    },
  });
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";

  try {
    const transport = new Transport(socketPath);
    await transport.connect();
    assert.equal(swapped, true, "test must replace the configured parent after its fd is bound");
    assert.match(
      spawnedSocketPath,
      new RegExp(`^/proc/${process.pid}/fd/\\d+/app-server\\.sock$`),
    );
    assert.deepEqual(spawnedSocketIdentity, originalIdentity);
    assert.deepEqual(pathIdentity(socketPath), replacementIdentity);
    assert.equal(tracking.openFds.size, 0, "validation fd must close after WebSocket open");
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
    const proxyClosed = once(proxy, "close");
    transport.dispose();
    await proxyClosed;
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await Promise.all([closeServer(originalServer), closeServer(replacementServer)]);
    for (const fd of tracking.openFds) fs.closeSync(fd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("attachment-only transport closes each validation fd on every connect exit", async (t) => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const server = await listenUnix(socketPath);
  fs.chmodSync(socketPath, 0o600);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";

  async function runCase(name, {
    expectedError = null,
    spawnImpl = () => fakeChild(),
    timeoutCapMs = null,
    WebSocketImpl = null,
  }) {
    await t.test(name, async () => {
      const tracking = trackedAttachmentFs();
      const { Transport } = loadInjectedAttachmentTransport({
        fsImpl: tracking.fsImpl,
        spawnImpl,
        timeoutCapMs,
        WebSocketImpl,
      });
      const transport = new Transport(socketPath);
      try {
        if (expectedError == null) await transport.connect();
        else await assert.rejects(transport.connect(), expectedError);
        assert.equal(tracking.opened.length, 1);
        assert.equal(
          tracking.opened[0].flags & 3,
          fs.constants.O_RDONLY,
          "parent fd must be opened read-only",
        );
        assert.notEqual(tracking.opened[0].flags & fs.constants.O_DIRECTORY, 0);
        assert.notEqual(tracking.opened[0].flags & fs.constants.O_NOFOLLOW, 0);
        assert.equal(tracking.openFds.size, 0);
        assert.deepEqual(tracking.closed, [tracking.opened[0].fd]);
      } finally {
        transport.dispose();
        for (const fd of tracking.openFds) fs.closeSync(fd);
      }
    });
  }

  class ConstructorFailureWebSocket {
    constructor(_url, options) {
      options.createConnection();
      throw new Error("constructor failure");
    }
  }
  class ErrorWebSocket extends EventEmitter {
    constructor(_url, options) {
      super();
      this.stream = options.createConnection();
      queueMicrotask(() => this.emit("error", new Error("pre-open error")));
    }

    terminate() {
      this.stream.destroy();
    }
  }
  class CloseWebSocket extends EventEmitter {
    constructor(_url, options) {
      super();
      this.stream = options.createConnection();
      queueMicrotask(() => this.emit("close"));
    }

    terminate() {
      this.stream.destroy();
    }
  }
  class TimeoutWebSocket extends EventEmitter {
    constructor(_url, options) {
      super();
      this.stream = options.createConnection();
    }

    terminate() {
      this.stream.destroy();
    }
  }

  try {
    await runCase("successful WebSocket open", {});
    await runCase("synchronous proxy spawn failure", {
      expectedError: /spawn failure/,
      spawnImpl() {
        throw new Error("spawn failure");
      },
    });
    await runCase("WebSocket constructor failure", {
      expectedError: /constructor failure/,
      WebSocketImpl: ConstructorFailureWebSocket,
    });
    await runCase("pre-open WebSocket error", {
      expectedError: /pre-open error/,
      WebSocketImpl: ErrorWebSocket,
    });
    await runCase("pre-open WebSocket close", {
      expectedError: /closed before opening/,
      WebSocketImpl: CloseWebSocket,
    });
    await runCase("WebSocket open timeout", {
      expectedError: /open timed out/,
      timeoutCapMs: 5,
      WebSocketImpl: TimeoutWebSocket,
    });

    await t.test("dispose while WebSocket open is pending", async () => {
      const tracking = trackedAttachmentFs();
      let webSocket;
      class PendingWebSocket extends EventEmitter {
        constructor(_url, options) {
          super();
          webSocket = this;
          this.stream = options.createConnection();
        }

        terminate() {
          this.stream.destroy();
        }
      }
      const { Transport } = loadInjectedAttachmentTransport({
        fsImpl: tracking.fsImpl,
        spawnImpl: () => fakeChild(),
        WebSocketImpl: PendingWebSocket,
      });
      const transport = new Transport(socketPath);
      const pending = transport.connect();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(tracking.openFds.size, 1);
      transport.dispose();
      assert.equal(tracking.openFds.size, 0);
      webSocket.emit("close");
      await assert.rejects(pending, /closed before opening/);
      assert.deepEqual(tracking.closed, [tracking.opened[0].fd]);
    });
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("concurrent attachment connects own independent validation fds", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const server = await listenUnix(socketPath);
  fs.chmodSync(socketPath, 0o600);
  const tracking = trackedAttachmentFs();
  const webSockets = [];
  class PendingWebSocket extends EventEmitter {
    constructor(_url, options) {
      super();
      this.stream = options.createConnection();
      webSockets.push(this);
    }

    terminate() {
      this.stream.destroy();
    }
  }
  const { Transport } = loadInjectedAttachmentTransport({
    fsImpl: tracking.fsImpl,
    spawnImpl: () => fakeChild(),
    WebSocketImpl: PendingWebSocket,
  });
  const transport = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";

  try {
    const first = transport.connect();
    const second = transport.connect();
    assert.equal(tracking.openFds.size, 2);
    assert.notEqual(tracking.opened[0].fd, tracking.opened[1].fd);
    webSockets[0].emit("open");
    await first;
    assert.equal(tracking.openFds.size, 1);
    webSockets[1].emit("open");
    await second;
    assert.equal(tracking.openFds.size, 0);
    assert.equal(new Set(tracking.closed).size, 2);
    transport.dispose();
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    for (const fd of tracking.openFds) fs.closeSync(fd);
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("attachment-only transport disposes its proxy without changing the external socket", async () => {
  assert.equal(
    typeof attachmentTransportClassSource,
    "function",
    "attachment-only transport source must be exported",
  );
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const server = await listenUnix(socketPath);
  fs.chmodSync(socketPath, 0o600);
  const before = fs.lstatSync(socketPath);
  const spawnCalls = [];
  const proxy = fakeChild();
  const { Transport } = loadInjectedAttachmentTransport({
    spawnImpl(command, args) {
      spawnCalls.push({ command, args: Array.from(args) });
      return proxy;
    },
  });
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    const transport = new Transport(socketPath);
    await transport.connect();
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "/fake/codex");
    assert.deepEqual(spawnCalls[0].args.slice(0, -1), ["app-server", "proxy", "--sock"]);
    assert.match(
      spawnCalls[0].args.at(-1),
      new RegExp(`^/proc/${process.pid}/fd/\\d+/app-server\\.sock$`),
    );

    const proxyClosed = once(proxy, "close");
    transport.dispose();
    await proxyClosed;

    const after = fs.lstatSync(socketPath);
    assert.equal(`${after.dev}:${after.ino}`, `${before.dev}:${before.ino}`);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
    assert.equal(proxy.killed, true);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("attachment-only transport reconnects to the same socket after disposal", async () => {
  assert.equal(
    typeof attachmentTransportClassSource,
    "function",
    "attachment-only transport source must be exported",
  );
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const server = await listenUnix(socketPath);
  fs.chmodSync(socketPath, 0o600);
  const before = fs.lstatSync(socketPath);
  const proxies = [];
  const spawnCalls = [];
  const { Transport } = loadInjectedAttachmentTransport({
    spawnImpl(command, args) {
      const proxy = fakeChild();
      proxies.push(proxy);
      spawnCalls.push({ command, args: Array.from(args) });
      return proxy;
    },
  });
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const transport = new Transport(socketPath);
      await transport.connect();
      const proxyClosed = once(proxies[attempt], "close");
      transport.dispose();
      await proxyClosed;
    }

    assert.equal(spawnCalls.length, 2);
    for (const spawnCall of spawnCalls) {
      assert.equal(spawnCall.command, "/fake/codex");
      assert.deepEqual(spawnCall.args.slice(0, -1), ["app-server", "proxy", "--sock"]);
      assert.match(
        spawnCall.args.at(-1),
        new RegExp(`^/proc/${process.pid}/fd/\\d+/app-server\\.sock$`),
      );
    }
    const after = fs.lstatSync(socketPath);
    assert.equal(`${after.dev}:${after.ino}`, `${before.dev}:${before.ino}`);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("attachment-only transport cleans up when WebSocket construction opens a proxy then throws", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const server = await listenUnix(socketPath);
  fs.chmodSync(socketPath, 0o600);
  const before = fs.lstatSync(socketPath);
  const proxy = fakeChild();
  class ThrowingWebSocket {
    constructor(_url, options) {
      options.createConnection();
      throw new Error("WebSocket constructor failed after creating its connection");
    }
  }
  const { Transport } = loadInjectedAttachmentTransport({
    WebSocketImpl: ThrowingWebSocket,
    spawnImpl() {
      return proxy;
    },
  });
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    const transport = new Transport(socketPath);
    await assert.rejects(transport.connect(), /constructor failed/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(proxy.killed, true);
    assert.equal(transport.proxyStreams.size, 0);
    assert.equal(transport.proxyChildren?.size, 0);
    const after = fs.lstatSync(socketPath);
    assert.equal(`${after.dev}:${after.ino}`, `${before.dev}:${before.ino}`);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

for (const failureStage of ["keepAlive", "Adapter"]) {
  test(`attachment-only transport cleans up when ${failureStage} construction throws`, async () => {
    const tempDir = makeUnixSocketTempDir();
    const socketPath = path.join(tempDir, "app-server.sock");
    const server = await listenUnix(socketPath);
    fs.chmodSync(socketPath, 0o600);
    const before = fs.lstatSync(socketPath);
    const proxy = fakeChild();
    let webSocket;
    class TrackingWebSocket extends EventEmitter {
      constructor(_url, options) {
        super();
        webSocket = this;
        this.stream = options.createConnection();
        queueMicrotask(() => this.emit("open"));
      }

      terminate() {
        this.terminated = true;
        this.stream.destroy();
      }
    }
    class ThrowingAdapter {
      constructor() {
        throw new Error("Adapter construction failed");
      }
    }
    const { Transport } = loadInjectedAttachmentTransport({
      AdapterImpl: failureStage === "Adapter" ? ThrowingAdapter : null,
      keepAliveImpl() {
        if (failureStage === "keepAlive") throw new Error("keepAlive setup failed");
      },
      WebSocketImpl: TrackingWebSocket,
      spawnImpl() {
        return proxy;
      },
    });
    const originalCli = process.env.CODEX_CLI_PATH;
    process.env.CODEX_CLI_PATH = "/fake/codex";
    try {
      const transport = new Transport(socketPath);
      await assert.rejects(transport.connect(), new RegExp(`${failureStage} .*failed`));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(webSocket.terminated, true);
      assert.equal(proxy.killed, true);
      assert.equal(transport.proxyStreams.size, 0);
      assert.equal(transport.proxyChildren.size, 0);
      const after = fs.lstatSync(socketPath);
      assert.equal(`${after.dev}:${after.ino}`, `${before.dev}:${before.ino}`);
      assert.equal(fs.existsSync(`${socketPath}.lock`), false);
    } finally {
      if (originalCli == null) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = originalCli;
      await closeServer(server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

test("attachment-only transport escalates a non-exiting proxy and tracks it until close", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const server = await listenUnix(socketPath);
  fs.chmodSync(socketPath, 0o600);
  const before = fs.lstatSync(socketPath);
  const proxy = nonExitingChild();
  const { Transport } = loadInjectedAttachmentTransport({
    timeoutCapMs: 5,
    spawnImpl() {
      return proxy;
    },
  });
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    const transport = new Transport(socketPath);
    await transport.connect();
    const proxyClosed = once(proxy, "close").then(() => true);
    transport.dispose();
    const trackedUntilClose = transport.proxyChildren?.has(proxy) ?? false;
    const didClose = await Promise.race([
      proxyClosed,
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    assert.equal(trackedUntilClose, true);
    assert.equal(didClose, true);
    assert.deepEqual(proxy.killSignals, ["SIGTERM", "SIGKILL"]);
    assert.equal(transport.proxyChildren.size, 0);
    const after = fs.lstatSync(socketPath);
    assert.equal(`${after.dev}:${after.ino}`, `${before.dev}:${before.ino}`);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("attachment-only transport rejects every untrusted endpoint without mutation", async (t) => {
  assert.equal(
    typeof attachmentTransportClassSource,
    "function",
    "attachment-only transport source must be exported",
  );

  await t.test("missing socket", async () => {
    const tempDir = makeUnixSocketTempDir();
    const socketPath = path.join(tempDir, "app-server.sock");
    try {
      await assertAttachmentValidationRejects({
        expectedError: /ENOENT|does not exist/,
        socketPath,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test("relative configured path", async () => {
    const tempDir = makeUnixSocketTempDir();
    const socketPath = path.join(tempDir, "app-server.sock");
    const server = await listenUnix(socketPath);
    fs.chmodSync(socketPath, 0o600);
    const relativeSocketPath = path.relative(process.cwd(), socketPath);
    try {
      await assertAttachmentValidationRejects({
        expectedError: /requires an absolute path/,
        socketPath: relativeSocketPath,
      });
    } finally {
      await closeServer(server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test("lexical parent alias", async () => {
    const tempDir = makeUnixSocketTempDir();
    const parentDir = path.join(tempDir, "authority");
    fs.mkdirSync(parentDir, { mode: 0o700 });
    const socketPath = path.join(parentDir, "app-server.sock");
    const aliasedSocketPath = `${parentDir}/../authority/app-server.sock`;
    const server = await listenUnix(socketPath);
    fs.chmodSync(socketPath, 0o600);
    try {
      await assertAttachmentValidationRejects({
        expectedError: /parent path is not canonical/,
        socketPath: aliasedSocketPath,
      });
    } finally {
      await closeServer(server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test("direct parent symlink", async () => {
    const tempDir = makeUnixSocketTempDir();
    const realParent = path.join(tempDir, "real");
    const linkedParent = path.join(tempDir, "linked");
    fs.mkdirSync(realParent, { mode: 0o700 });
    fs.symlinkSync(realParent, linkedParent);
    const realSocketPath = path.join(realParent, "app-server.sock");
    const linkedSocketPath = path.join(linkedParent, "app-server.sock");
    const server = await listenUnix(realSocketPath);
    fs.chmodSync(realSocketPath, 0o600);
    try {
      await assertAttachmentValidationRejects({
        expectedError: /parent is not a real directory/,
        socketPath: linkedSocketPath,
      });
    } finally {
      await closeServer(server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test("intermediate parent symlink", async () => {
    const tempDir = makeUnixSocketTempDir();
    const realRoot = path.join(tempDir, "real-root");
    const realParent = path.join(realRoot, "nested");
    const linkedRoot = path.join(tempDir, "linked-root");
    fs.mkdirSync(realParent, { recursive: true, mode: 0o700 });
    fs.symlinkSync(realRoot, linkedRoot);
    const realSocketPath = path.join(realParent, "app-server.sock");
    const linkedSocketPath = path.join(linkedRoot, "nested", "app-server.sock");
    const server = await listenUnix(realSocketPath);
    fs.chmodSync(realSocketPath, 0o600);
    try {
      await assertAttachmentValidationRejects({
        expectedError: /parent path contains a symlink/,
        socketPath: linkedSocketPath,
      });
    } finally {
      await closeServer(server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test("leaf symlink", async () => {
    const tempDir = makeUnixSocketTempDir();
    const realSocketPath = path.join(tempDir, "real.sock");
    const linkedSocketPath = path.join(tempDir, "app-server.sock");
    const server = await listenUnix(realSocketPath);
    fs.chmodSync(realSocketPath, 0o600);
    fs.symlinkSync(realSocketPath, linkedSocketPath);
    try {
      await assertAttachmentValidationRejects({
        expectedError: /endpoint is not a real Unix socket/,
        socketPath: linkedSocketPath,
      });
    } finally {
      await closeServer(server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test("current UID unavailable", async () => {
    const tempDir = makeUnixSocketTempDir();
    const socketPath = path.join(tempDir, "app-server.sock");
    const server = await listenUnix(socketPath);
    fs.chmodSync(socketPath, 0o600);
    try {
      await assertAttachmentValidationRejects({
        expectedError: /current UID is unavailable/,
        processImpl: { env: process.env },
        socketPath,
      });
    } finally {
      await closeServer(server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  for (const [name, inspectedPath] of [
    ["wrong-owner parent", "parent"],
    ["wrong-owner socket", "socket"],
  ]) {
    await t.test(name, async () => {
      const tempDir = makeUnixSocketTempDir();
      const socketPath = path.join(tempDir, "app-server.sock");
      const server = await listenUnix(socketPath);
      fs.chmodSync(socketPath, 0o600);
      const wrongOwnerPath = inspectedPath === "parent" ? tempDir : socketPath;
      const wrongOwnerFs = {
        ...fs,
        lstatSync(candidate, ...args) {
          const stat = fs.lstatSync(candidate, ...args);
          const isInspectedSocket =
            inspectedPath === "socket" &&
            (candidate === wrongOwnerPath ||
              /^\/proc\/self\/fd\/\d+\/app-server\.sock$/.test(candidate));
          if (candidate !== wrongOwnerPath && !isInspectedSocket) return stat;
          return new Proxy(stat, {
            get(target, property, receiver) {
              if (property === "uid") return target.uid + 1;
              return Reflect.get(target, property, receiver);
            },
          });
        },
      };
      try {
        await assertAttachmentValidationRejects({
          expectedError:
            inspectedPath === "parent"
              ? /parent has unexpected owner/
              : /socket has unexpected owner/,
          fsImpl: wrongOwnerFs,
          socketPath,
        });
      } finally {
        await closeServer(server);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  for (const [name, property, value, expectedError] of [
    ["opened parent inode changed", "ino", (stat) => stat.ino + 1, /parent changed during validation/],
    ["opened parent owner changed", "uid", (stat) => stat.uid + 1, /parent has unexpected owner/],
    [
      "opened parent owner access changed",
      "mode",
      (stat) => (stat.mode & ~0o777) | 0o300,
      /parent owner read and execute permissions are required/,
    ],
    [
      "opened parent became group-writable",
      "mode",
      (stat) => stat.mode | 0o020,
      /parent has unsafe permissions/,
    ],
  ]) {
    await t.test(name, async () => {
      const tempDir = makeUnixSocketTempDir();
      const socketPath = path.join(tempDir, "app-server.sock");
      const server = await listenUnix(socketPath);
      fs.chmodSync(socketPath, 0o600);
      const fstatFs = {
        ...fs,
        fstatSync(fd, ...args) {
          const stat = fs.fstatSync(fd, ...args);
          return new Proxy(stat, {
            get(target, candidate, receiver) {
              if (candidate === property) return value(target);
              return Reflect.get(target, candidate, receiver);
            },
          });
        },
      };
      try {
        await assertAttachmentValidationRejects({
          expectedError,
          fsImpl: fstatFs,
          socketPath,
        });
      } finally {
        await closeServer(server);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  for (const [name, mode] of [
    ["group-writable parent", 0o720],
    ["other-writable parent", 0o702],
  ]) {
    await t.test(name, async () => {
      const tempDir = makeUnixSocketTempDir();
      const socketPath = path.join(tempDir, "app-server.sock");
      const server = await listenUnix(socketPath);
      fs.chmodSync(socketPath, 0o600);
      fs.chmodSync(tempDir, mode);
      try {
        await assertAttachmentValidationRejects({
          expectedError: /parent has unsafe permissions/,
          socketPath,
        });
      } finally {
        await closeServer(server);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  for (const [name, mode] of [
    ["parent owner read bit missing", 0o300],
    ["parent owner execute bit missing", 0o400],
  ]) {
    await t.test(name, async () => {
      const tempDir = makeUnixSocketTempDir();
      const socketPath = path.join(tempDir, "app-server.sock");
      const server = await listenUnix(socketPath);
      fs.chmodSync(socketPath, 0o600);
      const modeFs = {
        ...fs,
        lstatSync(candidate, ...args) {
          const stat = fs.lstatSync(candidate, ...args);
          if (candidate !== tempDir) return stat;
          return new Proxy(stat, {
            get(target, property, receiver) {
              if (property === "mode") return (target.mode & ~0o777) | mode;
              return Reflect.get(target, property, receiver);
            },
          });
        },
      };
      try {
        await assertAttachmentValidationRejects({
          expectedError: /parent owner read and execute permissions are required/,
          fsImpl: modeFs,
          socketPath,
        });
      } finally {
        await closeServer(server);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  await t.test("parent is not a directory", async () => {
    const tempDir = makeUnixSocketTempDir();
    const parentPath = path.join(tempDir, "authority");
    const socketPath = path.join(parentPath, "app-server.sock");
    fs.writeFileSync(parentPath, "", { mode: 0o600 });
    try {
      await assertAttachmentValidationRejects({
        expectedError: /parent is not a real directory/,
        socketPath,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test("endpoint is not a socket", async () => {
    const tempDir = makeUnixSocketTempDir();
    const socketPath = path.join(tempDir, "app-server.sock");
    fs.writeFileSync(socketPath, "", { mode: 0o600 });
    try {
      await assertAttachmentValidationRejects({
        expectedError: /endpoint is not a real Unix socket/,
        socketPath,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  for (const [name, mode] of [
    ["owner read bit missing", 0o200],
    ["owner write bit missing", 0o400],
  ]) {
    await t.test(name, async () => {
      const tempDir = makeUnixSocketTempDir();
      const socketPath = path.join(tempDir, "app-server.sock");
      const server = await listenUnix(socketPath);
      fs.chmodSync(socketPath, mode);
      try {
        await assertAttachmentValidationRejects({
          expectedError: /socket owner read and write permissions are required/,
          socketPath,
        });
      } finally {
        await closeServer(server);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  for (const [name, mode] of [
    ["group read bit", 0o640],
    ["group write bit", 0o620],
    ["group execute bit", 0o610],
    ["other read bit", 0o604],
    ["other write bit", 0o602],
    ["other execute bit", 0o601],
  ]) {
    await t.test(name, async () => {
      const tempDir = makeUnixSocketTempDir();
      const socketPath = path.join(tempDir, "app-server.sock");
      const server = await listenUnix(socketPath);
      fs.chmodSync(socketPath, mode);
      try {
        await assertAttachmentValidationRejects({
          expectedError: /socket has unsafe group or other permissions/,
          socketPath,
        });
      } finally {
        await closeServer(server);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }
});

test("attachment-only endpoint validation allows parent read/execute and owner execute bits", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const server = await listenUnix(socketPath);
  fs.chmodSync(tempDir, 0o755);
  fs.chmodSync(socketPath, 0o700);
  const before = pathIdentity(socketPath);
  const proxy = fakeChild();
  const { Transport } = loadInjectedAttachmentTransport({
    spawnImpl() {
      return proxy;
    },
  });
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    const transport = new Transport(socketPath);
    await transport.connect();
    const proxyClosed = once(proxy, "close");
    transport.dispose();
    await proxyClosed;
    assert.deepEqual(pathIdentity(socketPath), before);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("patch leaves unsupported bundle shapes unchanged with a warning", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(applySharedAppServerSocketPatch("unrelated bundle"), "unrelated bundle");
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /shared app-server socket/i);
});

test("patch rejects the previous SSH transport class shape", () => {
  const source = syntheticBundle().replace(
    "class{options;kind=`websocket`;logger=r.i(`AppServerTransportSshWebsocket`);",
    "class{kind=`websocket`;",
  );
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(applySharedAppServerSocketPatch(source), source);
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /SSH WebSocket transport/);
});

test("descriptor is required-upstream and targets the main bundle", () => {
  assert.deepEqual(
    descriptors.map(({ id, phase, ciPolicy }) => [id, phase, ciPolicy]),
    [["main-process-shared-app-server-socket", "main-bundle", "required-upstream"]],
  );
});

test("socket hook exports an instance-scoped path without starting a process", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-socket-runtime-"));
  const env = {
    ...process.env,
    CODEX_LINUX_APP_ID: "codex-bridge-test",
    CODEX_LINUX_APP_STATE_DIR: path.join(tempDir, "state"),
    XDG_RUNTIME_DIR: tempDir,
  };
  delete env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET;
  try {
    const result = spawnSync(socketEnvHook, [], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      `env CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET=${tempDir}/codex-bridge-test/app-server-bridge/app-server.sock`,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport rejects an existing socket without unlinking it", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const server = await listenUnix(socketPath);
  let spawnCalls = 0;
  const { Transport } = loadInjectedTransport({
    spawnImpl() {
      spawnCalls += 1;
      return fakeChild();
    },
  });
  const transport = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    await assert.rejects(transport.ensureAuthority(), /path already exists/);
    assert.equal(spawnCalls, 0);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport serializes startup and removes only its owned socket", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const servers = new Map();
  const children = [];
  let replacement;
  let replacementError;
  let installReplacementBeforeChildClose = false;
  const identityFs = {
    ...fs,
    lstatSync(candidate, ...args) {
      const stat = fs.lstatSync(candidate, ...args);
      if (candidate !== socketPath || !installReplacementBeforeChildClose) return stat;
      return new Proxy(stat, {
        get(target, property, receiver) {
          if (property === "ino") return target.ino + 1;
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
  const { Transport } = loadInjectedTransport({
    fsImpl: identityFs,
    spawnImpl(_command, args) {
      const child = fakeChild();
      children.push(child);
      const target = args.at(-1).replace("unix://", "");
      queueMicrotask(async () => {
        const server = await listenUnix(target);
        servers.set(child, server);
        child.kill = () => {
          child.killed = true;
          child.signalCode = "SIGTERM";
          server.close(() => {
            setImmediate(() => {
              Promise.resolve()
                .then(async () => {
                  if (installReplacementBeforeChildClose) replacement = await listenUnix(target);
                })
                .catch((error) => {
                  replacementError = error;
                })
                .finally(() => {
                  child.emit("close", null, "SIGTERM");
                });
            });
          });
          return true;
        };
      });
      return child;
    },
  });
  const first = new Transport(socketPath);
  const second = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    await first.ensureAuthority();
    assert.equal(fs.existsSync(`${socketPath}.lock`), true);
    await assert.rejects(second.ensureAuthority(), /already owned/);

    installReplacementBeforeChildClose = true;
    const childClosed = once(children[0], "close");
    first.dispose();
    await childClosed;
    assert.ifError(replacementError);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true, "replacement socket must survive dispose");
    await closeServer(replacement);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport shares one readiness promise across concurrent connections", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  let spawnCalls = 0;
  let server;
  const { Transport } = loadInjectedTransport({
    spawnImpl(_command, args) {
      spawnCalls += 1;
      const child = fakeChild();
      const target = args.at(-1).replace("unix://", "");
      setTimeout(async () => {
        server = await listenUnix(target);
        child.kill = () => {
          child.signalCode = "SIGTERM";
          server.close(() => child.emit("close", null, "SIGTERM"));
          return true;
        };
      }, 25);
      return child;
    },
  });
  const transport = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    const first = transport.ensureAuthority();
    const second = transport.ensureAuthority();
    let resolvedEarly = false;
    second.then(() => {
      resolvedEarly = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(resolvedEarly, false, "concurrent callers must wait for socket readiness");
    await Promise.all([first, second]);
    assert.equal(spawnCalls, 1);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
    transport.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport fails closed on a live owner's lock", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  const selfStat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const selfStartTime = selfStat.slice(selfStat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  fs.writeFileSync(lockPath, `${process.pid} ${selfStartTime}\n`, { mode: 0o600 });
  let spawnCalls = 0;
  const { Transport } = loadInjectedTransport({
    spawnImpl() {
      spawnCalls += 1;
      return fakeChild();
    },
  });
  const transport = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    await assert.rejects(transport.ensureAuthority(), /already owned/);
    assert.equal(spawnCalls, 0);
    assert.equal(fs.readFileSync(lockPath, "utf8"), `${process.pid} ${selfStartTime}\n`);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport reclaims a dead owner's lock when no socket exists", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  fs.writeFileSync(lockPath, "99999999 1\n", { mode: 0o600 });
  const { Transport } = loadInjectedTransport({ spawnImpl: () => fakeChild() });
  const transport = new Transport(socketPath);
  try {
    await transport.acquireOwnership();
    assert.match(fs.readFileSync(lockPath, "utf8"), new RegExp(`^${process.pid} \\d+\\n$`));
    transport.releaseOwnedPaths();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport preserves a dead owner's lock while its socket is live", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  fs.writeFileSync(lockPath, "99999999 1\n", { mode: 0o600 });
  const server = await listenUnix(socketPath);
  const { Transport } = loadInjectedTransport({ spawnImpl: () => fakeChild() });
  try {
    await assert.rejects(new Transport(socketPath).acquireOwnership(), /already owned/);
    assert.equal(fs.readFileSync(lockPath, "utf8"), "99999999 1\n");
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  } finally {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport reclaims a dead owner's unbound socket inode", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const stalePath = `${socketPath}.stale`;
  const lockPath = `${socketPath}.lock`;
  fs.writeFileSync(lockPath, "99999999 1\n", { mode: 0o600 });
  const server = await listenUnix(socketPath);
  fs.renameSync(socketPath, stalePath);
  await closeServer(server);
  fs.renameSync(stalePath, socketPath);
  const { Transport } = loadInjectedTransport({ spawnImpl: () => fakeChild() });
  const transport = new Transport(socketPath);
  try {
    await transport.acquireOwnership();
    assert.equal(fs.existsSync(socketPath), false);
    assert.match(fs.readFileSync(lockPath, "utf8"), new RegExp(`^${process.pid} \\d+\\n$`));
    transport.releaseOwnedPaths();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport reclaims an old legacy lock but preserves a recent one", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  const { Transport } = loadInjectedTransport({ spawnImpl: () => fakeChild() });
  try {
    fs.writeFileSync(lockPath, "", { mode: 0o600 });
    await assert.rejects(new Transport(socketPath).acquireOwnership(), /already owned/);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    const transport = new Transport(socketPath);
    await transport.acquireOwnership();
    assert.match(fs.readFileSync(lockPath, "utf8"), new RegExp(`^${process.pid} \\d+\\n$`));
    transport.releaseOwnedPaths();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport preserves a replacement lock inode", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  const oldLockPath = `${lockPath}.old`;
  const { Transport } = loadInjectedTransport({ spawnImpl: () => fakeChild() });
  const transport = new Transport(socketPath);
  try {
    await transport.acquireOwnership();
    fs.renameSync(lockPath, oldLockPath);
    fs.writeFileSync(lockPath, "replacement\n", { mode: 0o600 });
    transport.releaseOwnedPaths();
    assert.equal(fs.readFileSync(lockPath, "utf8"), "replacement\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

for (const [failureKind, spawnImpl] of [
  ["asynchronous", () => {
    const child = fakeChild();
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
    return child;
  }],
  ["synchronous", () => {
    throw new Error("spawn failed");
  }],
]) {
  test(`injected transport releases ownership after ${failureKind} spawn failure`, async () => {
    const tempDir = makeUnixSocketTempDir();
    const socketPath = path.join(tempDir, "app-server.sock");
    const { Transport } = loadInjectedTransport({ spawnImpl });
    const transport = new Transport(socketPath);
    const originalCli = process.env.CODEX_CLI_PATH;
    process.env.CODEX_CLI_PATH = "/missing/codex";
    try {
      await assert.rejects(transport.ensureAuthority(), /spawn failed/);
      assert.equal(fs.existsSync(`${socketPath}.lock`), false);
    } finally {
      if (originalCli == null) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = originalCli;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

test("injected transport does not release ownership until authority exit is verified", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const child = fakeChild();
  child.kill = () => {
    queueMicrotask(() => child.emit("error", new Error("kill failed")));
    return false;
  };
  const { Transport } = loadInjectedTransport({ spawnImpl: () => child, timeoutCapMs: 10 });
  const transport = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    await assert.rejects(transport.ensureAuthority(), /creation timed out/);
    assert.equal(fs.existsSync(`${socketPath}.lock`), true, "unverified child retains ownership lock");
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("normal authority exit releases its owned socket and lock", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  let server;
  let child;
  const { Transport } = loadInjectedTransport({
    spawnImpl(_command, args) {
      child = fakeChild();
      const target = args.at(-1).replace("unix://", "");
      queueMicrotask(async () => {
        server = await listenUnix(target);
      });
      return child;
    },
  });
  const transport = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    await transport.ensureAuthority();
    await closeServer(server);
    server = null;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fs.existsSync(socketPath), false);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("disposing before async startup resumes releases ownership without spawning", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const child = fakeChild();
  child.kill = () => {
    child.signalCode = "SIGTERM";
    setTimeout(() => child.emit("close", null, "SIGTERM"), 10);
    return true;
  };
  const { Transport } = loadInjectedTransport({ spawnImpl: () => child });
  const transport = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    const startup = transport.ensureAuthority();
    transport.dispose();
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
    await assert.rejects(startup, /disposed during startup/);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
    assert.equal(child.signalCode, null);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("post-start authority errors close active proxy streams without crashing", async () => {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  let server;
  let child;
  const { Transport } = loadInjectedTransport({
    spawnImpl(_command, args) {
      child = fakeChild();
      const target = args.at(-1).replace("unix://", "");
      queueMicrotask(async () => {
        server = await listenUnix(target);
        child.kill = () => {
          child.signalCode = "SIGTERM";
          server.close(() => child.emit("close", null, "SIGTERM"));
          return true;
        };
      });
      return child;
    },
  });
  const transport = new Transport(socketPath);
  const proxy = {
    destroyed: false,
    destroy(error) {
      this.destroyed = true;
      this.error = error;
    },
  };
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    await transport.ensureAuthority();
    transport.proxyStreams.add(proxy);
    assert.doesNotThrow(() => child.emit("error", new Error("runtime failure")));
    assert.equal(proxy.destroyed, true);
    assert.match(proxy.error.message, /runtime failure/);
    transport.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("asynchronous cleanup failures warn instead of escaping Electron callbacks", () => {
  const warnings = [];
  const originalWarn = console.warn;
  const fsImpl = {
    ...fs,
    lstatSync() {
      const error = new Error("cleanup denied");
      error.code = "EACCES";
      throw error;
    },
  };
  const { Transport } = loadInjectedTransport({ spawnImpl: () => fakeChild(), fsImpl });
  const transport = new Transport("/unused/socket");
  transport.socketIdentity = { dev: 1, ino: 1 };
  transport.lockIdentity = { dev: 2, ino: 2 };
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.doesNotThrow(() => transport.releaseOwnedPaths(true));
    assert.match(warnings.join("\n"), /cleanup failed/);
    assert.deepEqual(transport.socketIdentity, { dev: 1, ino: 1 });
    assert.deepEqual(transport.lockIdentity, { dev: 2, ino: 2 });
  } finally {
    console.warn = originalWarn;
  }
});

test("injected transport connects through its proxy and disposes the proxy stream", async () => {
  const proxy = fakeChild();
  const { Transport, namespace } = loadInjectedTransport({ spawnImpl: () => proxy });
  const transport = new Transport("/unused/socket");
  transport.ensureAuthority = async () => {};
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    const adapter = await transport.connect();
    assert.equal(adapter instanceof namespace.Adapter, true);
    assert.equal(transport.proxyStreams.size, 1);
    adapter.socket.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(proxy.killed, true);
    assert.equal(transport.proxyStreams.size, 0);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
  }
});

for (const failure of ["error", "timeout"]) {
  test(`injected transport cleans up proxy and WebSocket on pre-open ${failure}`, async () => {
    let socket;
    class FailingWebSocket extends EventEmitter {
      constructor(_url, options) {
        super();
        socket = this;
        this.stream = options.createConnection();
        if (failure === "error") queueMicrotask(() => this.emit("error", new Error("open failed")));
      }

      terminate() {
        this.terminated = true;
        this.stream.destroy();
      }
    }
    const proxy = fakeChild();
    const { Transport } = loadInjectedTransport({
      spawnImpl: () => proxy,
      WebSocketImpl: FailingWebSocket,
      timeoutCapMs: 10,
    });
    const transport = new Transport("/unused/socket");
    transport.ensureAuthority = async () => {};
    const originalCli = process.env.CODEX_CLI_PATH;
    process.env.CODEX_CLI_PATH = "/fake/codex";
    try {
      await assert.rejects(
        transport.connect(),
        failure === "error" ? /open failed/ : /open timed out/,
      );
      assert.equal(socket.terminated, true);
      assert.equal(proxy.killed, true);
      assert.equal(transport.proxyStreams.size, 0);
    } finally {
      if (originalCli == null) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = originalCli;
    }
  });
}

test("socket environment hook shell syntax is valid", () => {
  const result = spawnSync("bash", ["-n", socketEnvHook], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("real Codex proxy attaches through the Desktop parent-PID proc fd path", { timeout: 15000 }, async (t) => {
  const codexCli = process.env.CODEX_CLI_PATH;
  if (codexCli == null) {
    t.skip("set CODEX_CLI_PATH to run the real Codex app-server integration test");
    return;
  }

  const tempDir = makeUnixSocketTempDir();
  const codexHome = path.join(tempDir, "codex-home");
  const socketPath = path.join(tempDir, "authority", "app-server.sock");
  const parentDir = path.dirname(socketPath);
  const binDir = path.join(tempDir, "bin");
  const wrapperPath = path.join(binDir, "codex");
  fs.mkdirSync(codexHome, { mode: 0o700 });
  fs.mkdirSync(parentDir, { mode: 0o700 });
  fs.mkdirSync(binDir, { mode: 0o700 });
  const parentFd = fs.openSync(
    parentDir,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  const procSocketPath = `/proc/${process.pid}/fd/${parentFd}/${path.basename(socketPath)}`;
  fs.writeFileSync(
    wrapperPath,
    [
      "#!/usr/bin/env bash",
      "set -eu",
      'if [ "$#" -eq 2 ] && [ "$1" = "app-server" ] && [ "$2" = "proxy" ]; then',
      '  exec "$REAL_CODEX" app-server proxy --sock "$DESKTOP_SOCKET"',
      "fi",
      'exec "$REAL_CODEX" "$@"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    DESKTOP_SOCKET: procSocketPath,
    PATH: `${binDir}:${process.env.PATH}`,
    REAL_CODEX: codexCli,
  };
  assertUnixSocketPath(socketPath);
  const authority = spawn(codexCli, ["app-server", "--listen", `unix://${socketPath}`], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const readAuthorityStderr = captureBoundedStderr(authority.stderr);
  let proxy;

  try {
    await waitForSocket(socketPath, authority, readAuthorityStderr);
    assert.equal(
      fs.statSync(socketPath).mode & 0o077,
      0,
      "app-server socket must not grant group/other access",
    );
    assert.deepEqual(pathIdentity(procSocketPath), pathIdentity(socketPath));

    proxy = spawn("bash", ["-c", "codex app-server proxy"], {
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const responsePromise = readWebSocketUpgrade(proxy);
    proxy.stdin.end(
      [
        "GET /rpc HTTP/1.1",
        "Host: localhost",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    const response = await responsePromise;
    assert.match(response, /^HTTP\/1\.1 101 /);
    assert.match(response.toLowerCase(), /upgrade: websocket/);
  } finally {
    await Promise.all([stopChild(proxy), stopChild(authority)]);
    fs.closeSync(parentFd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
