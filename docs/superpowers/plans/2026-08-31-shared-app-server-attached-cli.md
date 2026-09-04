# Shared App-Server Attached CLI Implementation Plan

**Status:** approved

**Source:** `docs/superpowers/specs/2026-08-31-shared-app-server-attached-cli-design.md`

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Track completion with the checkbox steps below.

**Goal:** Let an enabled `shared-app-server-socket` feature attach `codex-desktop --cli` to the one live Desktop-owned app-server while ordinary Desktop launches remain unchanged.

**Architecture:** The existing feature lifecycle atomically publishes one private discovery record after its locked authority is ready. One staged Bash resource verifies that record and live authority twice, then `exec`s the recorded packaged Codex client. The common launcher dispatches only a leading `--cli`; it owns the shared Wayland derivation. The two Nix wrappers only forward into that common launcher.

**Tech Stack:** Existing Node.js feature tests and patch descriptor, Bash with Linux `/proc`, native package staging, existing shell tooling, and existing GitHub fork PR checks. No dependency, service, daemon, parser, proxy, or new feature is introduced.

---

## Prerequisites

- Work only in `/home/korty/dev/codex-desktop-linux` on `feat/csc-attached-cli`, descended from `bd610e96e87bda672f384c79ce5bb87ea0d5a6ee`.
- Coordinate with the spec author before Task 0. Do not stage their work until they confirm the approved specification contains the corrected non-Nix broad-command wording.
- Preserve `.autonomous/` and `_experiments/` as untracked protected residue. Never stage, delete, or modify either directory.
- Confirm the selected official `resources/codex` has Unix-socket `--remote` capability before feature-enabled packaging. Its output, signals, and exit status remain the attached command result.
- Keep `shared-app-server-socket` disabled in committed configuration. Automated work must not install a package, restart Desktop, signal a live authority, or mutate real plugin or CSC state.
- Have Node.js, Bash, ShellCheck, Make, a local container engine for `ci-local`, native package prerequisites, and an official package available. The feature-enabled build uses a disposable `CODEX_LINUX_FEATURES_CONFIG`, never the ignored workstation configuration.
- `flake.nix` remains a minimal runtime compatibility edit only. Do not add or run Nix test/build commands, local or hosted Nix acceptance, or Nix documentation. Nix wrapper forwarding is reviewed as source only.
- **[MANUAL]** Only Task 7 may install a package, change ignored local feature configuration, start or stop Desktop, or install/exercise CSC.

## Acceptance Criteria

| ID | Measurable completion check |
| --- | --- |
| AC1 | Disabled leading `--cli` prints `codex-desktop: --cli requires the shared-app-server-socket feature`, exits `2`, and starts no Desktop work. |
| AC2 | A permitted enabled invocation verifies the Desktop authority and `exec`s the recorded packaged Codex exactly once with `--remote unix://<recorded socket>`, preserving stock exit status and signals. |
| AC3 | The five-field, newline-terminated v1 record is private, atomically replaced only after the existing authority is ready, and stale residue never grants authority. |
| AC4 | Absent/dead, unsafe/malformed/final-recheck-changed, and identity-disagreement state return their respective exact redacted status-`1` errors without mutation. |
| AC5 | Verification proves same-user private metadata, matching lock and process identities, Desktop parentage, exact authority command, and exactly one listener both before and immediately before `exec`. |
| AC6 | Every forbidden pre-delimiter endpoint or authority input returns the exact grammar status-`2` error; all arguments after `--` remain literal. |
| AC7 | Enabled help/version forms work without Desktop and receive no remote injection; all other accepted forms require live verification. |
| AC8 | Ordinary Desktop invocation and orphan handling remain unchanged; CLI mode runs none of the Desktop hooks, cache work, usage reporting, or Electron flags. |
| AC9 | Source, deb, RPM, pacman, and AppImage stage the same regular, non-symlink `attached-cli.sh` resource at mode `0755` through existing seams. Both Nix wrappers forward only to the common launcher, checked by source review rather than a Nix gate. |
| AC10 | The feature README plus English and Chinese top-level READMEs accurately state enablement, Desktop-open dependence, invocation, removal, and single-authority ownership. |
| AC11 | Focused RED-to-GREEN tests, deterministic non-Nix broad checks, non-Nix hosted AppImage/package evidence, and the explicit manual gate pass without new dependencies or test infrastructure. |
| AC12 | Publication failure is nonfatal to the running authority, removes only its own pre-rename temporary file, emits the one bounded warning, and keeps fixture roots available only to sourced tests. |

## File Structure

