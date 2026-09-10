// Node test runner (`node --test tests/model.test.cjs`) covering: calendar
// grid/date math, timezone-safe recurrence expansion (including a real
// America/Chicago DST transition), CalDAV discovery/request framing, WebDAV
// and iCalendar parsing, the credential/setup scripts' shape, and calendar
// preference persistence.
//
// Dates are read in the host's own zone wherever that matters (eventStartKey
// for timed events, mirroring what a viewer actually sees), so TZ is pinned
// here for determinism regardless of the machine running the suite.
process.env.TZ = "America/Chicago"

const test = require("node:test")
const assert = require("node:assert/strict")
const Model = require("../Model.js")

// --------------------------------------------------------------- Grid/date --

test("monthGrid is always six full weeks", () => {
  const weeks = Model.monthGrid(2026, 2, 1, "2026-03-08")
  assert.equal(weeks.length, 6)
  assert.equal(weeks.flatMap(w => w.days).length, 42)
  const today = weeks.flatMap(w => w.days).find(d => d.key === "2026-03-08")
  assert.ok(today && today.today)
})

test("weekDays returns seven days starting on the configured week start", () => {
  const days = Model.weekDays(new Date(2026, 2, 8), 1, "2026-03-08")
  assert.equal(days.length, 7)
  assert.equal(days[0].weekday, 1)
})

test("stepMonth rolls over into the next year", () => {
  assert.deepEqual(Model.stepMonth(2026, 11, 1), { year: 2027, month: 0 })
})

test("isoWeek matches the ISO calendar for a known date", () => {
  assert.equal(Model.isoWeek(2026, 0, 1), 1)
})

test("normalizedWeekStart accepts names, indices and falls back", () => {
  assert.equal(Model.normalizedWeekStart("monday", 0), 1)
  assert.equal(Model.normalizedWeekStart(undefined, "sunday"), 0)
  assert.equal(Model.normalizedWeekStart("not a day", 3), 3)
})

// ------------------------------------------------------- Timezone conversion --

test("zonedTimeToUtcMs converts a floating (zoneless) time as-is", () => {
  assert.equal(Model.zonedTimeToUtcMs("2026-06-01T09:00:00", ""), Date.UTC(2026, 5, 1, 9, 0, 0))
})

test("zonedTimeToUtcMs resolves America/Chicago correctly on both sides of DST", () => {
  // Central Standard Time (UTC-6), before the March 8 2026 change.
  assert.equal(Model.zonedTimeToUtcMs("2026-03-02T09:00:00", "America/Chicago"), Date.UTC(2026, 2, 2, 15, 0, 0))
  // Central Daylight Time (UTC-5), after it — same 9am wall clock, different UTC instant.
  assert.equal(Model.zonedTimeToUtcMs("2026-03-09T09:00:00", "America/Chicago"), Date.UTC(2026, 2, 9, 14, 0, 0))
})

test("zonedTimeToUtcMs degrades to no shift for an unrecognized zone rather than throwing", () => {
  assert.equal(Model.zonedTimeToUtcMs("2026-06-01T09:00:00", "Not/AZone"), Date.UTC(2026, 5, 1, 9, 0, 0))
})

test("parseIso8601Duration reads the common shapes", () => {
  assert.equal(Model.parseIso8601Duration("PT1H30M"), 90 * 60 * 1000)
  assert.equal(Model.parseIso8601Duration("P1D"), 24 * 3600 * 1000)
  assert.equal(Model.parseIso8601Duration("PT45M"), 45 * 60 * 1000)
  assert.equal(Model.parseIso8601Duration("P1DT2H"), (24 + 2) * 3600 * 1000)
  assert.equal(Model.parseIso8601Duration("garbage"), 0)
})

// -------------------------------------------------------- Recurrence expansion --

test("a non-recurring event yields at most one occurrence", () => {
  const event = {
    startLocal: "2026-06-01T09:00:00", timeZone: "", durationMs: 30 * 60 * 1000,
    allDay: false, recurrenceRules: null, recurrenceOverrides: {}, title: "Solo", description: "", location: ""
  }
  const inRange = Model.expandOccurrences(event, Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 2))
  assert.equal(inRange.length, 1)
  const outOfRange = Model.expandOccurrences(event, Date.UTC(2026, 6, 1), Date.UTC(2026, 6, 2))
  assert.equal(outOfRange.length, 0)
})

test("an event overlapping only the start of the window is still included", () => {
  const event = {
    startLocal: "2025-12-31T23:00:00", timeZone: "", durationMs: 3 * 3600 * 1000,
    allDay: false, recurrenceRules: null, recurrenceOverrides: {}, title: "Spans midnight", description: "", location: ""
  }
  const occurrences = Model.expandOccurrences(event, Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2))
  assert.equal(occurrences.length, 1)
})

test("weekly recurrence with no byDay repeats on the start's own weekday", () => {
  const rule = { frequency: "weekly", interval: 1, count: 3 }
  const start = Model.parseLocalDateTime("2026-01-05T09:00:00")
  const starts = Model.candidateStarts(rule, start)
  assert.deepEqual(starts.map(s => [s.year, s.month, s.day]), [[2026, 0, 5], [2026, 0, 12], [2026, 0, 19]])
})

