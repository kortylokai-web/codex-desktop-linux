# Shared App-Server Attached CLI Design

**Status:** approved

**Source:** `docs/superpowers/brainstorming/2026-08-31-shared-app-server-attached-cli.md`

**Mission boundary:** `.autonomous/csc-attached-cli-internal-pr/phase-1-handoff.md`

## Objective

Extend the disabled-by-default `shared-app-server-socket` feature so
`codex-desktop --cli [Codex CLI arguments]` attaches a normal Codex CLI process
to the one live Desktop-owned app-server authority. The launcher must preserve
ordinary Desktop behavior, never create or select another authority, and leave
the attached client with stock Codex output, signals, and exit status.

The resulting seam is generic. It enables a local CSC plugin to use Desktop's
task authority, but contains no CSC or Hermes behavior.

## Prerequisites

- Work from `feat/csc-attached-cli`, descended from
  `bd610e96e87bda672f384c79ce5bb87ea0d5a6ee`, in this checkout only.
- Preserve `.autonomous/` and `_experiments/` as untracked protected residue.
- The stock packaged `resources/codex` must retain its Unix-socket `--remote`
  client capability; its own result is the attached command's result.
- `shared-app-server-socket` remains disabled in committed configuration and is
  the sole feature/authority lifecycle boundary.
- Implementation and automated tests must not install a package, restart
  Desktop, signal a live authority, or mutate a real plugin/CSC state.

## Scope

1. Publish a private, versioned discovery record only after the existing
   feature has a live, locked Desktop authority and its effective socket.
2. Stage one feature-owned Bash verifier/launcher resource and dispatch an
   exact leading `--cli` through the common launcher.
3. Verify the record and live authority twice, then `exec` the recorded stock
   Codex executable with its recorded Unix socket.
4. Move the two duplicated Nix Wayland argument injections into the ordinary
   Desktop path of the common launcher.
5. Update the existing feature and top-level English/Chinese reader surfaces,
   then add only the boundary tests needed to protect this contract.

## Non-goals

- No new feature ID, dependency, service, daemon, proxy, socket, endpoint,
  package entry point, update path, migration, or cleanup implementation.
- No caller-controlled socket, remote endpoint, authentication token,
  authority PID, discovery path, scan, recovery, or server startup.
- No TCP, cross-user attachment, record migration, destructive client cleanup,
  CSC change, Hermes integration, or change to the official payload.
- No duplicated package staging code, architecture-specific implementation, or
  attached-CLI-specific CI matrix.

## Exact File Targets

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `linux-features/shared-app-server-socket/attached-cli.sh` | Dependency-free verifier and `exec` launcher. |
| Modify | `linux-features/shared-app-server-socket/feature.json` | Stage `attached-cli.sh` under `.codex-linux/features/shared-app-server-socket/` with mode `0755`. |
| Modify | `linux-features/shared-app-server-socket/patch.js` | Publish the private record from the existing Desktop authority lifecycle. |
| Modify | `linux-features/shared-app-server-socket/test.js` | Feature record/verifier boundary tests. |
| Modify | `linux-features/shared-app-server-socket/README.md` | Replace obsolete SSH-wrapper guidance with attached-CLI use and limits. |
| Modify | `launcher/start.sh.template` | Exact `--cli` dispatch, feature-aware help, and single ordinary-launch Wayland derivation. |
| Modify | `launcher/start.test.js` | Exact dispatch, disabled behavior, normal launch, and no CLI Electron flags. |
| Modify | `flake.nix` | Remove both wrapper-level Wayland injections and prove the shared launcher owns the split. |
| Modify | `scripts/lib/package-common.test.js` | Prove the enabled feature resource and configuration reach update-builder output. |
| Modify | `README.md` | Document feature enablement, Desktop-open requirement, invocation, and removal. |
| Modify | `README.zh-CN.md` | Keep the same user-facing guidance in Chinese. |

Do not modify `scripts/lib/package-common.sh`, `orphan-reaper.js`, feature
registration, package builders, Nix modules, or updater logic: their current
generic staging and lifecycle seams already carry an enabled feature directory.

## Design

### 1. Record schema and publication lifecycle

The record path is fixed by the running application's existing runtime scope:

```text
${XDG_RUNTIME_DIR:-$CODEX_LINUX_APP_STATE_DIR}/$CODEX_LINUX_APP_ID/app-server-bridge/attached-cli-v1
```