| Action | File and current line target | Responsibility |
| --- | --- | --- |
| Create | `linux-features/shared-app-server-socket/attached-cli.sh` | Fixed-root Bash verifier and attached `exec` launcher. |
| Modify | `linux-features/shared-app-server-socket/feature.json:9-15` | Stage `attached-cli.sh` at `.codex-linux/features/shared-app-server-socket/attached-cli.sh` with mode `0755`. |
| Modify | `linux-features/shared-app-server-socket/patch.js:36-56` | Publish the discovery record after the existing socket/lock/readiness lifecycle succeeds. |
| Modify | `linux-features/shared-app-server-socket/test.js:507-640, 1649-1725` | Add publication and public verifier contracts; replace stale SSH integration guidance with disposable attached-CLI coverage. |
| Modify | `launcher/start.sh.template:14-25, 222-250` | Add exact leading `--cli` dispatch, feature-aware help, and ordinary-path Wayland derivation. |
| Modify | `launcher/start.test.js:21-39, 160-300` | Cover dispatch, disabled behavior, help, ordinary launch, and CLI Electron-flag exclusion. |
| Modify | `flake.nix:553-561, 604-623` | Remove the two wrapper-level Wayland injections so both wrappers forward only to the common launcher. |
| Modify | `scripts/lib/package-common.test.js:173-206` | Prove the enabled feature resource and configuration reach update-builder output without changing generic staging. |
| Modify | `linux-features/shared-app-server-socket/README.md:1-143` | Replace obsolete SSH-wrapper, caller executable override, direct socket override, and proxy instructions. |
| Modify | `README.md:210-286` | Add the short enable/build/Desktop-open/invocation/removal path without another feature row. |
| Modify | `README.zh-CN.md:194-268` | Keep the same short reader path in Chinese. |

No other product path is in scope. Leave package staging implementation, updater logic, feature registration, orphan reaper, committed feature defaults, Nix tests, Nix acceptance, and Nix documentation unchanged.

## Review Milestones

- Intermediate milestones: none.
- Final: Task 6 is the sole whole-implementation review. It covers the complete implementation from the implementation base recorded in Task 0 through the then-current `HEAD`.

## Tasks

### Task 0: Close the approved workflow boundary and establish the implementation base

**Files:**
- Commit only: `docs/superpowers/brainstorming/2026-08-31-shared-app-server-attached-cli.md`
- Commit only: `docs/superpowers/specs/2026-08-31-shared-app-server-attached-cli-design.md`
- Commit only: `docs/superpowers/plans/2026-08-31-shared-app-server-attached-cli.md`

- [ ] **Step 1: Verify branch, ancestry, remotes, and allowable dirt.**

  Run:

  ```bash
  test "$(git branch --show-current)" = feat/csc-attached-cli
  git merge-base --is-ancestor bd610e96e87bda672f384c79ce5bb87ea0d5a6ee HEAD
  test "$(git remote get-url --push fork)" = https://github.com/kortylokai-web/codex-desktop-linux.git
  test "$(git remote get-url --push origin)" = https://github.com/ilysenko/codex-desktop-linux.git
  git status --short
  ```

  Expected: only the three approved workflow artifacts are tracked changes, plus `?? .autonomous/` and `?? _experiments/`. Any other tracked or untracked path is an immediate stop, not an implementation cleanup task.

- [ ] **Step 2: Commit the approved workflow artifacts before product work.**

  After the spec author confirms the final approved wording, run:

  ```bash
  git diff --check -- \
    docs/superpowers/brainstorming/2026-08-31-shared-app-server-attached-cli.md \
    docs/superpowers/specs/2026-08-31-shared-app-server-attached-cli-design.md \
    docs/superpowers/plans/2026-08-31-shared-app-server-attached-cli.md
  git add \
    docs/superpowers/brainstorming/2026-08-31-shared-app-server-attached-cli.md \
    docs/superpowers/specs/2026-08-31-shared-app-server-attached-cli-design.md \
    docs/superpowers/plans/2026-08-31-shared-app-server-attached-cli.md
  git diff --cached --check
  git commit -m "docs(shared-app-server): finalize attached CLI workflow"
  implementation_base="$(git rev-parse HEAD)"
  printf 'IMPLEMENTATION_BASE=%s\n' "$implementation_base"
  test "$(git status --porcelain=v1 | LC_ALL=C sort)" = "$(printf '?? .autonomous/\n?? _experiments/')"
  ```

  Expected: one workflow-only commit with exactly the literal three-path allowlist. Copy the emitted `IMPLEMENTATION_BASE` SHA into the implementation evidence; do not create another handoff, trace, tag, or worktree file.

### Task 1: Publish and stage the private discovery record

**Files:**
- Modify: `linux-features/shared-app-server-socket/patch.js:36-56`
- Modify: `linux-features/shared-app-server-socket/test.js:507-640, 1649-1725`
- Modify: `scripts/lib/package-common.test.js:173-206`

