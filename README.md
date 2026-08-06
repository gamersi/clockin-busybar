# clockin busybar client

This small, unofficial client logs in through the employee web UI and fetches
`/clock/data`. It keeps the login cookies in memory, reads the login CSRF token
from either the legacy `_token` input or the current `csrf-token` meta tag, and
then refreshes the token from the authenticated dashboard HTML.

```bash
uv sync
uv run main.py configure
```

`configure` prompts once for the clockin.de email and password, then saves them
in `~/.config/clockin/config.json` (or `$XDG_CONFIG_HOME/clockin/config.json`).
The configuration directory is owner-only and the file is written with `0600`
permissions. It contains the password in plain text, so protect your local
account accordingly. Use `uv run main.py --clear-credentials` to remove it.

Alternatively, after any successful prompted or environment-based login, save
those credentials with `uv run main.py --save-credentials`. Command-line
options and environment variables still override saved values, so you can use
`CLOCKIN_EMAIL` and `CLOCKIN_PASSWORD` for temporary accounts or automation.

To inspect the full server response, pass `--json`.

The default command only shows the current status. Recording commands are
explicit:

```bash
uv run main.py clock-in --site Homeoffice
uv run main.py pause
uv run main.py clock-out
```

`--site` accepts either the site name or ID and can also be set through
`CLOCKIN_SITE`. If the account has multiple sites, clock-in requires a choice.

## BUSY Bar

Set the BUSY Bar address (USB uses the default `10.0.4.20`; Wi-Fi needs the
device IP and its API password), then start the controller:

```bash
export BUSYBAR_HOST='10.0.4.20'
export BUSYBAR_TOKEN='your-busybar-password' # omit for USB
uv run main.py busybar --site Homeoffice
```

The controller shows off-duty, working time, or the elapsed break duration and
refreshes the display every 15 seconds. Status and button feedback reuse the
same display element, so updates do not blank the screen between frames. The
clockin display is cleared when the controller starts and when it exits,
including when you stop it with Ctrl-C.
`START` button is used by default:

- Single press and release: clock in while off duty; pause while working; resume while on break.
- Double press: clock out.
- Hold for 1.2 seconds: clock out, even before you release the button.

After clocking out, the controller treats the clock-out event as off duty, so a
single press can clock in again and double press or hold does nothing.

Use `--busybar-button OK` or `--busybar-button BACK` if another physical button
is more convenient. `--site` (or `CLOCKIN_SITE`) remains required so a bar press
always records work at the intended site.

The buttons are not documented in the official docs, so if you searched for that you are welcome, I found it through the firmware code.

This relies on clockin.de's private web interface, so its endpoints or HTML may
change without notice.
