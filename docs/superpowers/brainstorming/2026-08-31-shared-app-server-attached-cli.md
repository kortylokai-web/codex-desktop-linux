# Brainstorming: Shared App-Server Attached CLI

**Status:** approved
**Source:** `.autonomous/csc-attached-cli-internal-pr/phase-1-handoff.md`

## Context

The delivery branch is `feat/csc-attached-cli` at the required base
`bd610e96e87bda672f384c79ce5bb87ea0d5a6ee`. The prerequisite CSC candidate is
already a stateless stdio MCP plugin. This repository only needs to expose a
normal Codex CLI client attached to Desktop's existing app-server authority.
The seam must remain generic enough for a future Hermes caller; it must not add
CSC- or Hermes-specific code.

The official payload already supplies `resources/codex`. Its stock top-level
`--remote` option accepts a Unix socket, and its stock exit status is the desired
client result. The disabled-by-default `shared-app-server-socket` feature already
owns the effective socket configuration, authority lock, single app-server
lifecycle, and orphan handling. The smallest design extends that feature. It
does not add a feature ID, dependency, service, proxy, or second authority.

Feature resources are staged in the application tree. The existing packaging
flow carries that tree into source builds, deb, RPM, pacman, AppImage, and Nix,
and the native update-builder copies the enabled feature tree and feature
configuration. The launcher is already Bash on all supported Linux formats.

## Current Decisions