- [ ] **Step 1: Write the staging RED test before adding the resource.**

  Add an update-builder fixture that enables only `shared-app-server-socket`, stages its feature tree, and requires `.codex-linux/features/shared-app-server-socket/attached-cli.sh` to exist as a regular non-symlink `0755` file with the enabled configuration retained. Add the matching feature-install test. Do this before changing `feature.json` or creating `attached-cli.sh`; this cross-task staging contract deliberately remains RED until Task 2 has completed the verifier.

- [ ] **Step 2: Run the staging RED evidence.**

  Run: `node --test --test-name-pattern='attached CLI resource is staged executable|update-builder stages the attached CLI resource' linux-features/shared-app-server-socket/test.js scripts/lib/package-common.test.js`

  Expected: both contracts fail because neither the descriptor nor resource exists. This is not a generic-staging failure, and it remains the expected staging state through Task 1.

- [ ] **Step 3: Write the record-publication RED tests.**

  Add `attached CLI record publishes atomically for default and override sockets` and `attached CLI publication failure is nonfatal`. Assert the exact five-field schema/order, private `0700` bridge directory and `0600` regular record, readiness and complete four-field lock before publication, atomic replacement, preservation of a prior complete record, removal only of a publisher-owned temporary file, and exactly `WARN: attached CLI discovery record was not published` with no path.

- [ ] **Step 4: Run the publication RED evidence.**

  Run: `node --test --test-name-pattern='attached CLI (record|publication)' linux-features/shared-app-server-socket/test.js`

  Expected: publication assertions fail because the existing transport has no record publisher.

- [ ] **Step 5: Implement the smallest feature-owned publication path, without staging the not-yet-created verifier.**

  In the existing transport only, publish `${XDG_RUNTIME_DIR:-$CODEX_LINUX_APP_STATE_DIR}/$CODEX_LINUX_APP_ID/app-server-bridge/attached-cli-v1` after socket creation, four-field lock registration, and the existing readiness check. Reject unsafe field content; preserve a same-user, non-symlink `0700` bridge directory; write a complete `0600` same-directory temporary regular file; atomically rename it; and on every pre-rename error remove only that temporary file and emit the bounded warning. Do not add the `attached-cli.sh` descriptor yet and do not alter authority ownership, startup, cleanup, or orphan handling.

- [ ] **Step 6: Run the focused GREEN evidence.**

  Run:

  ```bash
  node --test --test-name-pattern='attached CLI (record|publication)' linux-features/shared-app-server-socket/test.js
  ```

  Expected: the publication contracts pass. The two staging contracts intentionally remain RED because the descriptor and completed verifier are deferred together to Task 2; generic staging implementation remains unchanged.

### Task 2: Add the fixed-root verifier through small public contracts

**Files:**
- Create: `linux-features/shared-app-server-socket/attached-cli.sh`
- Modify: `linux-features/shared-app-server-socket/feature.json:9-15`
- Test: `linux-features/shared-app-server-socket/test.js:1649-1725`
- Test: `scripts/lib/package-common.test.js:173-206`

**Required sourced interface:** The script defines `attached_cli_main <record-dir> <proc-root> [codex-args...]` and `attached_cli_snapshot <record-dir> <proc-root>`. `attached_cli_snapshot` sets the newline-free `ATTACHED_CLI_SNAPSHOT` fingerprint only on success and otherwise returns one of `ATTACHED_CLI_UNAVAILABLE=10`, `ATTACHED_CLI_UNSAFE=11`, or `ATTACHED_CLI_MISMATCH=12` without printing. `attached_cli_main` maps those three outcomes to the exact status-`1` stderr contracts, maps rejected caller grammar to status `2`, and performs the final snapshot comparison before `exec`.

**Required metadata boundary:** The only sourced-test seam is two functions defined by the script: `attached_cli_effective_uid`, which writes one decimal UID, and `attached_cli_filesystem_metadata <path>`, which writes exactly `kind<TAB>mode-octal<TAB>uid<TAB>device<TAB>inode<TAB>link-target-or-empty` with no diagnostic output. A test may replace those two functions only after sourcing the script in its child Bash process; each fixture process starts from the script defaults. The wrong-owner fixture returns a UID different from `attached_cli_effective_uid` through this boundary, while all public assertions remain status/output/non-mutation assertions. Direct execution is guarded exactly by `[[ ${BASH_SOURCE[0]} == "$0" ]]`; immediately before its call it resolves `id`, `stat`, and `readlink` once with `command -v` from the native/AppImage baseline or Nix wrapper runtime `PATH`, verifies the resolved executables, and hard-binds the two functions to those resolved programs for real effective-UID, `lstat`, and raw-link reads. It marks those bindings and the real record and `/proc` roots readonly, then calls `attached_cli_main "$(attached_cli_record_dir)" /proc "$@"`. No caller fixture replacement survives direct execution, and direct mode provides no environment or argument override for either root or metadata source. Do not use `/usr/bin` assumptions, `sudo`, a user namespace, or a production test hook.