test("weekly recurrence expands correctly across a DST transition", () => {
  const event = {
    startLocal: "2026-03-02T09:00:00", timeZone: "America/Chicago", durationMs: 30 * 60 * 1000,
    allDay: false, recurrenceRules: [{ frequency: "weekly", interval: 1, count: 3 }],
    recurrenceOverrides: {}, title: "Standup", description: "", location: ""
  }
  const occurrences = Model.expandOccurrences(event, Date.UTC(2026, 0, 1), Date.UTC(2026, 3, 1))
  assert.equal(occurrences.length, 3)
  assert.deepEqual(occurrences.map(o => o.startMs), [
    Date.UTC(2026, 2, 2, 15, 0, 0),
    Date.UTC(2026, 2, 9, 14, 0, 0),
    Date.UTC(2026, 2, 16, 14, 0, 0)
  ])
  // The gap across the transition is one hour short of a plain 7-day step —
  // proof the expansion re-resolves the zone per occurrence rather than
  // adding a fixed offset.
  assert.equal(occurrences[1].startMs - occurrences[0].startMs, 7 * 86400000 - 3600000)
  assert.equal(occurrences[2].startMs - occurrences[1].startMs, 7 * 86400000)
})

test("weekly recurrence with byDay expands multiple days per week", () => {
  const rule = { frequency: "weekly", interval: 1, byDay: [{ day: "mo" }, { day: "we" }, { day: "fr" }], count: 6 }
  const start = Model.parseLocalDateTime("2026-01-05T09:00:00") // a Monday
  const starts = Model.candidateStarts(rule, start)
  assert.deepEqual(starts.map(s => s.day), [5, 7, 9, 12, 14, 16])
})

test("monthly recurrence with byMonthDay repeats the same date each month", () => {
  const rule = { frequency: "monthly", interval: 1, byMonthDay: [15], count: 3 }
  const start = Model.parseLocalDateTime("2026-01-15T10:00:00")
  const starts = Model.candidateStarts(rule, start)
  assert.deepEqual(starts.map(s => [s.year, s.month, s.day]), [[2026, 0, 15], [2026, 1, 15], [2026, 2, 15]])
})

test("monthly recurrence with byDay+nthOfPeriod finds the nth weekday", () => {
  const rule = { frequency: "monthly", interval: 1, byDay: [{ day: "tu", nthOfPeriod: 2 }], count: 3 }
  const start = Model.parseLocalDateTime("2026-01-01T08:00:00")
  const starts = Model.candidateStarts(rule, start)
  // 2nd Tuesday of Jan/Feb/Mar 2026.
  assert.deepEqual(starts.map(s => [s.year, s.month, s.day]), [[2026, 0, 13], [2026, 1, 10], [2026, 2, 10]])
})

test("monthly recurrence with a negative byDay nthOfPeriod counts from month end", () => {
  const rule = { frequency: "monthly", interval: 1, byDay: [{ day: "fr", nthOfPeriod: -1 }], count: 2 }
  const start = Model.parseLocalDateTime("2026-01-01T08:00:00")
  const starts = Model.candidateStarts(rule, start)
  // Last Friday of Jan 2026 is the 30th; of Feb 2026 is the 27th.
  assert.deepEqual(starts.map(s => [s.year, s.month, s.day]), [[2026, 0, 30], [2026, 1, 27]])
})

test("yearly recurrence with byMonth/byMonthDay", () => {
  const rule = { frequency: "yearly", interval: 1, byMonth: ["7"], byMonthDay: [4], count: 3 }
  const start = Model.parseLocalDateTime("2026-01-01T08:00:00")
  const starts = Model.candidateStarts(rule, start)
  assert.deepEqual(starts.map(s => [s.year, s.month, s.day]), [[2026, 6, 4], [2027, 6, 4], [2028, 6, 4]])
})

test("daily recurrence honors interval and until", () => {
  const rule = { frequency: "daily", interval: 2, until: "2026-01-10T00:00:00" }
  const start = Model.parseLocalDateTime("2026-01-01T08:00:00")
  const starts = Model.candidateStarts(rule, start)
  assert.deepEqual(starts.map(s => s.day), [1, 3, 5, 7, 9])
})

test("recurrenceOverrides excludes, moves and retitles instances", () => {
  const event = {
    startLocal: "2026-01-05T09:00:00", timeZone: "", durationMs: 60 * 60 * 1000,
    allDay: false, recurrenceRules: [{ frequency: "weekly", interval: 1, count: 4 }],
    recurrenceOverrides: {
      "2026-01-12T09:00:00": { excluded: true },
      "2026-01-19T09:00:00": { start: "2026-01-19T14:00:00", title: "Moved meeting" }
    },
    title: "Standup", description: "", location: ""
  }
  const occurrences = Model.expandOccurrences(event, Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1))
  assert.equal(occurrences.length, 3)
  assert.equal(occurrences[0].startMs, Date.UTC(2026, 0, 5, 9, 0, 0))
  assert.equal(occurrences[0].title, "Standup")
  assert.equal(occurrences[1].startMs, Date.UTC(2026, 0, 19, 14, 0, 0))
  assert.equal(occurrences[1].title, "Moved meeting")
  assert.equal(occurrences[1].moved, true)
  assert.equal(occurrences[2].startMs, Date.UTC(2026, 0, 26, 9, 0, 0))
})

test("recurrence expansion is bounded regardless of how open-ended the rule is", () => {
  const event = {
    startLocal: "2000-01-01T00:00:00", timeZone: "", durationMs: 0,
    allDay: false, recurrenceRules: [{ frequency: "daily", interval: 1 }],
    recurrenceOverrides: {}, title: "Forever", description: "", location: ""
  }
  const occurrences = Model.expandOccurrences(event, Date.UTC(2000, 0, 1), Date.UTC(2100, 0, 1))
  assert.ok(occurrences.length <= Model.maxOccurrencesPerEvent)
})

