# Fastmail Calendar for Omarchy

A read-only native Omarchy calendar — Today, Week, Month and Year views, with
a day detail for events — backed directly by Fastmail's JMAP API. No
external CLI, no mail, no journal: this plugin only ever reads your Fastmail
calendars and shows them.

## What it does

- **Today/Week/Month/Year views**, laid out the same way as
  [omarchy-hey-calendar](https://github.com/ninepointlabs/omarchy-hey-calendar)
  (itself modeled on the native Omarchy calendar popup): a grid that never
  resizes between months, ISO week numbers, a day-detail overlay opened by
  clicking any day.
- **Every calendar on your account**, each independently shown or hidden,
  with its own color and an optional display name override — your choices
  persist by the calendar's own stable id, so they survive Fastmail
  reordering or renaming a calendar.
- **Recurring events**, expanded client-side from Fastmail's JSCalendar
  recurrence rules: daily/weekly/monthly/yearly, with `interval`, `count`,
  `until`, `byDay` (including "2nd Tuesday"-style rules) and `byMonthDay`.
  Exceptions and moved/retitled instances (`recurrenceOverrides`) are
  honored. `byYearDay`, `byWeekNo`, `bySetPosition` and sub-hourly
  frequencies are out of scope — an event using one of those still shows its
  first occurrence, just not every occurrence.
- **Correct times across zones and DST.** Fastmail's JMAP calendar events
  carry a local time plus an IANA time zone name, not a fixed offset; this
  plugin converts that pair to an absolute instant through the platform's own
  time zone database (via `Intl`), so a recurring 9am meeting reads as 9am
  both before and after a DST change, in whatever zone it was scheduled in.
  All-day events are read from their date alone, never shifted by a zone.
- **The bar chip** shows today's date, or (by default) your next event today.
  Right-click cycles the date format; middle-click refreshes.

There is no add/edit/delete for events, and no journal — this is a viewer.

## Setup

```bash
omarchy plugin add https://github.com/ninepointlabs/omarchy-fastmail-calendar.git --enable
```

Click the calendar chip in the bar. **Connect Fastmail…** opens a floating
terminal that asks for a **Fastmail API token**:

1. In Fastmail, go to **Settings → Password & Security → Integrations → API
   tokens** and create a new token with **Calendars (read-only)** access.
2. Paste it into the terminal when asked. Input is hidden as you type.
3. The terminal checks the token against Fastmail before storing anything;
   if it can't reach your calendars it says so and nothing is saved.
4. On success the token goes straight into your system keyring via
   `secret-tool` (libsecret) and the terminal closes.

The token lives under this plugin's own keyring entry
(`service=ninepointlabs.fastmail-calendar account=api-token`) — it is not
shared with, or read from, any other tool on this machine, including
Hermes's own Fastmail OAuth cache. Only one setup runs at a time; a second
click while one is in progress is refused rather than opening a second
terminal.

**Calendars** in the panel (the calendar icon, or press `C`) lists every
calendar on the account with a visibility toggle, a color swatch picker, and
an optional display-name field. **Forget Fastmail token** at the bottom
removes the stored token (`secret-tool clear`); the plugin then asks you to
connect again next time you open it.

## Keys

With the panel open:

| Key | Action |
|---|---|
| `↑` `↓` `←` `→` | Move through month/week/year |
| `Enter` | Jump to today |
| `1` `2` `3` `4` | Today / Week / Month / Year |
| `C` | Calendars |
| `R` | Refresh |
| `Esc` | Close a detail page, then the panel |
| `Tab` `Shift+Tab` | Switch to the next or previous bar panel |

## Security

This plugin never runs a mail or calendar CLI: it talks to
`https://api.fastmail.com/jmap/session` and the JMAP API endpoint it returns,
over HTTPS, through `curl` — as a bounded child process, output-size- and
time-capped, the same as every other Ninepoint Labs Omarchy plugin.

- The API token is never a command-line argument, never written to a file,
  and never logged. It travels `secret-tool lookup` → a shell variable → a
  `curl -K -` (config supplied on stdin) `Authorization` header, inside one
  short-lived process; a lookup failure or a token containing anything
  outside `A-Za-z0-9._-` refuses the request rather than risk it leaking or
  breaking the header it's interpolated into.
- The setup terminal's `read` for the token is echo-off and the token is
  never assembled into a command line, so it never reaches shell history.
- Every value Fastmail returns — titles, descriptions, locations, calendar
  names — is treated as untrusted plaintext: bounded in size, control/bidi/
  zero-width characters stripped, and always rendered as plain text, never
  HTML.
- Calendar ids from the account are only ever compared and stored, never
  interpolated into a shell string.
- `omarchy plugin remove` deletes the checkout and the plugin's saved
  settings in `shell.json`, but not the keyring entry. Use **Forget Fastmail
  token** first, or `secret-tool clear service ninepointlabs.fastmail-calendar
  account api-token`, to remove the credential itself.

For reviewers, this is everything the plugin executes:

```text
secret-tool lookup service ninepointlabs.fastmail-calendar account api-token
curl -K - https://api.fastmail.com/jmap/session                 (probe / session)
curl -K - -X POST <apiUrl>                                       (Calendar/get, CalendarEvent/query+get)
secret-tool store  service ninepointlabs.fastmail-calendar account api-token   (setup, in a floating terminal)
secret-tool clear  service ninepointlabs.fastmail-calendar account api-token   (Forget Fastmail token)
omarchy-launch-floating-terminal-with-presentation '<setup script, quoted>'
```

## Demo and tests

```bash
node --test tests/model.test.cjs
```

Pure JS: date/grid math, timezone-safe recurrence expansion, JMAP request/
response handling and calendar preference persistence. There is no
Quickshell/QML test harness in this checkout yet — the QML files follow the
same structure as `omarchy-hey-calendar`'s (itself exercised by that
project's `qmltestrunner` suite) but have not been run under a live
Quickshell shell in this environment.

## Updating and removal

```bash
omarchy plugin update ninepointlabs.fastmail-calendar --yes
omarchy plugin remove ninepointlabs.fastmail-calendar --yes
```

## Credits

Adapted from Ninepoint Labs' [omarchy-hey-calendar](https://github.com/ninepointlabs/omarchy-hey-calendar)
and [omarchy-fastmail](https://github.com/ninepointlabs/omarchy-fastmail)
(both MIT). Full attributions are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Fastmail is a trademark of Fastmail Pty Ltd. This plugin is not affiliated
with or endorsed by Fastmail.

## License

MIT. See [LICENSE](LICENSE).