**Required fixture layout:** Each Node case creates one private temporary root containing `runtime/<app-id>/app-server-bridge/attached-cli-v1`, the selected Unix socket and adjacent `.lock`, `proc/<owner-pid>/{stat,exe,cmdline,fd}`, `proc/<authority-pid>/{stat,exe,cmdline,fd}`, `proc/net/unix`, and `bin/fake-codex`. Source the script only in a child Bash test process, optionally replace exactly the two metadata functions above, call `attached_cli_main "$fixture_record_dir" "$fixture_proc_root" ...`, and use `fake-codex` to record `argv`, exit status, and signal handling. The final-recheck fixture makes `proc/<authority-pid>/stat` a FIFO: its writer supplies the initial contents, replaces it with changed contents, and causes the second snapshot to see the change. No production hook or bypass exists.

- [ ] **Step 1: RED/GREEN group 1 — metadata and record snapshot.**

  Add `attached CLI verifier rejects record metadata` covering record schema/order, empty/duplicate/newline fields, bridge/record/socket-parent symlinks and modes, wrong-owner record/socket/process metadata through the sourced metadata boundary, lock syntax, and absent/dead state. Run `node --test --test-name-pattern='attached CLI verifier rejects record metadata' linux-features/shared-app-server-socket/test.js` and require failure before the script exists. Implement only fixed-root metadata reads, snapshot construction, and unavailable/unsafe mapping. Rerun the same command and require pass with unchanged fixture bytes.

- [ ] **Step 2: RED/GREEN group 2 — live process, command, and listener binding.**

  Add `attached CLI verifier rejects stale authority identity` covering current-user non-zombie start times, owner executable, direct-parent authority, recorded Codex executable, zero-or-more `-c <value>` pairs followed by exact `app-server --listen unix://<socket>`, one `/proc/net/unix` listener inode, and authority-held descriptor. Run `node --test --test-name-pattern='attached CLI verifier rejects stale authority identity' linux-features/shared-app-server-socket/test.js` and require failure. Implement only this identity snapshot data and mismatch mapping, then rerun and require pass without any fixture mutation.

- [ ] **Step 3: RED/GREEN group 3 — final recheck and exact error precedence.**

  Add `attached CLI verifier rejects final snapshot change` and three representative public fixtures for `not available`, `state is unsafe`, and `authority does not match Desktop`. The FIFO fixture must make the first snapshot valid and the second differ. Run `node --test --test-name-pattern='attached CLI verifier (rejects final snapshot change|reports redacted)' linux-features/shared-app-server-socket/test.js` and require failure. Make `attached_cli_main` capture two fingerprints, reject any final difference or disappearance as unsafe, and print no path, PID, socket, record field, or caller argument. Rerun and require pass.

- [ ] **Step 4: RED/GREEN group 4 — grammar and introspection.**

  Add `attached CLI verifier rejects caller authority grammar` and `attached CLI verifier bypasses only stock introspection`. Cover every specified endpoint/authority token before `--`, literal data after `--`, and only `-h`, `--help`, `-V`, `--version`, and `help [args]` bypassing live validation with no injected remote. Run `node --test --test-name-pattern='attached CLI verifier (rejects caller authority grammar|bypasses only stock introspection)' linux-features/shared-app-server-socket/test.js` and require failure. Implement the pre-delimiter scan before bypass handling, exact grammar status `2`, and direct packaged-Codex bypass; rerun and require pass.

- [ ] **Step 5: RED/GREEN group 5 — exact `exec`, exit, and signal propagation.**

  Add `attached CLI verifier preserves stock exec and signals` with a valid fixture and fake Codex. Require exactly `fake-codex --remote unix://<recorded socket> [original arguments]`, its exit code, and a forwarded termination signal. Run `node --test --test-name-pattern='attached CLI verifier preserves stock exec and signals' linux-features/shared-app-server-socket/test.js` and require failure. Implement the final `exec` only after both snapshots match, then rerun and require pass.

- [ ] **Step 6: GREEN the deferred staged-resource contracts with the completed verifier.**

  Add the `0755` `attached-cli.sh` descriptor to `feature.json` only now, after all five verifier groups are green. Run:

  ```bash
  node --test --test-name-pattern='attached CLI resource is staged executable' linux-features/shared-app-server-socket/test.js
  node --test --test-name-pattern='update-builder stages the attached CLI resource' scripts/lib/package-common.test.js
  ```

  Expected: both formerly RED staging contracts pass because the completed regular non-symlink `0755` verifier is now declared and staged; generic staging implementation remains unchanged.

### Task 3: Dispatch common launcher calls and preserve wrapper forwarding

**Files:**
- Modify: `launcher/start.sh.template:14-25, 222-250`
- Modify: `launcher/start.test.js:21-39, 160-300`
- Modify: `flake.nix:553-561, 604-623`