// ---------------------------------------------------------------- All-day --

test("eventStartKey reads an all-day event's date without any zone shift", () => {
  const event = { allDay: true, startMs: Date.UTC(2026, 5, 15) }
  assert.equal(Model.eventStartKey(event), "2026-06-15")
})

test("eventStartKey reads a timed event's date in the viewer's own zone", () => {
  // 9am America/Chicago on June 15 2026 (CDT, UTC-5) is 14:00 UTC — with TZ
  // pinned to America/Chicago for this suite, the local calendar day is the
  // 15th either way.
  const event = { allDay: false, startMs: Date.UTC(2026, 5, 15, 14, 0, 0) }
  assert.equal(Model.eventStartKey(event), "2026-06-15")
})

// ----------------------------------------------------------------- Labels --

test("eventTimeLabel and eventTimeRangeLabel format in the viewer's zone", () => {
  const event = { allDay: false, startMs: Date.UTC(2026, 5, 15, 14, 0, 0), endMs: Date.UTC(2026, 5, 15, 15, 30, 0) }
  assert.equal(Model.eventTimeLabel(event), "9am")
  assert.equal(Model.eventTimeRangeLabel(event), "9am – 10:30am")
  assert.equal(Model.eventTimeRangeLabel({ allDay: true }), "All day")
})

test("nextEventLabel picks the soonest upcoming event", () => {
  const now = Date.UTC(2026, 5, 15, 13, 0, 0)
  const events = [
    { title: "Later", startMs: Date.UTC(2026, 5, 15, 18, 0, 0) },
    { title: "Soon", startMs: Date.UTC(2026, 5, 15, 14, 0, 0) },
    { title: "Past", startMs: Date.UTC(2026, 5, 15, 8, 0, 0) }
  ]
  assert.match(Model.nextEventLabel(events, now), /Soon$/)
})

// --------------------------------------------------------- Text sanitization --

test("cleanText strips control and invisible characters and collapses whitespace", () => {
  assert.equal(Model.cleanText("Hello​  World‮", 100), "Hello World")
})

test("boundedString truncates without splitting a surrogate pair", () => {
  const text = "a" + "\u{1F600}" // 'a' + an astral emoji (surrogate pair)
  assert.equal(Model.boundedString(text, 1), "a")
})

// ----------------------------------------------------------------- Credentials --

test("validServerUrl accepts https origins and paths, rejects everything else", () => {
  assert.equal(Model.validServerUrl("https://caldav.fastmail.com/"), "https://caldav.fastmail.com")
  assert.equal(Model.validServerUrl("https://nc.example.org:8443/remote.php/dav/"), "https://nc.example.org:8443/remote.php/dav")
  assert.equal(Model.validServerUrl("http://caldav.fastmail.com"), "")
  assert.equal(Model.validServerUrl("https://host/path with space"), "")
  assert.equal(Model.validServerUrl("https://host/'; rm -rf"), "")
  assert.equal(Model.validServerUrl(""), "")
})

test("discoveryStartUrl bootstraps from /.well-known/caldav only for a bare origin", () => {
  assert.equal(Model.discoveryStartUrl("https://caldav.fastmail.com"), "https://caldav.fastmail.com/.well-known/caldav")
  assert.equal(Model.discoveryStartUrl("https://caldav.fastmail.com/"), "https://caldav.fastmail.com/.well-known/caldav")
  assert.equal(Model.discoveryStartUrl("https://nc.example.org/remote.php/dav"), "https://nc.example.org/remote.php/dav")
})

test("resolveHref keeps same-origin paths and refuses anything else", () => {
  const origin = "https://caldav.fastmail.com"
  assert.equal(Model.resolveHref("/dav/calendars/user/a%40b.c/", origin), "/dav/calendars/user/a%40b.c/")
  assert.equal(Model.resolveHref("https://caldav.fastmail.com/dav/x/", origin), "/dav/x/")
  assert.equal(Model.resolveHref("https://evil.example/dav/x/", origin), "")
  assert.equal(Model.resolveHref("dav/relative", origin), "")
  assert.equal(Model.resolveHref("/dav/with space", origin), "")
  assert.equal(Model.resolveHref("/dav/$(id)", origin), "/dav/$(id)") // argv, never a shell string — harmless
})

test("parseAccountInfo reads only the server and username attributes", () => {
  const info = Model.parseAccountInfo("attribute.account = caldav\nattribute.service = x\nattribute.server = https://caldav.fastmail.com\nattribute.username = tim@example.com\n")
  assert.deepEqual(info, { server: "https://caldav.fastmail.com", username: "tim@example.com" })
  assert.deepEqual(Model.parseAccountInfo(""), { server: "", username: "" })
  assert.deepEqual(Model.parseAccountInfo("attribute.server = http://plain\n"), { server: "", username: "" })
})

test("secretLookupCommand and secretClearCommand are fixed argv with no secret value", () => {
  const expected = { lookup: Model.secretLookupCommand(), clear: Model.secretClearCommand() }
  for (const [verb, command] of Object.entries(expected)) {
    assert.deepEqual(command.slice(-6),
      ["secret-tool", verb, "service", Model.secretService, "account", Model.secretAccount])
    const tail = command.slice(command.indexOf("secret-tool"))
    assert.ok(tail.every(part => !/[$<>{}]/.test(part)), "no placeholder or interpolation in " + verb)
  }
})

test("the account-info command only lets attribute lines through", () => {
  assert.match(Model.accountInfoShell, /secret-tool search/)
  assert.match(Model.accountInfoShell, /grep '\^attribute\\\.'/)
})

