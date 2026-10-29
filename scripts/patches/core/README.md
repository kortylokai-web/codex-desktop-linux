# Core patch registry

OpenAI's official Linux package is the compatibility baseline. The registry
contains only required compatibility patches for reproduced mandatory failures
in the current signed stable package.

Product extensions and measured workarounds belong in disabled-by-default
`linux-features/<id>/` directories. A new core descriptor is allowed only when
the current signed official package cannot pass a mandatory launch/work smoke
test without it. Every descriptor needs reproduction evidence and a required
regression test. Remove the patch, its tests, and this record when upstream
resolves the blocker.

## `quit-confirmation-focus`

The signed stable Linux package `26.1027.30824` still opens its synchronous Quit
confirmation without a parent window. On affected Linux desktops the modal can
appear behind the application and leave Quit blocked with no focusable prompt.
The required patch selects the focused visible window, then the visible primary
window, then another visible live window; it opens a parented asynchronous
dialog and guards duplicate `before-quit` events until the user responds.

The patch discovers the owning main-process module semantically, independently
of its Rspack chunk filename. It validates the anonymous Quit lifecycle function
and confirmation before writing. The helper and prompt state stay inside that
function, preserving its expression context and upstream lifecycle handlers.
Tests cover approval, cancellation, reentrancy, window selection, dialog failure,
fail-closed matching, idempotence, and application to both signed architectures.
The descriptor applies to every portable payload, regardless of build host.
Retire it when the signed stable bundle resolves the focus blocker.

The former shell environment startup deferral is retired. In both signed
`26.1027.30824` architectures, the early bootstrap awaits `app.whenReady()` on
Linux before dynamically importing the network permissions initializer. That
initializer then invokes the shell environment startup loader. This ordering
removes the earlier pre-Chromium shell spawn that exposed libuv's SIGCHLD
handler to replacement during browser initialization. No extra event-loop
turn is injected. This retirement is based on the verified signed startup
source chain; live zombie-process and chat acceptance were not rerun as part
of the compatibility update.