- [ ] **Step 1: Write launcher RED tests.**

  Add tests for a leading `--cli` dispatching only to the staged resource with untouched remaining arguments; absent/non-executable resource returning the exact status-`2` message before fake Desktop work; feature-aware help; embedded/later `--cli` remaining ordinary; unchanged ordinary launch; and the two required Wayland variables adding all three Electron flags only to ordinary Desktop.

- [ ] **Step 2: Run launcher RED evidence.**

  Run: `node --test launcher/start.test.js`

  Expected: dispatch, disabled status, conditional help, and ordinary-path Wayland assertions fail against the existing launcher.

- [ ] **Step 3: Implement one launcher dispatch path.**

  Before help, diagnose, binary checks, hooks, cache work, and Desktop launch, recognize only `${1:-}` equal to `--cli`. If the fixed resource is not executable, print the exact disabled message to stderr and exit `2`; otherwise `shift` once and `exec` it with `"$@"`. Make `usage()` show `--cli` only when the resource is executable. Add the three Wayland Electron flags only in the ordinary path when both `NIXOS_OZONE_WL` and `WAYLAND_DISPLAY` are nonempty. Remove only the duplicated flag injection from both `flake.nix` wrappers so they invoke `start.sh` with caller arguments alone. Do not add a Nix test.

- [ ] **Step 4: Run launcher GREEN evidence.**

  Run: `node --test launcher/start.test.js`

  Expected: CLI dispatch runs no Desktop behavior; ordinary launch has the three flags only under the two-variable condition; no Nix command runs.

- [ ] **Step 5: Commit the literal implementation allowlist.**

  Run:

  ```bash
  git add \
    linux-features/shared-app-server-socket/feature.json \
    linux-features/shared-app-server-socket/patch.js \
    linux-features/shared-app-server-socket/attached-cli.sh \
    linux-features/shared-app-server-socket/test.js \
    launcher/start.sh.template \
    launcher/start.test.js \
    flake.nix \
    scripts/lib/package-common.test.js
  test "$(git diff --cached --name-only | LC_ALL=C sort)" = "$(printf '%s\n' \
    flake.nix \
    launcher/start.sh.template \
    launcher/start.test.js \
    linux-features/shared-app-server-socket/attached-cli.sh \
    linux-features/shared-app-server-socket/feature.json \
    linux-features/shared-app-server-socket/patch.js \
    linux-features/shared-app-server-socket/test.js \
    scripts/lib/package-common.test.js | LC_ALL=C sort)"
  git commit -m "feat(shared-app-server): attach cli to Desktop authority"
  ```

  Expected: one implementation commit containing exactly the eight literal product/test paths; protected residue remains untracked.

### Task 4: Document the attached-CLI contract

**Files:**
- Modify: `linux-features/shared-app-server-socket/README.md:1-143`
- Modify: `README.md:210-286`
- Modify: `README.zh-CN.md:194-268`

- [ ] **Step 1: Capture the reader RED condition.**

  Run: `rg -n 'SSH|proxy|CODEX_CLI_PATH|--sock|socket override' linux-features/shared-app-server-socket/README.md`

  Expected: obsolete feature-reader guidance is present and the top-level readers lack the short `codex-desktop --cli` path.

- [ ] **Step 2: Write the minimal matching reader guidance.**

  Replace only obsolete feature guidance with the existing feature enablement and normal native rebuild, Desktop-open requirement, `codex-desktop --cli [Codex CLI arguments]`, `--` delimiter, help/version exception, fail-closed behavior, and Desktop-only authority ownership. Remove SSH, caller executable override, direct socket override, and proxy instructions. Add the matching short enable/rebuild/Desktop-open/invocation/disable-and-rebuild path to the English and Chinese configuration sections. Do not add another feature row, command reference, CSC/Hermes guide, proxy recipe, or migration section.

- [ ] **Step 3: Run reader GREEN evidence and commit its literal allowlist.**

  Run:

  ```bash
  ! rg -n 'SSH wrapper|direct socket override|CODEX_CLI_PATH|app-server proxy' linux-features/shared-app-server-socket/README.md
  rg -n 'codex-desktop --cli|shared-app-server-socket|Desktop' \
    linux-features/shared-app-server-socket/README.md README.md README.zh-CN.md
  git diff --check -- linux-features/shared-app-server-socket/README.md README.md README.zh-CN.md
  git add linux-features/shared-app-server-socket/README.md README.md README.zh-CN.md
  test "$(git diff --cached --name-only | LC_ALL=C sort)" = "$(printf '%s\n' \
    README.md README.zh-CN.md linux-features/shared-app-server-socket/README.md | LC_ALL=C sort)"
  git commit -m "docs(shared-app-server): document attached cli"
  ```

  Expected: all three readers match the contract, whitespace is clean, and the documentation-only commit has exactly the three literal paths.