test("the CalDAV request scripts take the password from the keyring, never from argv", () => {
  const command = Model.caldavRequestCommand("PROPFIND", "0", "https://caldav.fastmail.com/.well-known/caldav", "<x/>")
  assert.deepEqual(command.slice(-4), ["PROPFIND", "0", "https://caldav.fastmail.com/.well-known/caldav", "<x/>"])
  for (const script of [Model.caldavRequestShell, Model.caldavWindowShell]) {
    assert.match(script, /secret-tool lookup/)
    assert.match(script, /curl -sS --max-time 25 --proto =https --max-redirs 0 -K -/)
    assert.doesNotMatch(script, /-u\s/)
    assert.doesNotMatch(script, /--user\s/)
    assert.match(script, /unset password/)
  }
  const window = Model.caldavWindowCommand("https://caldav.fastmail.com", ["/dav/a/", "/dav/b/"], Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1))
  assert.deepEqual(window.slice(-2), ["/dav/a/", "/dav/b/"])
  assert.match(window[window.length - 3], /<C:time-range start="20260301T000000Z" end="20260401T000000Z"\/>/)
})

test("the setup script hides the password, checks the server first, and stores via stdin", () => {
  const script = Model.setupCredentialsScript
  assert.match(script, /stty -echo/)
  // Queued terminal query replies must be drained before the first read and
  // any escape residue stripped, or they answer the server prompt.
  assert.ok(script.indexOf("read -rsn 1 -t 0.2 _") < script.indexOf("read -r server"))
  assert.match(script, /strip_term\(\) \{ sed -E/)
  assert.match(script, /"\$server" \| strip_term/)
  assert.match(script, /"\$username" \| strip_term/)
  assert.match(script, /curl -sS --max-time 20 --proto =https --max-redirs 0 -K -/)
  assert.match(script, /secret-tool clear service/)
  assert.match(script, /printf '%s' "\$password" \| secret-tool store/)
  assert.match(script, /server "\$server" username "\$username"/)
  assert.doesNotMatch(script, /echo\s+"?\$password/)
  assert.ok(script.indexOf("Checking the server") < script.indexOf("secret-tool store"))
  assert.match(script, new RegExp("\\[" + Model.defaultServerUrl.replace(/[.\/]/g, "\\$&") + "\\]"))
})

test("scripts that reach a floating terminal contain no ${...} expansions", () => {
  // uwsm-app launches the terminal via a transient unit runner that expands
  // ${NAME} forms as environment variables before bash runs the text.
  for (const script of [Model.setupLaunchCommand("ninepointlabs.fastmail-calendar"), Model.setupCredentialsScript]) {
    assert.deepEqual(script.match(/\$\{[^}]*\}/g), null)
  }
})

test("setupLaunchCommand wraps the credentials script in the lock/trap/completion structure", () => {
  const command = Model.setupLaunchCommand("ninepointlabs.fastmail-calendar")
  assert.match(command, /flock -n 9/)
  assert.match(command, /omarchy-shell -q "\$target" setupFinished/)
  assert.match(command, /trap 'rc=\$\?; trap - EXIT; flock -u 9;/)
  assert.ok(command.indexOf(Model.setupCredentialsScript) > 0)
})

test("setupPlan distinguishes never-connected from rejected credentials", () => {
  assert.equal(Model.setupPlan(false, false).needed, true)
  assert.match(Model.setupPlan(false, false).buttonLabel, /^Connect/)
  assert.match(Model.setupPlan(true, false).buttonLabel, /^Reconnect/)
  assert.equal(Model.setupPlan(true, true).needed, false)
})

test("isAuthError/isNoCredentialsError/isMissingToolError classify the script's own error envelopes", () => {
  assert.equal(Model.isAuthError("auth"), true)
  assert.equal(Model.isAuthError("no_credentials"), true)
  assert.equal(Model.isAuthError("network"), false)
  assert.equal(Model.isNoCredentialsError("no_credentials"), true)
  assert.equal(Model.isNoCredentialsError("auth"), false)
  assert.equal(Model.isMissingToolError("missing_tool"), true)
  const failure = Model.parseFailure("", '{"ok":false,"error":"No calendar credentials stored","code":"no_credentials"}')
  assert.equal(failure.ok, false)
  assert.equal(failure.code, "no_credentials")
})

// ------------------------------------------------------------ HTTP framing --

test("parseHttpResponse splits curl's body from its status trailer", () => {
  const response = Model.parseHttpResponse("<x/>\n--fmcal-http-- 301 https://caldav.fastmail.com/dav/calendars\n")
  assert.deepEqual([response.ok, response.status, response.redirect, response.body], [true, 301, "https://caldav.fastmail.com/dav/calendars", "<x/>"])
  assert.equal(Model.parseHttpResponse("no trailer at all").ok, false)
  assert.equal(Model.isRedirectStatus(302), true)
  assert.equal(Model.isRedirectStatus(207), false)
  assert.equal(Model.httpFailure(401).code, "auth")
  assert.equal(Model.httpFailure(404).code, "not_found")
})

test("parseWindowResponses frames one response per calendar href", () => {
  const raw = "\n--fmcal-begin-- /dav/a/\n<a/>\n--fmcal-http-- 207 \n\n--fmcal-begin-- /dav/b/\n<b/>\n--fmcal-http-- 404 \n"
  const split = Model.parseWindowResponses(raw)
  assert.equal(split.ok, true)
  assert.deepEqual(split.responses.map(r => [r.href, r.status, r.body]), [["/dav/a/", 207, "<a/>"], ["/dav/b/", 404, "<b/>"]])
})

// ---------------------------------------------------------------- XML/DAV --

test("parseXml strips prefixes, decodes entities, keeps attributes and CDATA, ignores comments", () => {
  const doc = Model.parseXml('<?xml version="1.0"?><!-- c --><d:a xmlns:d="DAV:"><d:b n="x&amp;y">1 &lt; 2</d:b><c><![CDATA[<raw>]]></c><e/></d:a>')
  const a = Model.xmlFind(doc, "a")
  assert.equal(Model.xmlText(Model.xmlFind(a, "b")), "1 < 2")
  assert.equal(Model.xmlFind(a, "b").attrs.n, "x&y")
  assert.equal(Model.xmlText(Model.xmlFind(a, "c")), "<raw>")
  assert.equal(Model.xmlChildren(a, "e").length, 1)
  assert.equal(Model.parseXml("<broken").children.length, 0)
})

test("parseDiscovery reads the principal and the calendar home as same-origin paths", () => {
  const origin = "https://caldav.fastmail.com"
  const viaPrincipal = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/calendars</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/dav/principals/user/tim%40example.com/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
  assert.deepEqual(Model.parseDiscovery(viaPrincipal, origin), { ok: true, error: "", homeHref: "", principalHref: "/dav/principals/user/tim%40example.com/" })
  const viaHome = '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/p/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>https://caldav.fastmail.com/dav/calendars/user/tim%40example.com/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>'
  assert.equal(Model.parseDiscovery(viaHome, origin).homeHref, "/dav/calendars/user/tim%40example.com/")
  const foreign = viaHome.replace("https://caldav.fastmail.com/dav", "https://evil.example/dav")
  assert.equal(Model.parseDiscovery(foreign, origin).homeHref, "")
  assert.equal(Model.parseDiscovery("<html>login</html>", origin).ok, false)
})

test("parseCalendarList keeps event calendars, skips the home, task lists, schedule boxes and other origins", () => {
  const list = '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">'
    + '<D:response><D:href>/dav/calendars/user/tim%40example.com/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    + '<D:response><D:href>/dav/calendars/user/tim%40example.com/work/</D:href><D:propstat><D:prop><D:displayname>Work &amp; Life</D:displayname><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><A:calendar-color>#FF5733FF</A:calendar-color><A:calendar-order>2</A:calendar-order><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    + '<D:response><D:href>/dav/calendars/user/tim%40example.com/family/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><A:calendar-order>1</A:calendar-order></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat><D:propstat><D:prop><D:displayname/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>'
    + '<D:response><D:href>/dav/calendars/user/tim%40example.com/tasks/</D:href><D:propstat><D:prop><D:displayname>Tasks</D:displayname><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    + '<D:response><D:href>/dav/calendars/user/tim%40example.com/inbox/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:schedule-inbox/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    + '<D:response><D:href>https://evil.example/x/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    + '</D:multistatus>'
  const parsed = Model.parseCalendarList(list, "https://caldav.fastmail.com")
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.calendars.map(c => [c.id, c.name, c.color, c.sortOrder]), [
    ["/dav/calendars/user/tim%40example.com/family/", "family", "", 1],
    ["/dav/calendars/user/tim%40example.com/work/", "Work & Life", "#FF5733", 2]
  ])
})

// ------------------------------------------------------------- iCalendar --

test("parseIcsLine handles parameters, quoted parameter values and escapes", () => {
  const line = Model.parseIcsLine('DTSTART;TZID="America/Chicago";VALUE=DATE-TIME:20260302T090000')
  assert.deepEqual([line.name, line.params.TZID, line.params.VALUE, line.value], ["DTSTART", ["America/Chicago"], ["DATE-TIME"], "20260302T090000"])
  assert.equal(Model.parseIcsLine("BROKEN LINE"), null)
  assert.equal(Model.icsUnescape("a\\, b\\; c\\nd\\\\e"), "a, b; c\nd\\e")
  assert.equal(Model.unfoldIcs("SUMMARY:long\r\n  line\r\nX:1"), "SUMMARY:long line\nX:1")
})

test("icsDateValue reads DATE, floating, TZID and UTC forms", () => {
  assert.deepEqual(Model.icsDateValue({ value: "20260310", params: { VALUE: ["DATE"] } }, ""), { allDay: true, local: "2026-03-10T00:00:00", tz: "" })
  assert.deepEqual(Model.icsDateValue({ value: "20260310T090000", params: {} }, ""), { allDay: false, local: "2026-03-10T09:00:00", tz: "" })
  assert.deepEqual(Model.icsDateValue({ value: "20260310T090000", params: { TZID: ["America/Chicago"] } }, ""), { allDay: false, local: "2026-03-10T09:00:00", tz: "America/Chicago" })
  assert.deepEqual(Model.icsDateValue({ value: "20260310T140000Z", params: {} }, ""), { allDay: false, local: "2026-03-10T14:00:00", tz: "UTC" })
  assert.equal(Model.icsDateValue({ value: "garbage", params: {} }, ""), null)
})

test("normalizeTzid trusts Intl, unwraps namespaced ids, and floats the rest", () => {
  assert.equal(Model.normalizeTzid("America/Chicago"), "America/Chicago")
  assert.equal(Model.normalizeTzid("/freeassociation.sourceforge.net/Tzfile/America/Chicago"), "America/Chicago")
  assert.equal(Model.normalizeTzid("Z"), "UTC")
  assert.equal(Model.normalizeTzid("Central Standard Time"), "")
})

test("parseRrule maps RRULE onto the recurrence engine's rule shape, with UNTIL in the event's zone", () => {
  const rule = Model.parseRrule("FREQ=MONTHLY;INTERVAL=2;BYDAY=2TU,-1FR;UNTIL=20261231T235959Z;WKST=MO", "America/Chicago")
  assert.deepEqual(rule, { frequency: "monthly", interval: 2, byDay: [{ day: "tu", nthOfPeriod: 2 }, { day: "fr", nthOfPeriod: -1 }], until: "2026-12-31T17:59:59" })
  assert.deepEqual(Model.parseRrule("FREQ=YEARLY;BYMONTH=7;BYMONTHDAY=4;COUNT=3", ""), { frequency: "yearly", byMonth: [7], byMonthDay: [4], count: 3 })
  assert.deepEqual(Model.parseRrule("FREQ=DAILY;UNTIL=20260320", ""), { frequency: "daily", until: "2026-03-20T23:59:59" })
  assert.equal(Model.parseRrule("INTERVAL=2", ""), null)
})

const sampleIcs = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fastmail//",
  "BEGIN:VTIMEZONE", "TZID:America/Chicago", "END:VTIMEZONE",
  "BEGIN:VEVENT", "UID:abc-123",
  "DTSTART;TZID=America/Chicago:20260302T090000", "DTEND;TZID=America/Chicago:20260302T093000",
  "RRULE:FREQ=WEEKLY;COUNT=4", "EXDATE;TZID=America/Chicago:20260316T090000",
  "SUMMARY:Standup\\, weekly", "DESCRIPTION:Line one\\nLine two", "LOCATION:Room A", "END:VEVENT",
  "BEGIN:VEVENT", "UID:abc-123", "RECURRENCE-ID;TZID=America/Chicago:20260309T090000",
  "DTSTART;TZID=America/Chicago:20260309T100000", "DTEND;TZID=America/Chicago:20260309T110000",
  "SUMMARY:Standup (moved)", "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")

