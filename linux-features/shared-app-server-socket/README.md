# Shared App-Server Socket

This opt-in feature lets a normal Codex CLI attach to Desktop's existing
app-server:

```bash
codex-desktop --cli [Codex CLI arguments]
```

Desktop is the only authority owner. Commands that attach use the CLI executable
selected by Desktop: packaged `resources/codex` by default, or `CODEX_CLI_PATH`
for compatibility. They use Desktop's verified local connection and never start,
select, or replace an app server.

## Enable and update

The feature is disabled by default. Use the native setup flow to add
`shared-app-server-socket` while preserving every other enabled feature, then
rebuild and install normally:

```bash
make setup-native
make install-native
```

For manual configuration, add `"shared-app-server-socket"` to the existing
`enabled` array in the ignored `linux-features/features.json` file. Do not
replace the other IDs. Native updates rebuild with the current feature
selection, so keep the ID enabled when updating.

## Use

Start and keep Desktop running, then invoke the attached CLI with
`codex-desktop --cli [Codex CLI arguments]`. The wrapper removes only the
leading `--cli`; all later arguments remain Codex CLI arguments.

`--` is a literal boundary: every argument after it is passed unchanged. Before
that boundary, callers cannot provide an endpoint, socket, authentication,
authority, or discovery override. With the feature enabled, `--cli -h`,
`--cli --help`, `--cli -V`, `--cli --version`, and `--cli help ...` run the
stock help or version path without needing Desktop. Other accepted commands
require a live, verified Desktop authority.

If the feature is disabled, `--cli` fails before Desktop launches. If Desktop
is absent or its record, socket, lock, or authority is unsafe or mismatched, the
command fails closed. It does not search for another connection or recover one.

## Disable and remove

Remove only `"shared-app-server-socket"` from the existing `enabled` array and
run `make install-native`. Keep the remaining feature IDs unchanged. The next
rebuild removes the attached-CLI resource; normal Desktop launch remains
unchanged.