- Extend `shared-app-server-socket`; expose `codex-desktop --cli [args]` through
  the common launcher and leave ordinary Desktop launch unchanged ([Q1](#q1-where-does-the-attached-client-belong)).
- Publish the running Desktop's effective connection and executable identity in
  one fixed private runtime record, then verify the live authority with a
  feature-owned Bash resource ([Q2](#q2-how-does-the-client-discover-and-trust-the-running-authority)).
- Keep the wrapper grammar deliberately smaller than the Codex grammar: block
  caller-controlled authority and endpoint arguments, preserve data after `--`,
  and otherwise delegate to the stock CLI ([Q3](#q3-what-is-the-public-command-and-argument-contract)).
- Reuse existing feature, staging, update, and removal paths for every format
  and architecture ([Q4](#q4-how-do-enable-update-and-removal-work-across-formats)).
- Add only boundary tests and reader-facing documentation needed to protect the
  contract ([Q5](#q5-what-evidence-and-documentation-are-required)).

## Q&A

### Q1: Where does the attached client belong?

**Decision**

Extend the existing disabled `shared-app-server-socket` feature. Add one
feature-owned executable Bash resource and one exact leading-argument dispatch
in the common launcher:

```text
codex-desktop --cli [Codex CLI arguments]
```

The launcher removes only `--cli` and delegates to the feature resource. The
resource verifies the running Desktop authority and then `exec`s the stock
Codex CLI. `exec` is required: there is no wrapper-owned child lifecycle, and
the caller receives the stock CLI's exit status and signals unchanged.

Packaging wrappers pass caller arguments to the common launcher unchanged.
The two Nix wrappers stop injecting their duplicated conditional Wayland flags.
After the common launcher handles an exact leading `--cli`, its ordinary
Desktop path derives those same three flags once from `NIXOS_OZONE_WL` and
`WAYLAND_DISPLAY`. CLI mode therefore receives only caller Codex arguments,
while ordinary Nix Desktop launch retains the existing Electron behavior.

If the feature is disabled, `--cli` fails before Desktop launch with status 2
and this concise error:

```text
codex-desktop: --cli requires the shared-app-server-socket feature
```

Without an exact leading `--cli`, launcher behavior is unchanged. In
particular, enabling the feature does not turn ordinary `codex-desktop` into a
CLI command and does not create an app server outside Desktop.

**Why this is the smallest boundary**

The existing feature already owns the authority whose socket is being exposed.
A second feature would split one lifecycle contract across two feature IDs and
create an unnecessary dependency edge, enablement state, README, and update
surface. A native-only wrapper would require separate AppImage and Nix behavior.
An external CSC or Hermes wrapper would duplicate distribution and authority
logic. The common command plus one existing-feature resource avoids all three.

### Q2: How does the client discover and trust the running authority?

**Decision**

Desktop's feature startup writes a versioned discovery record at a fixed,
app-scoped location independent of the configured socket:

```text
${XDG_RUNTIME_DIR:-$CODEX_LINUX_APP_STATE_DIR}/
  ${CODEX_LINUX_APP_ID}/app-server-bridge/attached-cli-v1
```

The actual path is one line; it is wrapped above only for readability. The
record contains only a fixed schema version, application ID, the feature's
already-selected effective socket path, the running Desktop executable path,
and the selected packaged Codex executable path. Startup rejects newline or NUL
in fields, writes a complete mode-`0600` temporary file in the private runtime
directory, and atomically renames it into place. The caller does not derive the
socket, read `CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET`, or honor `CODEX_CLI_PATH`.

The record is discovery, not authority. Before `exec`, the dependency-free
feature Bash verifier uses Linux `/proc` and the baseline utilities already
required by the launcher to fail closed unless all of these hold:

1. The app-scoped directory is non-symlink, owned by the current user, and mode
   `0700`; the record is a regular non-symlink file with the same owner and mode
   `0600`.
2. The socket's parent is private and non-symlink. The socket is a Unix socket
   and its adjacent existing authority lock is a regular non-symlink file; both
   are owned by the current user and mode `0600`.
3. The lock has exactly the existing four fields. Its owner and authority PIDs
   are live, non-zombie processes owned by the current user, and their recorded
   `/proc` start times still match.
4. The owner executable matches the Desktop path written by that owner. The
   authority is the owner's direct child, its executable matches the recorded
   Codex path, and its command is the feature's expected packaged Codex
   `app-server --listen unix://<effective socket>` command, including only the
   configuration prefix already accepted by the existing authority predicate.
5. The socket has exactly one listening authority and that authority owns the
   socket inode. Immediately before `exec`, the verifier rechecks the record,
   lock, socket identity, PID/start-time/parent relationship, command, and
   listener identity against its initial snapshot.

The verifier never sends a signal, removes or renames state, creates a socket,
scans for another endpoint, starts Desktop, or starts an app server. It is not a
second cleanup implementation. Stale state is harmless because it cannot pass
the live process and listener checks.

Failure is intentionally terse and nonzero:

| Condition | Exit | Message |
| --- | ---: | --- |
| Record absent or Desktop not live | 1 | `codex-desktop: Desktop shared app server is not available` |
| Unsafe type, mode, ownership, syntax, or changed state | 1 | `codex-desktop: Desktop shared app-server state is unsafe` |
| Live identities, parentage, command, or listener do not match | 1 | `codex-desktop: shared app-server authority does not match Desktop` |

Errors do not echo paths, PIDs, record contents, or user arguments.

**Cross-format identity invariant**

The verifier does not compare the invoking launcher's application path with the
running Desktop path. Two invocations of the same AppImage may have different
temporary mount paths, so that check would reject a valid authority. Instead,
the running Desktop records its own executable and selected Codex executable;
the verifier binds those paths to the live owner and direct-child authority via
`/proc`, then `exec`s that same recorded Codex executable. The fixed application
ID scopes discovery. Existing build information remains packaging evidence, not
a fabricated runtime authentication token. This invariant works unchanged for
native, AppImage, Nix, amd64, and arm64 layouts.

### Q3: What is the public command and argument contract?

**Decision**

The launcher recognizes only an exact leading `--cli`. The feature resource
scans arguments up to the first standalone `--`. It preserves the original
argument array and passes every argument after that delimiter literally.

Before the delimiter, it rejects:

- `--remote`, `--remote=...`, `--remote-auth-token-env`, and
  `--remote-auth-token-env=...`;
- `--sock`, `--sock=...`, `--listen`, and `--listen=...`;
- values beginning with `unix://`, `ws://`, or `wss://`;
- the authority/server entry points `app-server`, `remote-control`,
  `mcp-server`, and `exec-server`.

The reserved server names are rejected before `--` even when they occur as
nested arguments; callers that intend them as literal data must place them
after `--`. Rejection uses status 2 and one message:

```text
codex-desktop: --cli does not accept caller endpoint or authority options
```

There is no wrapper option for a socket, remote address, authentication token,
authority PID, discovery path, scan, recovery, or server startup.

Help and version behavior is explicit:

- `codex-desktop --help` remains launcher help and documents `--cli` only when
  the feature is enabled.
- With the feature enabled, exact `--cli -h`, `--cli --help`, `--cli -V`,
  `--cli --version`, and `--cli help [args]` forms `exec` the packaged stock CLI
  without requiring a live record or injecting `--remote`. This permits
  introspection without Desktop and cannot attach or start an authority.
- With the feature disabled, every leading `--cli` form, including help and
  version, returns the feature-disabled error from Q1.
- All other accepted invocations require the verified live Desktop authority
  and become:

  ```text
  <recorded Codex executable> --remote unix://<recorded socket> [original args]
  ```

Non-owner subcommands are not reimplemented or classified by the wrapper. They
run with stock parsing, output, and exit behavior. If a stock subcommand does
not support remote operation, its stock failure is the result. The wrapper does
not grow a parallel Codex command taxonomy.

### Q4: How do enable, update, and removal work across formats?

**Decision**

There is no new enablement switch. Users enable the existing
`shared-app-server-socket` feature through the repository's existing setup or
native-package feature selection, `CODEX_LINUX_FEATURES` noninteractive build
input, Nix `linuxFeatures`, or AppImage build configuration. No environment
incantation is needed at invocation time.

The Bash resource lives in the existing feature directory and is staged with
that directory. The common launcher dispatch is shared by source builds, deb,
RPM, pacman, AppImage, and Nix. It contains no architecture-specific executable,
so the same design covers amd64 and arm64.

Both Nix wrappers keep their existing runtime environment setup but pass only
the caller argument vector. The common launcher owns conditional Nix Wayland
flags in its ordinary Desktop path. This removes the duplicated positional
injection and prevents Electron-only flags from entering CLI help, version, or
normal attached commands.

The native update-builder already copies the complete enabled feature directory,
feature configuration, and launcher template. It therefore carries the helper
and dispatch together; no updater branch, migration helper, or dependency is
added. AppImage users rebuild or replace the AppImage through the existing flow,
and Nix users rebuild the derivation through the existing flow.

Disabling the existing feature and rebuilding removes the verifier resource and
the Desktop socket/record producer together. The launcher then gives the Q1
disabled error for `--cli` while ordinary Desktop launch remains unchanged.
Package removal follows the existing package uninstall path. A leftover runtime
record grants nothing and is neither migrated nor destructively cleaned by the
client; it fails the live authority checks.

### Q5: What evidence and documentation are required?

**Decision**

Update only the existing reader surfaces:

- `linux-features/shared-app-server-socket/README.md` documents the fixed record,
  `codex-desktop --cli`, failure model, argument boundary, and Desktop-only
  authority lifecycle.
- `README.md` and `README.zh-CN.md` document enablement, invocation, feature
  removal, and the requirement that Desktop be running.

Do not add a feature row, feature README, migration guide, CSC guide, Hermes
guide, or second command reference for a feature that does not exist.

Protect the contract with narrow tests:

1. Extend the existing shared-socket feature test for atomic record publication,
   default and overridden effective sockets, private types/modes/owners,
   malformed and stale records, owner/authority/start-time/parent/command/listener
   mismatches, state changes immediately before `exec`, literal arguments after
   `--`, endpoint rejection, introspection forms, server-entry rejection, and
   exact stock exit propagation. Each case must cover a distinct failure mode.
2. Extend the launcher test for exact leading `--cli` dispatch, the disabled
   error, and unchanged normal Desktop launch. Do not assert private helper call
   structure.
3. Extend the existing Nix wrapper contract with one Wayland-enabled case that
   proves CLI mode passes only the caller's `--cli` argument vector to the
   common launcher. Extend the launcher contract to prove ordinary Desktop mode
   still receives all three derived Wayland flags and CLI mode receives none.
   Keep the existing normal invocation assertions.
4. Reuse existing package-common and final-tree tests to prove that enabled
   feature resources and launcher changes reach update-builder output and each
   package family. Reuse existing format/architecture gates rather than creating
   an attached-CLI matrix.
5. Run the repository's existing shell, Bash, Nix, smoke, and CI-local gates
   that cover touched files. Add no testing framework or package dependency.
6. At the final authorized manual gate, enable the feature, start Desktop, run a
   normal CLI command through `--cli`, exercise CSC's existing thirteen-tool
   suite, verify one app-server listener/authority, close Desktop, and prove a
   subsequent `--cli` fails closed. Hosted builds remain the evidence for
   formats and architectures unavailable locally.

Tests may source verifier functions with explicit fixture roots, but the
installed executable must hardcode the fixed discovery root and real `/proc`.
There is no production environment switch that bypasses validation.

## Non-Goals

- No second app-server authority, proxy, daemon, socket scan, or lifecycle owner.
- No caller-selected socket, remote endpoint, authentication, PID, or discovery
  record.
- No CSC or Hermes implementation; `--cli` is the generic future integration
  seam.
- No TCP transport, cross-user attachment, record migration, or destructive
  client cleanup.
- No new feature ID, dependency, package entry point, updater path, or test
  framework.

## Success Criteria

- The existing disabled feature is the only enablement and ownership boundary.
- `codex-desktop --cli [args]` works against Desktop's one verified authority in
  source, native, AppImage, and Nix outputs on amd64 and arm64.
- A caller cannot select or override the socket, remote endpoint,
  authentication, authority, or discovery source.
- Disabled, absent, stale, unsafe, mismatched, or changing state fails closed
  with the documented concise nonzero result and no cleanup side effect.
- The verifier binds the private fixed record, existing lock, socket, live owner,
  direct-child authority, expected command, and listener immediately before
  `exec`.
- Literal data after `--`, stock help/version/subcommand behavior, output,
  signals, and exit status follow the documented contract.
- Normal Desktop launch and the existing feature lifecycle remain unchanged.
- Existing docs, feature tests, launcher tests, package checks, and the final
  authorized manual gate provide all required evidence without parallel
  scaffolding.