test("normalizeIcsObject folds EXDATE and RECURRENCE-ID instances into recurrenceOverrides", () => {
  const vevents = Model.icsComponents(Model.parseIcs(sampleIcs), "VEVENT")
  assert.equal(vevents.length, 2)
  const [event] = Model.normalizeIcsObject(vevents, "/dav/work/1.ics", "/dav/work/")
  assert.equal(event.title, "Standup, weekly")
  assert.equal(event.description, "Line one Line two") // cleanText collapses whitespace, newlines included
  assert.equal(event.timeZone, "America/Chicago")
  assert.equal(event.durationMs, 30 * 60 * 1000)
  assert.deepEqual(event.recurrenceRules, [{ frequency: "weekly", count: 4 }])
  assert.deepEqual(event.recurrenceOverrides["2026-03-16T09:00:00"], { excluded: true })
  const moved = event.recurrenceOverrides["2026-03-09T09:00:00"]
  assert.equal(moved.start, "2026-03-09T10:00:00")
  assert.equal(moved.title, "Standup (moved)")
  assert.equal(moved.durationMs, 60 * 60 * 1000)
})

test("an object holding only detached instances yields each as a standalone event", () => {
  const ics = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:solo\nRECURRENCE-ID:20260305T100000Z\nDTSTART:20260305T100000Z\nDTEND:20260305T103000Z\nSUMMARY:One instance\nEND:VEVENT\nEND:VCALENDAR"
  const events = Model.normalizeIcsObject(Model.icsComponents(Model.parseIcs(ics), "VEVENT"), "/dav/x/1.ics", "/dav/x/")
  assert.equal(events.length, 1)
  assert.equal(events[0].startLocal, "2026-03-05T10:00:00")
  assert.equal(events[0].timeZone, "UTC")
  assert.equal(events[0].recurrenceRules, null)
})