### Task 5: Run complete non-Nix automated evidence before review

**Files:** No source edits.

- [ ] **Step 1: Run focused tests and static checks.**

  Run:

  ```bash
  node --test linux-features/shared-app-server-socket/test.js
  node --test launcher/start.test.js
  node --test scripts/lib/package-common.test.js
  bash -n launcher/start.sh.template linux-features/shared-app-server-socket/attached-cli.sh
  shellcheck launcher/start.sh.template linux-features/shared-app-server-socket/attached-cli.sh
  ```

  Expected: all focused contracts and shell checks pass.

- [ ] **Step 2: Build and AppImage-stage from one deterministic feature configuration, then assert both resources.**

  Run:

  ```bash
  verification_root="$(mktemp -d)"
  trap 'rm -rf -- "$verification_root"' EXIT
  feature_config="$verification_root/features.json"
  app_dir="$verification_root/codex-app"
  printf '%s\n' '{"enabled":["shared-app-server-socket"]}' > "$feature_config"
  CODEX_LINUX_FEATURES_CONFIG="$feature_config" APP_DIR="$app_dir" make build-app
  resource="$app_dir/.codex-linux/features/shared-app-server-socket/attached-cli.sh"
  test -f "$resource" && test ! -L "$resource"
  test "$(stat -c '%a' "$resource")" = 755
  APPIMAGE_STAGE_ONLY=1 \
    APP_DIR_OVERRIDE="$app_dir" \
    APPIMAGE_APPDIR_OVERRIDE="$verification_root/appimage.AppDir" \
    DIST_DIR_OVERRIDE="$verification_root/dist" \
    make appimage
  appimage_resource="$verification_root/appimage.AppDir/opt/codex-desktop/.codex-linux/features/shared-app-server-socket/attached-cli.sh"
  test -f "$appimage_resource" && test ! -L "$appimage_resource"
  test "$(stat -c '%a' "$appimage_resource")" = 755
  ```

  Expected: the build consults only the disposable configuration and leaves the ignored local configuration untouched. The source build and the AppImage stage each carry the same regular non-symlink `0755` resource. The one exit trap removes only `verification_root` after both assertions.

- [ ] **Step 3: Run the non-Nix cross-format and upstream gates.**

  Run: `./scripts/ci-local.sh pr upstream`

  Expected: `pr` covers core, deb, RPM, and pacman; `upstream` covers the signed-package watchdog and clean app diagnosis. The command does not run the `nix` target. Do not use the aggregate local-CI target.

- [ ] **Step 4: Verify the post-gate tree before review.**

  Run:

  ```bash
  git diff --check
  test "$(git status --porcelain=v1 | LC_ALL=C sort)" = "$(printf '?? .autonomous/\n?? _experiments/')"
  ```

  Expected: no tracked drift remains after automated evidence; only protected residue remains untracked.

### Task 6: Final whole-implementation review

**Covers:** Tasks 1-5, from the implementation base recorded in Task 0 through current `HEAD`.

**Review contract:** `## Review Milestones` → Final.

- [ ] **Step 1: Review specification compliance over the complete surface.**

  Compare the complete changed-path list and diff against the source spec and acceptance criteria. Verify exact error/exit contracts, fixed-root/test-root separation, no-mutation boundary, deterministic packaging evidence, non-Nix boundary, wrapper-forwarding source edit, and literal file allowlists. Fix any deviation before continuing.

- [ ] **Step 2: Review KISS, DRY, YAGNI, and overengineering over the complete surface.**

  Reject any second lifecycle registry, wrapper, endpoint option, service, parser, dependency, compatibility shim, recovery path, duplicated staging, or CSC/Hermes behavior. Keep one existing feature, one record, one verifier, and one common launcher dispatch.

- [ ] **Step 3: Review code quality and security over the complete surface.**

  Inspect quoting and argument preservation, atomic file handling, symlink/type/mode/owner checks, `/proc` parsing, listener binding, TOCTOU recheck, error redaction, shell portability, fixture isolation, and reader accuracy. Resolve every Critical or Important issue and every valid Minor issue.

- [ ] **Step 4: Rerun evidence after every review-driven code change.**

  Rerun the affected focused tests and static checks, then rerun all of Task 5 before restarting the ordered review at Step 1. Do not treat a prior broad-gate result as evidence after a review fix.

- [ ] **Step 5: Close the sole final milestone.**

  Expected: all three ordered review passes are clear with current focused and broad non-Nix evidence. No Nix test or acceptance gate was introduced.

### Task 7: Manual Desktop and CSC gate

**Files:** No repository source edit.

