# Shared App-Server Socket

This optional feature connects Desktop to a Codex app-server through a
user-private Unix socket. It does not implement, inspect, filter, or translate
the app-server protocol. The feature is disabled by default and is activated
only when `shared-app-server-socket` is listed in the ignored
`linux-features/features.json` file.

From an SSH client's point of view, this behaves like an ordinary Codex SSH
app-server connection. The remote `codex app-server proxy` command still
provides the same stdio/WebSocket byte stream and the same app-server methods,
notifications, approvals, and thread authority.

## Authority modes

### Desktop-owned mode

Desktop-owned mode is the default behavior after the feature is enabled.
Desktop starts one selected Codex CLI child running `app-server --listen
unix://PATH`, owns the adjacent bridge lock and socket lifecycle, and connects
through the stock `app-server proxy --sock PATH` byte tunnel. Other local
clients can attach through that same proxy command and receive the normal
WebSocket `/rpc` byte stream. Closing Desktop stops its authority and releases
the socket and lock it owns.

The default socket is scoped by Linux app id under `XDG_RUNTIME_DIR`, which
prevents side-by-side Desktop instances from sharing an authority accidentally.
Set `CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET` to use a stable path.

Authority startup is serialized by an owner-only lock next to the socket. The
lock records the owning Linux process identity, so a later Desktop launch can
reclaim it only when that exact process no longer exists. An existing socket is
probed before recovery: connectable endpoints and live or unverifiable owners
still fail closed, while an unbound socket inode from the dead owner is removed
only if its filesystem identity is unchanged.
Legacy locks without owner metadata remain protected for 15 seconds, longer
than the authority startup timeout, before they can be reclaimed when no socket
exists.

### Attach-only mode

Attach-only mode connects Desktop to an app-server authority that is already
running and owned by another local supervisor:

```bash
export CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY=1
export CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET="/absolute/canonical/path/app-server.sock"
codex-desktop
```

The opt-in value is exactly `1`; values such as `true` do not select
attach-only mode. Attach-only mode is valid only for Desktop's local host. The
configured socket path must be absolute, its parent path must already be
canonical and contain no symlink, and the current Linux UID must be available.
The parent must be a real directory owned by that UID with no group or other
write bits. The endpoint must be a real Unix socket owned by the same UID, must
grant owner read and write, and must grant no group or other permissions. Owner
execute is irrelevant and is not rejected.

Desktop spawns only `codex app-server proxy --sock PATH` for its own connection
in attach-only mode. It never starts, stops, restarts, reclaims, unlinks,
replaces, or uninstalls the external authority, its socket, or a bridge lock.
Disconnecting or closing Desktop stops only Desktop's proxy child. The external
supervisor remains solely responsible for authority startup, recovery, and
shutdown.

Attach-only validation fails closed. An unsafe or unavailable endpoint aborts
the connection before a proxy is spawned, and Desktop does not fall back to
Desktop-owned mode or to another transport. If the external authority later
exits, Desktop does not restart it.

In both modes, keep the socket within the owning user's trust boundary. It is a
local control endpoint and must not be exposed directly over TCP or forwarded
as a network service.

## SSH setup

For Desktop-owned mode, use a stable socket path when the Desktop instance will
be reached over SSH:

```bash
export CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET="$HOME/.codex/app-server-control/app-server-control.sock"
codex-desktop
```

Then place a small `codex` wrapper earlier in the SSH user's `PATH`. Set
`real_codex` to the actual CLI executable, not to the wrapper itself:

```bash
#!/usr/bin/env bash
set -eu

real_codex="/absolute/path/to/real/codex"
desktop_socket="$HOME/.codex/app-server-control/app-server-control.sock"

if [ "$#" -eq 2 ] && [ "$1" = "app-server" ] && [ "$2" = "proxy" ]; then
    exec "$real_codex" app-server proxy --sock "$desktop_socket"
fi

exec "$real_codex" "$@"
```

The upstream SSH transport normally starts its own authority before invoking
the proxy. Configure the **remote account's login-shell environment** to skip
that bootstrap when this wrapper is used:

```bash
export CODEX_SSH_SKIP_APP_SERVER_BOOT=true
```

Put that export in the startup file read by the account's SSH login shell (for
example `~/.profile` when that is the active login profile). This is remote
account configuration; setting it only in the local Desktop launcher does not
propagate it through SSH. Use it only for an account whose wrapper is dedicated
to this Desktop-owned socket.

Make the wrapper executable and verify that non-interactive SSH resolves it:

```bash
chmod 0755 "$HOME/.local/bin/codex"
ssh host 'command -v codex'
ssh host 'printf "%s\n" "$CODEX_SSH_SKIP_APP_SERVER_BOOT"'
```

Codex SSH clients can then connect normally; no client-side protocol option or
special method allowlist is required. Only the exact two-argument proxy command
is redirected. Interactive CLI commands and all other subcommands continue to
use the real CLI normally. `CODEX_CLI_PATH` used to launch Desktop must also
point to the real CLI so Desktop cannot recursively invoke the wrapper.

Enable the feature in the ignored `linux-features/features.json` file:

```json
{
  "enabled": ["shared-app-server-socket"]
}
```

Then rebuild and launch the app. Enabling the feature without the exact
attach-only opt-in selects Desktop-owned mode.

Run focused tests with:

```bash
node --test linux-features/shared-app-server-socket/test.js
```

Set `CODEX_CLI_PATH` to include the stock authority/socket/proxy lifecycle test:

```bash
CODEX_CLI_PATH="/absolute/path/to/real/codex" node --test linux-features/shared-app-server-socket/test.js
```

The feature depends on upstream's current local transport factory, WebSocket
adapter, and `app-server proxy` command. Bundle drift causes the optional patch
to warn and skip instead of modifying an unknown surface.