It is independent of the effective socket path. The record is exactly five
newline-terminated fields in this order; no extra, omitted, duplicate, empty,
newline-containing, or NUL-containing field is valid:

```text
version=1
app_id=<effective application ID>
socket=<existing feature-selected effective socket path>
desktop=<running Desktop executable path>
codex=<selected packaged Codex executable path>
```

`patch.js` owns publication because it owns the existing authority startup. It
publishes only after the socket exists, the existing lock contains the complete
four-field owner/authority identity, and the authority has passed the existing
readiness check. It rejects unsafe field content, creates a same-directory
temporary regular file at mode `0600`, writes the complete record, and
atomically renames it to `attached-cli-v1`; file or directory synchronization
is not a requirement. The containing app-server-bridge directory must remain
same-user, non-symlink, and mode `0700`.

Subsequent successful authority starts replace the complete record by the same
atomic operation. The client never deletes, renames, repairs, or migrates the
record. A record left after Desktop exits is inert: live validation rejects it.

Publication is a nonfatal sidecar. On any failure before rename, the publisher
closes and removes only the temporary file it created; it leaves any prior
complete record unchanged. A rename either exposes one complete record or
leaves the prior record in place. The publisher emits at most one bounded,
path-free warning, `WARN: attached CLI discovery record was not published`, and
does not stop or alter the ready authority, socket, lock, Desktop connection,
or Desktop lifecycle. The client remains fail-closed when the record is absent,
stale, or mismatched.

### 2. Common launcher and Nix dispatch

The common launcher recognizes only an exact first argument of `--cli`.

- If the staged feature resource is absent or non-executable, print
  `codex-desktop: --cli requires the shared-app-server-socket feature` to
  stderr and exit `2` before any Desktop launch.
- If it is present, remove only that first argument and `exec` the resource
  with the original remaining argument vector. Do not run Electron hooks,
  cache refresh, usage reporting, Desktop prelaunch, or after-exit behavior.
- An embedded or later `--cli` remains an ordinary Desktop argument. Normal
  Desktop launch stays otherwise unchanged.
- Launcher `--help` documents `--cli` only when the feature resource is staged.
  Launcher `--diagnose` remains the existing Desktop diagnosis surface.

Both Nix wrappers retain their environment setup and forward only the caller's
arguments to `start.sh`; remove their conditional `NIXOS_OZONE_WL` and
`WAYLAND_DISPLAY` `--add-flags`/array injection. In the common launcher,
derive all three Wayland Electron flags only on the ordinary Desktop path when
both variables are nonempty:

```text
--ozone-platform=wayland
--enable-wayland-ime=true
--wayland-text-input-version=3
```

CLI mode receives no Electron flags. This gives source, deb, RPM, pacman,
AppImage, Nix, amd64, and arm64 one dispatch implementation.

### 3. Verifier invariants and race recheck

`attached-cli.sh` is a feature resource, uses Bash plus Linux `/proc` and the
baseline launcher utilities only, and reads no caller endpoint or executable
override. In direct execution, it resolves `id`, `stat`, and `readlink` through
`command -v` on the launcher's runtime-compatible command path and invokes only
those resolved executables; it must not hardcode `/usr/bin`. Direct execution
hard-binds those resolved executables, the one fixed app-scoped record root,
and the real `/proc` root, with no caller environment or argument override. It
then reads the record and builds an initial snapshot. It fails closed unless all
conditions hold:

1. The app-scoped directory is a same-user, non-symlink directory at mode
   `0700`; the record is a same-user, non-symlink regular file at mode `0600`.
2. The record matches the exact schema above and its application ID equals the
   launcher's effective application ID.
3. The record socket parent is private and non-symlink; the socket is a
   same-user Unix socket at mode `0600`; the adjacent lock is a same-user,
   non-symlink regular file at mode `0600`.
4. The lock has exactly `ownerPid ownerStartTime authorityPid authorityStartTime`.
   Both PIDs are current-user, non-zombie `/proc` processes whose start times
   still match the lock.
5. The owner executable equals recorded `desktop`; the authority is its direct
   child; the authority executable equals recorded `codex`; and its NUL-delimited
   command line is zero or more existing `-c <value>` pairs followed exactly by
   `app-server --listen unix://<recorded socket>`.
6. `/proc/net/unix` identifies exactly one listening inode for the socket, and
   that inode is owned by the recorded authority through its open descriptors.

