# Shared App-Server Socket

This optional Linux feature lets a Desktop application attach to an existing
local app-server through a Unix socket selected by a small, owner-private
descriptor. It is disabled unless `shared-app-server-socket` is listed in the
ignored `linux-features/features.json` configuration.

## Attachment descriptor

Unless either `CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY` or
`CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET` is already present in the launch
environment, the launcher reads:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/${CODEX_LINUX_APP_ID:-codex-desktop}/app-server-attachment.json
```

The descriptor is JSON with this exact schema. Whitespace and JSON key order
do not matter.

```json
{
  "schemaVersion": 1,
  "socketPath": "/absolute/normalized/path/app-server.sock",
  "transport": "unix"
}
```

The descriptor file must be a regular `0600` file owned by the current Linux
UID. Its immediate parent must be a real directory owned by that UID and must
not be writable by group or other users. The reader opens both objects without
following their final path component and compares their metadata before and
after the read. It accepts only absolute, normalized socket paths without C0
control characters.

The reader does not check socket health. A descriptor that selects a missing,
wrong, or unreachable socket still selects strict attachment mode; the existing
attachment transport then fails closed. It never falls back to another
transport or a locally owned authority.

## Routing behavior

A valid descriptor emits exactly these launcher records:

```text
env CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY=1
env CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET=/absolute/normalized/path/app-server.sock
```

An absent descriptor emits no records, so ordinary startup continues. Any
present but invalid or unsafe descriptor emits one redaction-safe warning from
the optional hook, returns a nonzero hook status, and emits no routing records;
ordinary startup then continues unattached.

Explicit launch environment values take precedence over the descriptor. Their
presence bypasses descriptor selection entirely, preserving development and
operator-controlled routing.

After enabling or changing this feature, perform a full application restart so
the launcher hook and selected transport are recreated.

## Lifecycle boundary

This feature only selects an external Unix socket. It never starts, stops,
restarts, reclaims, unlinks, replaces, probes, or otherwise manages the
external app-server, its socket, or any lock. The external supervisor remains
the sole owner of that lifecycle.

## Enabling and validation

Enable the feature locally:

```json
{
  "enabled": ["shared-app-server-socket"]
}
```

Run the focused suite:

```bash
node --test linux-features/shared-app-server-socket/test.js
```

The main-bundle patch remains `required-upstream` whenever this optional
feature is enabled. Incomplete or unsupported upstream patch states reject the
candidate rather than producing a partially configured build.