- [ ] **Step 1: Install and start the permanent desired feature configuration.**

  **[MANUAL — explicit installation and live-authority approval required]** Run `make setup-native`; retain every feature already enabled in the ignored Desktop configuration and add `shared-app-server-socket` only if it is absent. Then run `make install-native`. This is the desired persistent configuration, not a disposable selection: do not snapshot, replace, or restore the feature file. Fully exit official and Community Desktop processes, launch the newly installed `codex-desktop`, and wait for one normal Desktop task. Confirm its record and listener show one Desktop-owned authority.

- [ ] **Step 2: Prove no-tool attachment independently.**

  In one disposable repository shell, run:

  ```bash
  smoke_root="$(mktemp -d)"
  trap 'rm -rf -- "$smoke_root"' EXIT
  git -C "$smoke_root" init -q
  cd "$smoke_root"
  codex-desktop --cli exec --ephemeral --sandbox read-only --skip-git-repo-check \
    "Reply with exactly ATTACHED_CLI_READY and do not use tools."
  ```

  Expected: exit `0` and `ATTACHED_CLI_READY` in stock CLI output. This smoke test must finish before CSC is installed and is not the CSC gate.

- [ ] **Step 3: Install the exact CSC candidate, then create a fresh attached session.**

  Run:

  ```bash
  csc_root=/home/korty/dev/agentlehub/codex-session-control
  test "$(git -C "$csc_root" rev-parse HEAD)" = 3a8df2a1b0bb79db22a323b228562040787e40af
  (cd "$csc_root" && ./scripts/install-local-plugin.sh)
  csc_live_dir="$(mktemp -d)"
  trap 'rm -rf -- "$csc_live_dir"' EXIT
  git -C "$csc_live_dir" init -q
  codex-desktop --cli -C "$csc_live_dir" \
    "Use the Codex Session Control plugin. Invoke threads_list for this workspace, then report exactly CSC_ATTACHED_READY."
  ```

  Expected: the idempotent installer refreshes the pinned candidate, then the *new* attached CLI session loads the plugin and returns `CSC_ATTACHED_READY`. Existing sessions are not acceptable because Codex loads plugins only at session creation. The trap cleans only this disposable workspace; leave the installed CSC plugin and marketplace registered as the permanent desired state.

- [ ] **Step 4: Run the repository-owned CSC live catalog, all-tool, persisted-`notLoaded`, and cleanup proofs.**

  Run:

  ```bash
  csc_root=/home/korty/dev/agentlehub/codex-session-control
  test "$(git -C "$csc_root" rev-parse HEAD)" = 3a8df2a1b0bb79db22a323b228562040787e40af
  (cd "$csc_root" && ./scripts/ci/live-all-tools-proof.sh)
  (cd "$csc_root" && cargo test --locked not_loaded_message_resumes_before_starting)
  ```

  Expected: the canonical CSC runner emits `normal_status=0`, `hard_kill_status=137`, `recovery_status=0`, and `journal_state=Idle`, and its exact thirteen-tool gate starts the CSC stdio child against the Desktop authority, invokes all thirteen tools in its owned disposable workspace, archives every owned thread, and deletes its journal. The separate persisted-`notLoaded` proof requires `thread/read`, `thread/turns/list`, `thread/resume`, then `turn/start` in that order. Both commands exit `0`.

- [ ] **Step 5: Close Desktop and prove fail-closed without reverting the desired installation.**

  Fully close Desktop, then in one disposable repository shell run:

  ```bash
  negative_root="$(mktemp -d)"
  trap 'rm -rf -- "$negative_root"' EXIT
  git -C "$negative_root" init -q
  status=0
  codex-desktop --cli -C "$negative_root" \
    "Reply with exactly SHOULD_NOT_RUN" >"$negative_root/stdout" 2>"$negative_root/stderr" || status=$?
  test "$status" -eq 1
  test ! -s "$negative_root/stdout"
  test "$(<"$negative_root/stderr")" = \
    'codex-desktop: Desktop shared app server is not available'
  ```

  Expected: the command exits `1` with only the exact unavailable error and does not repair or restart an authority. The traps and canonical CSC runner have cleaned only disposable repositories, live tasks, workdirs, and journals. Leave the selected Desktop features, installed native candidate, CSC plugin, and CSC marketplace installed; do not remove or restore persistent state.

### Task 8: Guarded fork delivery and non-Nix hosted evidence

**Files:** No source edits.

- [ ] **Step 1: Reconfirm delivery safety before mutation.**

  Run:

  ```bash
  test "$(git branch --show-current)" = feat/csc-attached-cli
  git merge-base --is-ancestor bd610e96e87bda672f384c79ce5bb87ea0d5a6ee HEAD
  test "$(git remote get-url --push fork)" = https://github.com/kortylokai-web/codex-desktop-linux.git
  test "$(git status --porcelain=v1 | LC_ALL=C sort)" = "$(printf '?? .autonomous/\n?? _experiments/')"
  git diff --check
  ```

  Expected: branch, ancestry, fork target, and clean tracked tree are exact. Stop if any check fails; do not repair unrelated state at this boundary.

