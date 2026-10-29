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

The adjacent regression tests cover approval, cancellation, reentrancy, window
selection, dialog failure, fail-closed semantic matching, and idempotence.
The descriptor applies to every portable payload, regardless of build host.
Retire it when the signed stable bundle resolves the focus blocker.

The former shell environment startup deferral is retired. In both signed
`26.1027.30824` architectures, the early bootstrap awaits `app.whenReady()` on
Linux before dynamically importing the network permissions initializer. That
initializer then invokes the shell environment startup loader. This ordering
avoids spawning the shell before Chromium initializes and replaces the SIGCHLD
handler. The retirement is based on this verified signed startup source chain;
live zombie-process and chat acceptance have not been revalidated.