test("parseCalendarWindow expands recurring events across DST, honors overrides, attaches calendar info, and skips cancelled ones", () => {
  const escape = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  const allDay = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:day1\r\nDTSTART;VALUE=DATE:20260310\r\nDTEND;VALUE=DATE:20260312\r\nSUMMARY:Trip\r\nEND:VEVENT\r\nEND:VCALENDAR"
  const cancelled = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:gone\r\nDTSTART:20260311T100000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Nope\r\nEND:VEVENT\r\nEND:VCALENDAR"
  const body = '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    + '<D:response><D:href>/dav/work/1.ics</D:href><D:propstat><D:prop><C:calendar-data>' + escape(sampleIcs) + '</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    + '<D:response><D:href>/dav/work/2.ics</D:href><D:propstat><D:prop><C:calendar-data><![CDATA[' + allDay + ']]></C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    + '<D:response><D:href>/dav/work/3.ics</D:href><D:propstat><D:prop><C:calendar-data>' + escape(cancelled) + '</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    + '</D:multistatus>'
  const raw = "\n--fmcal-begin-- /dav/work/\n" + body + "\n--fmcal-http-- 207 \n\n--fmcal-begin-- /dav/missing/\n<html/>\n--fmcal-http-- 404 \n"
  const calendars = { "/dav/work/": { id: "/dav/work/", name: "Work", color: "#112233" } }
  const parsed = Model.parseCalendarWindow(raw, Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1), calendars)
  assert.equal(parsed.ok, true)
  assert.match(parsed.error, /missing: HTTP 404/)
  assert.deepEqual(parsed.events.map(e => [e.startMs, (e.endMs - e.startMs) / 60000, e.title, e.allDay, e.moved, e.calendarName, e.calendarColor]), [
    [Date.UTC(2026, 2, 2, 15), 30, "Standup, weekly", false, false, "Work", "#112233"],
    [Date.UTC(2026, 2, 9, 15), 60, "Standup (moved)", false, true, "Work", "#112233"],
    [Date.UTC(2026, 2, 10), 2880, "Trip", true, false, "Work", "#112233"],
    [Date.UTC(2026, 2, 23, 14), 30, "Standup, weekly", false, false, "Work", "#112233"]
  ])
})