Immediately before `exec`, reread and compare the record and lock identities
and contents, socket identity/type/mode/owner, process start times/parentage/
executables/command, and listener inode. Any change fails closed. The verifier
never signals a process, creates a socket, scans for an alternative endpoint,
starts Desktop, starts an app server, or repairs state.

### 4. Argument grammar, errors, and exits

Precedence is fixed. The common launcher first rejects a leading `--cli` when
the feature resource is not staged. Once dispatched, the resource scans and
rejects forbidden grammar before considering an introspection bypass. It then
validates live state for every non-introspection form. The feature resource
preserves the original argument array and scans only up to the first standalone
`--`. It passes every later argument literally. Before the delimiter it rejects
`--remote`, `--remote=*`, `--remote-auth-token-env`,
`--remote-auth-token-env=*`, `--sock`, `--sock=*`, `--listen`, `--listen=*`,
values beginning `unix://`, `ws://`, or `wss://`, and the tokens `app-server`,
`remote-control`, `mcp-server`, and `exec-server`.

Rejected grammar prints exactly
`codex-desktop: --cli does not accept caller endpoint or authority options` to
stderr and exits `2`. There is no wrapper option to select an endpoint,
authority, token, discovery record, scan, recovery, or server.

When the feature is enabled, exact `--cli -h`, `--cli --help`, `--cli -V`,
`--cli --version`, and `--cli help [args]` bypass live verification and `exec`
the existing bundled `$CODEX_LINUX_APP_DIR/resources/codex` without injecting
`--remote`.
They therefore work without a record or running Desktop. All other accepted
forms require the verified live authority and execute exactly:

```text
<recorded codex> --remote unix://<recorded socket> [original arguments]
```

The verifier uses these concise, redacted status-`1` errors:

| Condition | Message |
| --- | --- |
| Initial required state is absent or dead: record, lock, socket, owner, authority, or one listener | `codex-desktop: Desktop shared app server is not available` |
| Present metadata is unsafe or malformed: type, symlink, owner, mode, schema, lock syntax, or any final-recheck change including disappearance | `codex-desktop: Desktop shared app-server state is unsafe` |
| Present live state disagrees: identity, start time, parentage, executable, command, or listener-to-authority binding | `codex-desktop: shared app-server authority does not match Desktop` |

No failure prints a path, PID, record field, socket, or caller argument. After
successful verification, `exec` preserves stock CLI output, signal handling,
and exit status; unsupported stock subcommands keep their stock failure.

### 5. Documentation

The feature README becomes the detailed contract: enable the existing feature,
start Desktop, invoke `codex-desktop --cli`, understand the argument delimiter,
and understand that Desktop alone owns the authority. It removes the old SSH
wrapper, direct socket override, and proxy instructions from this reader
surface.

The English and Chinese top-level READMEs provide a short matching path:
enable `shared-app-server-socket`, rebuild through the normal package/feature
flow, keep Desktop running, use `codex-desktop --cli`, and disable/rebuild to
remove the feature. They do not introduce a new feature entry, migration guide,
CSC guide, Hermes guide, or second command reference.

## TDD and Verification

Write focused RED tests before production edits. Each test must protect a
distinct public or security failure mode; do not assert helper internals.

1. In the existing feature test, cover atomic publication for default and
   override-selected sockets; record schema rejection; private type/mode/owner
   checks; stale owner/authority/start-time/parent/executable/command/listener
   states; and a state change before the final recheck. Publication failure
   tests must prove authority/sockets/locks/Desktop state survive, only a
   publisher-owned pre-rename temporary file is removed, and one bounded
   warning is emitted. Verify literal data after `--`, all forbidden
   pre-delimiter forms, help/version bypass, and exact stock exit propagation.
   Add one representative exact-status, exact-redacted-stderr, nonmutating
   fixture for each `not available`, `state is unsafe`, and `authority does not
   match Desktop` category; the unsafe case includes disappearance at the final
   recheck.
2. In the launcher test, cover exact leading dispatch, disabled error, help
   visibility, and unchanged ordinary invocation. Do not test the private
   verifier implementation through launcher call counts.
3. Extend the existing update-builder test to assert the enabled feature tree
   contains the executable resource and enabled configuration; use existing
   non-Nix package/final-tree checks for the exercised output formats and
   architectures. Do not add Nix-specific test coverage.