- [ ] **Step 2: Push normally only to the fork and bind the exact head.**

  Run:

  ```bash
  git push fork HEAD:refs/heads/feat/csc-attached-cli
  head_sha="$(git rev-parse HEAD)"
  test "$(git ls-remote fork refs/heads/feat/csc-attached-cli | awk '{print $1}')" = "$head_sha"
  ```

  Expected: one normal non-force fork push whose remote SHA equals local `HEAD`. Do not push `origin`, force-push, merge, tag, release, publish a registry artifact, or contact official upstream.

- [ ] **Step 3: Open or update the internal fork PR at that exact head.**

  Run:

  ```bash
  head_sha="$(git rev-parse HEAD)"
  pr_url="$(gh pr list --repo kortylokai-web/codex-desktop-linux \
    --head kortylokai-web:feat/csc-attached-cli --base main --state open \
    --json url,headRefOid --jq ".[] | select(.headRefOid == \"$head_sha\") | .url")"
  if [ -z "$pr_url" ]; then
    pr_url="$(gh pr create --repo kortylokai-web/codex-desktop-linux \
      --head kortylokai-web:feat/csc-attached-cli --base main \
      --title "feat(shared-app-server): attach cli to Desktop authority" \
      --body "Implements the disabled-by-default Desktop-attached CLI seam with focused non-Nix validation and a separate manual Desktop/CSC gate.")"
  fi
  test -n "$pr_url"
  ```

  Expected: one open internal PR on `kortylokai-web/codex-desktop-linux`, whose head is `head_sha`; no merge occurs.

- [ ] **Step 4: Bind only non-Nix hosted package/AppImage results to `head_sha`.**

  Run:

  ```bash
  set -euo pipefail
  head_sha="$(git rev-parse HEAD)"
  test "$(git ls-remote fork refs/heads/feat/csc-attached-cli | awk '{print $1}')" = "$head_sha"
  deadline=$((SECONDS + 10800))
  while :; do
    payload="$(gh api \
      "repos/kortylokai-web/codex-desktop-linux/commits/$head_sha/check-runs?per_page=100")"
    if jq -e --arg sha "$head_sha" '
      [ .check_runs[]
        | select(.name == "package-matrix (amd64, ubuntu-latest)" or .name == "package-matrix (arm64, ubuntu-24.04-arm)")
      ] as $runs
      | ($runs | length == 2)
        and ($runs | all(.[]; .head_sha == $sha))
        and ($runs | all(.[]; .status == "completed" and .conclusion == "success"))
    ' <<<"$payload" >/dev/null; then
      break
    fi
    if jq -e --arg sha "$head_sha" '
      [ .check_runs[]
        | select(.name == "package-matrix (amd64, ubuntu-latest)" or .name == "package-matrix (arm64, ubuntu-24.04-arm)")
      ] as $runs
      | ($runs | any(.[]; .head_sha == $sha and .status == "completed" and .conclusion != "success"))
    ' <<<"$payload" >/dev/null; then
      printf '%s\n' 'required package-matrix check failed' >&2
      exit 1
    fi
    if ((SECONDS >= deadline)); then
      printf '%s\n' 'timed out waiting for required package-matrix checks' >&2
      exit 1
    fi
    sleep 20
  done
  ```

  Expected: `.github/workflows/upstream-build-app.yml` defines the unnamed `package-matrix` job with `amd64` on `ubuntu-latest` and `arm64` on `ubuntu-24.04-arm`, which produce exactly `package-matrix (amd64, ubuntu-latest)` and `package-matrix (arm64, ubuntu-24.04-arm)`. The three-hour bounded poll exits only when exactly those two exact-head checks succeed, including their staged AppImage work; any completed non-success or timeout exits nonzero. Do not select, wait on, report, or use any Nix check as acceptance evidence.

## Verification

The required order is Task 0 workflow closure; focused RED-to-GREEN Tasks 1-4; complete non-Nix automated Task 5; the sole ordered whole-implementation review in Task 6; manual Task 7; then guarded delivery Task 8. A failed check blocks the next phase. A review-driven code change reruns its focused proof and all Task 5 gates before the review restarts at Task 6 Step 1. Manual and hosted steps never substitute for automated evidence, and Nix is never an acceptance gate.

## Commit Boundaries

1. `docs(shared-app-server): finalize attached CLI workflow` contains exactly the approved brainstorming, specification, and plan files from Task 0.
2. `feat(shared-app-server): attach cli to Desktop authority` contains exactly the eight literal paths in Task 3.
3. `docs(shared-app-server): document attached cli` contains exactly the three literal paths in Task 4.
4. Tasks 5-8 create no repository commit. A validated review correction amends only its applicable boundary, then repeats the required focused, broad, and final-review evidence.