test("a rejected credential on any calendar fails the whole window as an auth error", () => {
  const raw = "\n--fmcal-begin-- /dav/a/\n<x/>\n--fmcal-http-- 207 \n\n--fmcal-begin-- /dav/b/\n\n--fmcal-http-- 401 \n"
  const parsed = Model.parseCalendarWindow(raw, 0, 1, {})
  assert.equal(parsed.ok, false)
  assert.equal(parsed.code, "auth")
})

test("an RRULE the engine cannot expand still shows the event's own start", () => {
  const event = {
    startLocal: "2026-03-05T10:00:00", timeZone: "", durationMs: 3600000, allDay: false,
    recurrenceRules: [{ frequency: "hourly", count: 5 }], recurrenceOverrides: {}, title: "Hourly", description: "", location: ""
  }
  const occurrences = Model.expandOccurrences(event, Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1))
  assert.equal(occurrences.length, 1)
})

test("request bodies are well-formed and ask for exactly what the parsers read", () => {
  assert.match(Model.propfindDiscoveryBody(), /<D:current-user-principal\/><C:calendar-home-set\/>/)
  assert.match(Model.propfindCalendarsBody(), /<D:displayname\/><D:resourcetype\/><C:supported-calendar-component-set\/>/)
  assert.match(Model.propfindCalendarsBody(), /<A:calendar-color\/>/)
  assert.equal(Model.utcStamp(Date.UTC(2026, 2, 8, 7, 5, 9)), "20260308T070509Z")
  assert.match(Model.calendarQueryBody(0, 86400000), /<C:comp-filter name="VEVENT"><C:time-range start="19700101T000000Z" end="19700102T000000Z"\/>/)
})

// ------------------------------------------------------------- Add event --

test("normalizeTimeOfDay reads times the way people type them", () => {
  assert.deepEqual(["9", "9:30", "9.30pm", "12am", "12pm", "21:30", "0:15", "9 PM"].map(Model.normalizeTimeOfDay),
    ["09:00", "09:30", "21:30", "00:00", "12:00", "21:30", "00:15", "21:00"])
  assert.deepEqual(["24", "9:60", "noon", "13pm", ""].map(Model.normalizeTimeOfDay), ["", "", "", "", ""])
})

test("icsEscapeText and icsFoldLine follow RFC 5545", () => {
  assert.equal(Model.icsEscapeText("a;b,c\\d\nx"), "a\\;b\\,c\\\\d\\nx")
  const folded = Model.icsFoldLine("SUMMARY:" + "é".repeat(60))
  for (const line of folded.split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75)
  assert.equal(folded.split("\r\n").length, 2)
  assert.equal(folded.replace(/\r\n /g, ""), "SUMMARY:" + "é".repeat(60))
  assert.equal(Model.icsFoldLine("short"), "short")
})

test("prepareNewEvent writes a timed event as UTC instants resolved in the viewer's zone", () => {
  const event = Model.prepareNewEvent({
    title: "Dentist, downtown; bring card", dateKey: "2026-09-15", allDay: false, startTime: "9am", endTime: "10",
    location: "Tyler", description: "Line 1\nLine 2", calendarId: "/dav/calendars/user/x/work/",
    uid: "uid-1@ninepointlabs.fastmail-calendar", nowMs: Date.UTC(2026, 8, 10, 15)
  })
  assert.equal(event.ok, true, event.error)
  assert.equal(event.href, "/dav/calendars/user/x/work/uid-1@ninepointlabs.fastmail-calendar.ics")
  const lines = event.body.split("\r\n")
  assert.equal(lines[0], "BEGIN:VCALENDAR")
  assert.ok(lines.includes("DTSTART:20260915T140000Z")) // 9am CDT
  assert.ok(lines.includes("DTEND:20260915T150000Z"))
  assert.ok(lines.includes("SUMMARY:Dentist\\, downtown\\; bring card"))
  assert.ok(lines.includes("LOCATION:Tyler"))
  assert.ok(lines.includes("DESCRIPTION:Line 1\\nLine 2"))
  assert.ok(lines.includes("DTSTAMP:20260910T150000Z"))
  assert.equal(lines[lines.length - 2], "END:VCALENDAR")
  assert.equal(lines[lines.length - 1], "")
  assert.equal(event.startMs, Date.UTC(2026, 8, 15, 14))
})

test("prepareNewEvent writes an all-day event as DATE values ending the next day", () => {
  const event = Model.prepareNewEvent({ title: "Trip", dateKey: "2026-09-15", allDay: true, calendarId: "/dav/c/", uid: "u2" })
  assert.equal(event.ok, true)
  const lines = event.body.split("\r\n")
  assert.ok(lines.includes("DTSTART;VALUE=DATE:20260915"))
  assert.ok(lines.includes("DTEND;VALUE=DATE:20260916"))
  assert.ok(!lines.some(l => l.startsWith("LOCATION")))
})

