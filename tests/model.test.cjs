// Node test runner (`node --test tests/model.test.cjs`) covering: calendar
// grid/date math, timezone-safe recurrence expansion (including a real
// America/Chicago DST transition), JMAP request/response handling, the
// credential/setup scripts' shape, and calendar preference persistence.
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

test("validToken accepts the expected character class and rejects the rest", () => {
  assert.equal(Model.validToken("fmu1-abc123.def_ghi-0"), "fmu1-abc123.def_ghi-0")
  assert.equal(Model.validToken(""), "")
  assert.equal(Model.validToken("has a space"), "")
  assert.equal(Model.validToken('quote"here'), "")
  assert.equal(Model.validToken("a".repeat(600)), "")
})

test("the JMAP request script never accepts a token as an argument", () => {
  // The token only ever enters through `secret-tool lookup` inside the
  // script; the wrapping command's own trailing argv is method/url/body only.
  const command = Model.jmapRequestCommand("GET", "https://api.fastmail.com/jmap/session", "")
  assert.deepEqual(command.slice(-3), ["GET", "https://api.fastmail.com/jmap/session", ""])
  assert.match(Model.jmapRequestShell, /secret-tool lookup/)
  assert.match(Model.jmapRequestShell, /curl -sS --max-time 20 -K -/)
  assert.doesNotMatch(Model.jmapRequestShell, /-H ['"]Authorization/)
})

test("secretLookupCommand and secretClearCommand are fixed argv with no token value", () => {
  // The keyring entry is addressed by service/account only; the token value
  // itself never appears in argv, nor does any shell placeholder for it.
  const expected = {
    lookup: Model.secretLookupCommand(),
    clear: Model.secretClearCommand(),
  }
  for (const [verb, command] of Object.entries(expected)) {
    assert.deepEqual(command.slice(-6),
      ["secret-tool", verb, "service", Model.secretService, "account", Model.secretAccount])
    const tail = command.slice(command.indexOf("secret-tool"))
    assert.ok(tail.every(part => !/[$<>{}]/.test(part)), "no placeholder or interpolation in " + verb)
    assert.ok(tail.every(part => !/^fmu1-/.test(part)), "no Fastmail token value in " + verb)
  }
})

test("the setup token script hides input and never echoes the token", () => {
  assert.match(Model.setupTokenScript, /stty -echo/)
  assert.match(Model.setupTokenScript, /secret-tool store/)
  assert.doesNotMatch(Model.setupTokenScript, /echo\s+"?\$token/)
  assert.doesNotMatch(Model.setupTokenScript, /printf[^\n]*\$token[^\n]*\n.*echo/)
})

test("setupLaunchCommand wraps the token script in the lock/trap/completion structure", () => {
  const command = Model.setupLaunchCommand("ninepointlabs.fastmail-calendar")
  assert.match(command, /flock -n 9/)
  assert.match(command, /trap 'rc=\$\?/)
  assert.match(command, /setupFinished/)
  assert.match(command, new RegExp(Model.setupTokenScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("isAuthError/isNoTokenError/isMissingToolError classify the script's own error envelopes", () => {
  const noToken = Model.parseFailure("", '{"ok":false,"error":"No Fastmail API token stored","code":"no_token"}')
  assert.equal(Model.isAuthError(noToken.code), true)
  assert.equal(Model.isNoTokenError(noToken.code), true)

  const badScope = Model.parseFailure('{"apiUrl":"x"}', "")
  const session = Model.parseSession('{"apiUrl":"x"}')
  assert.equal(session.ok, false)
  assert.equal(Model.isAuthError(session.code), true)
  assert.equal(Model.isNoTokenError(session.code), false)

  const missing = Model.parseFailure("", '{"ok":false,"error":"curl is required","code":"missing_tool"}')
  assert.equal(Model.isMissingToolError(missing.code), true)
  assert.equal(Model.isAuthError(missing.code), false)
})

// ------------------------------------------------------------------- Session --

test("parseSession reads the calendars account and api url", () => {
  const raw = JSON.stringify({
    apiUrl: "https://jmap.fastmail.com/api/",
    primaryAccounts: { "urn:ietf:params:jmap:calendars": "u1234" }
  })
  const session = Model.parseSession(raw)
  assert.equal(session.ok, true)
  assert.equal(session.apiUrl, "https://jmap.fastmail.com/api/")
  assert.equal(session.accountId, "u1234")
})

test("parseSession fails cleanly when the token lacks calendar access", () => {
  const session = Model.parseSession(JSON.stringify({ apiUrl: "x", primaryAccounts: {} }))
  assert.equal(session.ok, false)
  assert.equal(session.code, "auth")
})

// ------------------------------------------------------------------ Calendars --

test("parseCalendarGet normalizes and sorts by sortOrder then name", () => {
  const raw = JSON.stringify({
    methodResponses: [["Calendar/get", { list: [
      { id: "c2", name: "Personal", sortOrder: 2, color: "#ff0000" },
      { id: "c1", name: "Work", sortOrder: 1 },
      { id: "", name: "Skipped (no id)" }
    ] }, "c0"]]
  })
  const result = Model.parseCalendarGet(raw)
  assert.equal(result.ok, true)
  assert.deepEqual(result.calendars.map(c => c.id), ["c1", "c2"])
})

test("parseCalendarEventWindow expands recurring events, attaches calendar info, and drops cancelled ones", () => {
  const raw = JSON.stringify({
    methodResponses: [
      ["CalendarEvent/query", { ids: ["e1", "e2"] }, "q0"],
      ["CalendarEvent/get", { list: [
        {
          id: "e1", uid: "e1", title: "Standup", start: "2026-01-05T09:00:00", timeZone: "",
          duration: "PT30M", calendarIds: { cal1: true }, status: "confirmed"
        },
        {
          id: "e2", title: "Cancelled thing", start: "2026-01-06T09:00:00",
          duration: "PT30M", calendarIds: { cal1: true }, status: "cancelled"
        }
      ], notFound: [] }, "e0"]
    ]
  })
  const byId = { cal1: { id: "cal1", name: "Work", color: "#61afef" } }
  const result = Model.parseCalendarEventWindow(raw, Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1), byId)
  assert.equal(result.ok, true)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].title, "Standup")
  assert.equal(result.events[0].calendarName, "Work")
  assert.equal(result.events[0].calendarColor, "#61afef")
})

test("calendarEventWindowRequestBody uses a JMAP back-reference rather than a second round trip", () => {
  const body = JSON.parse(Model.calendarEventWindowRequestBody("u1", ["c1"], "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"))
  assert.equal(body.methodCalls[0][0], "CalendarEvent/query")
  assert.equal(body.methodCalls[1][0], "CalendarEvent/get")
  assert.deepEqual(body.methodCalls[1][1]["#ids"], { resultOf: "q0", name: "CalendarEvent/query", path: "/ids" })
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