Tests may source the verifier and invoke its public verification entry with an
explicit fixture record root and fixture `/proc` root. The installed direct mode
resolves `id`, `stat`, and `readlink` through `command -v`, then always passes
its fixed app-scoped discovery root, literal `/proc`, and resolved executables;
caller environment or arguments cannot override any of them. Assert public
status, stderr/stdout, `exec` result, and fixture state rather than private
helper call counts. Include a disposable fake-Codex signal-propagation case and
require every failing fixture to remain byte-for-byte unchanged. These are test
inputs only; no production validation bypass exists.

Run the focused Node tests and shell syntax checks, then
`./scripts/ci-local.sh pr upstream`. Do not run `./scripts/ci-local.sh all`,
any Nix command, or use a hosted Nix result as acceptance evidence. For a
feature-enabled official bundle check, use the existing non-Nix build path only;
add no attached-CLI matrix, framework, parser, or dependency.

## Manual Gate

After all automated gates pass and before delivery, make the desired permanent
installation. Preserve every currently enabled Desktop feature; add
`shared-app-server-socket` only if it is missing, without replacing the existing
feature selection. Install or refresh the exact checkout-local CSC candidate
`codex-session-control@codex-session-control-local` from the prerequisite
candidate at `3a8df2a1b0bb79db22a323b228562040787e40af` idempotently, and leave
both the plugin and its marketplace installed. Do not remove either one.

Install or refresh the Desktop package through its normal feature/package flow,
restart Desktop, run a normal command via `codex-desktop --cli`, run CSC's
existing thirteen-tool suite, and confirm one listener/authority. Close Desktop
only to confirm that a subsequent attached invocation fails closed, then restart
it. Clean only disposable test tasks and workdirs; retain the permanent feature
selection, Desktop installation, and CSC plugin/marketplace. Hosted non-Nix
package evidence remains authoritative for non-Nix formats and architectures
unavailable on the local host; hosted Nix results are not acceptance evidence.

## KISS, DRY, and YAGNI Checks

- One existing feature, one fixed record, one Bash resource, and one common
  launcher dispatch own the behavior.
- Existing feature staging, update-builder copying, package formats, and
  architecture gates remain reusable evidence; no new packaging branch exists.
- The record is discovery only. Reusing the existing lock and live `/proc`
  checks avoids a second authority registry, health service, or cleanup path.
- The wrapper deliberately delegates Codex parsing instead of classifying all
  subcommands. Its only grammar is the authority/endpoint exclusion boundary.
- No production bypass, compatibility shim, or post-hoc recovery path is
  allowed; a changed or unverifiable state fails closed.

## Acceptance Criteria

1. With the feature disabled, every leading `--cli` invocation exits `2` with
   the exact disabled-feature message and never launches Desktop.
2. With the feature enabled and Desktop live, a permitted `--cli` command
   `exec`s the recorded stock CLI with exactly one injected `--remote`
   Unix-socket target and preserves its exit status and signals.
3. The record has the exact schema, is atomically published only after the
   existing authority is live, and remains private; stale residue grants no
   authority.
4. Every absent/dead required state returns the exact `not available` status-`1`
   error; every present unsafe, malformed, or final-recheck-changed state,
   including final disappearance, returns `state is unsafe`; every live
   identity/parent/executable/command/listener disagreement returns `authority
   does not match Desktop`. All remain redacted and nonmutating.
5. In direct execution, the verifier resolves `id`, `stat`, and `readlink`
   through `command -v` rather than hardcoding `/usr/bin`, accepts no caller
   override of its resolved executables or real record/process roots, and proves
   same-user private metadata, lock/process identities, Desktop-parented
   authority, expected command, and one listener both before and immediately
   before `exec`.
6. Pre-delimiter endpoint and authority inputs fail with the exact status-`2`
   grammar error; all arguments after `--` remain literal.
7. Enabled `--cli` help/version forms work without Desktop and do not inject a
   remote endpoint; all other accepted forms require live verification.
8. Normal Desktop invocation, feature-disabled output, and existing feature
   orphan handling remain unchanged.
9. The three reader surfaces accurately document enablement, Desktop-open
   dependence, invocation, removal, and the absence of a second authority.
10. Focused RED→GREEN tests, `./scripts/ci-local.sh pr upstream`, and the
    explicit manual gate provide the required evidence without new dependencies
    or test infrastructure. `./scripts/ci-local.sh all`, Nix commands, and
    hosted Nix results are excluded from acceptance evidence.
11. Publication failure is nonfatal to the existing Desktop authority and
    removes only a publisher-owned temporary record before rename; fixture-root
    injection is available only to sourced tests, while installed behavior uses
    fixed real roots.
