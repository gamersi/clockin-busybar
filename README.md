# clockin BUSY Bar app

An unofficial [clockin.de](https://www.clockin.de) client that runs **on the BUSY Bar itself** as a
standalone [JavaScript app](https://docs.busy.app/bar/dev/js-apps). It needs no computer once it is
installed. The bar logs in to the clockin.de employee web UI over Wi-Fi, shows your status, and
records events when you press a button.

| Folder | What |
| --- | --- |
| [`app/`](app) | The BUSY Bar JS app (TypeScript) |
| [`archive/python/`](archive/python) | The previous Python client, which drove the bar over its HTTP API from a computer. It is kept for reference and still works, including its `status` / `clock-in` / `pause` / `clock-out` CLI. |

## Requirements

- BUSY Bar firmware 1.3.1 or later, connected to Wi-Fi
- Node.js 24 (see `app/.nvmrc`) and a USB cable, to build and install the app

## Install

```bash
cd app
npm install
npm run build && npm run app:install && npm run app:run
```

To install over Wi-Fi instead of USB, run
`npm run app:install -- --addr <bar IP> --password <HTTP API password>`.

## Configure

Open the app's settings, either on the bar under **Apps → Clockin → Setup** or in the bar's web UI
(`http://10.0.4.20` over USB). Long text such as the email and password is easier to enter in the web UI.

| Setting | Meaning |
| --- | --- |
| Email / Password | clockin.de login. The password field is marked sensitive and masked in the UI. |
| Site | Site name or ID used for clock-in, e.g. `Homeoffice`. It may stay empty only if the account has exactly one site. |
| Button | `Start` (default), `OK` (wheel press) or `Back` |
| Refresh, seconds | How often the status is fetched from clockin.de, 60 by default. The time on screen keeps counting in between, so a longer interval only delays changes made elsewhere, such as on your phone. |

Settings take effect the next time the app starts.

## Use

The display shows `OFF DUTY`, `HH:MM WORK` with today's working time, or `HH:MM BREAK` with the
length of the current break. The bar counts the minutes itself and redraws only when the shown time
changes. It syncs with clockin.de once a minute, and after every button action. The configured button
works the same as in the Python controller:

- Single press and release: clock in while off duty; pause while working; resume while on break.
- Double press: clock out.
- Hold for 1.2 seconds: clock out, even before you release the button.

After clocking out, a single press clocks in again and a double press or hold does nothing.

Press **Back** to quit the app, unless Back is the configured button. Holding Back always closes the
app; the firmware enforces this. So with `Back` as the button, a hold quits the app and does not
clock out, and only the double press clocks out.

Status messages:

| Text | Meaning |
| --- | --- |
| `SETUP` | Email or password not set |
| `LOGIN ERR` | Login failed. If clockin.de rejected the credentials, the app waits for a button press before trying again, so it cannot trigger a lockout. If clockin.de was unreachable, it retries with a back-off of up to 5 minutes. |
| `SITE ERR` | The configured site does not exist, or the account has several sites and none is set. Fix the setting and restart the app. |
| `ERROR` | A request failed. The next successful refresh replaces it. |

The device log has the details (`app.simon.clockin: ...`).

## Develop

```bash
cd app
npm run typecheck
npm test                         # node --test, no device needed
npm run build -- --no-minify     # readable code in device logs
```

- `src/clockin.ts`: clockin.de client and clock-data helpers. The bar's `fetch` keeps no cookies and does
  not follow redirects, so the client keeps its own cookie jar and follows redirects itself. It also
  reads HTML pages as a stream, so the page never has to fit into the app's 128 KiB heap.
- `src/controller.ts`: polling and press, double-press and hold detection
- `src/main.ts`: settings, display and input wiring

This relies on clockin.de's private web interface, so its endpoints or HTML may change without notice.