test("prepareNewEvent reads an end before the start as next day, and equal as one hour", () => {
  const late = Model.prepareNewEvent({ title: "Late", dateKey: "2026-09-15", startTime: "22:00", endTime: "1:00", calendarId: "/dav/c/", uid: "u3" })
  assert.equal(late.endMs - late.startMs, 3 * 3600000)
  const same = Model.prepareNewEvent({ title: "Same", dateKey: "2026-09-15", startTime: "9", endTime: "9", calendarId: "/dav/c/", uid: "u4" })
  assert.equal(same.endMs - same.startMs, 3600000)
  const blank = Model.prepareNewEvent({ title: "Blank end", dateKey: "2026-09-15", startTime: "9", endTime: "", calendarId: "/dav/c/", uid: "u5" })
  assert.equal(blank.endMs - blank.startMs, 3600000)
})

test("prepareNewEvent refuses unusable input with a reason", () => {
  assert.match(Model.prepareNewEvent({ title: " ", dateKey: "2026-09-15", startTime: "9", calendarId: "/dav/c/" }).error, /title/)
  assert.match(Model.prepareNewEvent({ title: "x", dateKey: "2026-09-15", startTime: "25", calendarId: "/dav/c/" }).error, /Start time/)
  assert.match(Model.prepareNewEvent({ title: "x", dateKey: "2026-09-15", startTime: "9", calendarId: "not-a-path" }).error, /calendar/)
  assert.match(Model.prepareNewEvent({ title: "x", dateKey: "2026-09-15", startTime: "9", calendarId: "/dav/c/file.ics" }).error, /calendar/)
  assert.match(Model.prepareNewEvent({ title: "x", dateKey: "nope", startTime: "9", calendarId: "/dav/c/" }).error, /date/)
  assert.match(Model.generateUid(), /^[0-9a-f]+-[0-9a-f]{32}@ninepointlabs\.fastmail-calendar$/)
})

test("the PUT script refuses to overwrite and carries no secrets or ${...}", () => {
  assert.match(Model.caldavPutShell, /-X PUT -H 'Content-Type: text\/calendar; charset=utf-8' -H 'If-None-Match: \*'/)
  assert.match(Model.caldavPutShell, /secret-tool lookup/)
  assert.match(Model.caldavPutShell, /--proto =https --max-redirs 0/)
  const command = Model.caldavPutCommand("https://caldav.fastmail.com/dav/c/u.ics", "BEGIN:VCALENDAR")
  assert.deepEqual(command.slice(-2), ["https://caldav.fastmail.com/dav/c/u.ics", "BEGIN:VCALENDAR"])
})

test("parsePutResponse classifies the server's answer", () => {
  const trailer = (code) => "\n--fmcal-http-- " + code + " \n"
  assert.equal(Model.parsePutResponse(trailer(201)).ok, true)
  assert.equal(Model.parsePutResponse(trailer(204)).ok, true)
  assert.equal(Model.parsePutResponse(trailer(412)).code, "conflict")
  assert.equal(Model.parsePutResponse(trailer(403)).code, "forbidden")
  assert.equal(Model.parsePutResponse(trailer(401)).code, "auth")
  assert.equal(Model.parsePutResponse(trailer(302)).ok, false)
  assert.equal(Model.parsePutResponse("garbage").ok, false)
})

// ---------------------------------------------------------- Calendar prefs --

test("mergeCalendarPrefs defaults to visible with the server color", () => {
  const calendars = [{ id: "c1", name: "Work", color: "#61afef" }]
  const merged = Model.mergeCalendarPrefs(calendars, "")
  assert.deepEqual(merged, [{ id: "c1", name: "Work", serverName: "Work", color: "#61afef", visible: true }])
})

test("mergeCalendarPrefs applies a stored visibility/color/name override", () => {
  const calendars = [{ id: "c1", name: "Work", color: "#61afef" }]
  const stored = JSON.stringify({ c1: { visible: false, color: "#ff00ff", name: "Job" } })
  const merged = Model.mergeCalendarPrefs(calendars, stored)
  assert.deepEqual(merged[0], { id: "c1", name: "Job", serverName: "Work", color: "#ff00ff", visible: false })
})

test("mergeCalendarPrefs falls back to a stable palette color when the server has none", () => {
  const calendars = [{ id: "c1", name: "No color" }]
  const merged = Model.mergeCalendarPrefs(calendars, "")
  assert.ok(Model.calendarColorPalette.includes(merged[0].color))
  // Deterministic: the same id always gets the same fallback color.
  assert.equal(merged[0].color, Model.mergeCalendarPrefs(calendars, "")[0].color)
})

test("corrupted stored prefs fall back to defaults instead of throwing", () => {
  const calendars = [{ id: "c1", name: "Work", color: "#61afef" }]
  const merged = Model.mergeCalendarPrefs(calendars, "{not json")
  assert.equal(merged[0].visible, true)
})

test("serializeCalendarPrefs round-trips through mergeCalendarPrefs", () => {
  const calendars = [{ id: "c1", name: "Work", color: "#61afef" }]
  const prefs = { c1: { visible: false, color: "#123456", name: "Custom" } }
  const json = Model.serializeCalendarPrefs(prefs)
  const merged = Model.mergeCalendarPrefs(calendars, json)
  assert.deepEqual(merged[0], { id: "c1", name: "Custom", serverName: "Work", color: "#123456", visible: false })
})

test("visibleCalendarIds returns only the visible entries", () => {
  const prefs = [{ id: "a", visible: true }, { id: "b", visible: false }, { id: "c", visible: true }]
  assert.deepEqual(Model.visibleCalendarIds(prefs), ["a", "c"])
})
