// Pure JS: date/grid math, timezone-safe recurrence expansion, CalDAV
// request builders, WebDAV/iCalendar parsers and text sanitization for the
// Fastmail Calendar plugin (Fastmail by default, any CalDAV server). No
// QML or Qt types here, so this stays testable under node the same way
// Omarchy's own clock plugin — and omarchy-hey-calendar's Model.js — keep
// their Model.js pure. The date/grid math below is copied from
// omarchy-hey-calendar's Model.js (itself copied from omarchy.clock's), so
// the Month and Year views line up with the native Omarchy calendar popup;
// see THIRD_PARTY_NOTICES.md.

// ---------------------------------------------------------------------------
// Date & grid math
// ---------------------------------------------------------------------------

var MS_PER_DAY = 86400000
var WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
var MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"]
var JSCAL_WEEKDAYS = ["su", "mo", "tu", "we", "th", "fr", "sa"]

function pad2(value) {
  var n = Number(value)
  return (n < 10 ? "0" : "") + n
}

function dateKey(year, month, day) {
  return year + "-" + pad2(Number(month) + 1) + "-" + pad2(day)
}

function keyForDate(date) {
  return dateKey(date.getFullYear(), date.getMonth(), date.getDate())
}

// Parses a "YYYY-MM-DD" key back into a local Date at midnight.
function dateFromKey(key) {
  var match = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  return new Date(parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10))
}

function coerceWeekStart(value) {
  if (value === undefined || value === null) return null
  if (typeof value === "number")
    return isFinite(value) ? ((Math.round(value) % 7) + 7) % 7 : null
  var text = String(value).replace(/^\s+|\s+$/g, "").toLowerCase()
  if (text === "") return null
  for (var i = 0; i < WEEKDAY_NAMES.length; i++)
    if (WEEKDAY_NAMES[i] === text || WEEKDAY_NAMES[i].substr(0, 3) === text) return i
  var parsed = parseInt(text, 10)
  return isFinite(parsed) ? ((parsed % 7) + 7) % 7 : null
}

function normalizedWeekStart(value, fallback) {
  var configured = coerceWeekStart(value)
  if (configured !== null) return configured
  var fallbackStart = coerceWeekStart(fallback)
  return fallbackStart === null ? 1 : fallbackStart
}

function weekdayOrder(weekStart) {
  var start = normalizedWeekStart(weekStart, 1)
  var out = []
  for (var i = 0; i < 7; i++) out.push((start + i) % 7)
  return out
}

function isoWeek(year, month, day) {
  var date = new Date(Date.UTC(year, month, day))
  var weekday = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - weekday)
  var yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7)
}

// Always six rows of seven days, so the grid never resizes between months.
function monthGrid(year, month, weekStart, todayKey) {
  var start = normalizedWeekStart(weekStart, 1)
  var leading = (new Date(year, month, 1).getDay() - start + 7) % 7
  var cursor = new Date(year, month, 1 - leading)
  var today = String(todayKey || "")
  var weeks = []

  for (var w = 0; w < 6; w++) {
    var days = []
    var thursday = null
    for (var d = 0; d < 7; d++) {
      var cellYear = cursor.getFullYear()
      var cellMonth = cursor.getMonth()
      var cellDay = cursor.getDate()
      var weekday = cursor.getDay()
      var key = dateKey(cellYear, cellMonth, cellDay)
      if (weekday === 4) thursday = { year: cellYear, month: cellMonth, day: cellDay }
      days.push({
        key: key, year: cellYear, month: cellMonth, day: cellDay, weekday: weekday,
        inMonth: cellMonth === month && cellYear === year,
        weekend: weekday === 0 || weekday === 6,
        today: key === today
      })
      cursor.setDate(cursor.getDate() + 1)
    }
    var anchor = thursday || days[0]
    weeks.push({ week: isoWeek(anchor.year, anchor.month, anchor.day), days: days })
  }
  return weeks
}

function stepMonth(year, month, delta) {
  var target = new Date(year, Number(month) + Number(delta), 1)
  return { year: target.getFullYear(), month: target.getMonth() }
}

// A single week's seven days, for the Week view.
function weekDays(anchorDate, weekStart, todayKey) {
  var start = normalizedWeekStart(weekStart, 1)
  var leading = (anchorDate.getDay() - start + 7) % 7
  var cursor = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate() - leading)
  var today = String(todayKey || "")
  var days = []
  for (var d = 0; d < 7; d++) {
    var key = dateKey(cursor.getFullYear(), cursor.getMonth(), cursor.getDate())
    days.push({
      key: key, year: cursor.getFullYear(), month: cursor.getMonth(), day: cursor.getDate(),
      weekday: cursor.getDay(), weekend: cursor.getDay() === 0 || cursor.getDay() === 6,
      today: key === today
    })
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

function stepWeek(anchorDate, delta) {
  return new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate() + delta * 7)
}

function monthName(month) {
  return MONTH_NAMES[((Number(month) % 12) + 12) % 12]
}

// ---------------------------------------------------------------------------
// Timezone-safe instant conversion
//
// JSCalendar (RFC 8984) events carry a "local" date-time string with no UTC
// offset, plus a separate IANA `timeZone` (or no timeZone at all — a
// "floating" time, shown as typed in whatever zone the viewer is in). Turning
// that pair into a real instant has to go through the IANA database, not a
// fixed offset, so a 9am meeting in America/Chicago reads as 9am both before
// and after a DST change. Intl.DateTimeFormat carries the platform's tz
// database, so it is used here rather than a bundled one.
// ---------------------------------------------------------------------------

function parseLocalDateTime(value) {
  var match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/)
  if (!match) return null
  return {
    year: parseInt(match[1], 10), month: parseInt(match[2], 10), day: parseInt(match[3], 10),
    hour: match[4] !== undefined ? parseInt(match[4], 10) : 0,
    minute: match[5] !== undefined ? parseInt(match[5], 10) : 0,
    second: match[6] !== undefined ? parseInt(match[6], 10) : 0
  }
}

// The IANA offset (ms, UTC-relative) in effect at a given instant, read back
// through Intl rather than a bundled tz table. "" or an unknown zone name is
// read as UTC (offset 0) — a floating time is the caller's job to skip this
// entirely (see zonedTimeToUtcMs), so this path is only hit for a zone Intl
// itself does not recognize, which is treated as "no shift" rather than a
// crash.
function tzOffsetMsAt(utcMs, timeZone) {
  if (!timeZone) return 0
  try {
    var formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    })
    var parts = formatter.formatToParts(new Date(utcMs))
    var map = {}
    for (var i = 0; i < parts.length; i++) map[parts[i].type] = parts[i].value
    var hour = Number(map.hour)
    if (hour === 24) hour = 0
    var asUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second))
    return asUtc - utcMs
  } catch (error) {
    return 0
  }
}

// Converts a JSCalendar local date-time string in `timeZone` to a UTC epoch
// ms. `timeZone` of "" or null/undefined is a *floating* time — JSCalendar's
// term for "no zone attached" — read as-is in whatever zone this code is
// running in, which is what a floating time is defined to mean to its viewer.
// Fixed-point iteration (never more than a couple of steps in practice)
// converges even across a DST transition; the skipped/ambiguous hour at the
// transition itself resolves to one of its two possible instants rather than
// throwing, which is adequate for a read-only viewer.
function zonedTimeToUtcMs(localValue, timeZone) {
  var parsed = parseLocalDateTime(localValue)
  if (!parsed) return NaN
  var naiveUtc = Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute, parsed.second)
  if (!timeZone) return naiveUtc
  var guess = naiveUtc
  for (var i = 0; i < 3; i++) {
    var offset = tzOffsetMsAt(guess, timeZone)
    var next = naiveUtc - offset
    if (next === guess) break
    guess = next
  }
  return guess
}

// The inverse of parseLocalDateTime + zonedTimeToUtcMs's math, used to turn a
// generated occurrence's own UTC instant back into the local "YYYY-MM-DDTHH:MM:SS"
// string that is compared against recurrenceOverrides keys (those keys are
// always in the event's own timeZone, not UTC or the viewer's zone).
function utcMsToLocalString(utcMs, timeZone) {
  var offset = tzOffsetMsAt(utcMs, timeZone)
  var local = new Date(utcMs + offset)
  return local.getUTCFullYear() + "-" + pad2(local.getUTCMonth() + 1) + "-" + pad2(local.getUTCDate())
    + "T" + pad2(local.getUTCHours()) + ":" + pad2(local.getUTCMinutes()) + ":" + pad2(local.getUTCSeconds())
}

// ISO 8601 duration ("PT1H30M", "P1D", "PT45M") to milliseconds. JSCalendar
// durations are always positive and never carry a date-time mix beyond
// weeks/days before the T and hours/minutes/seconds after it.
function parseIso8601Duration(value) {
  var match = String(value || "").match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/)
  if (!match) return 0
  var weeks = Number(match[1] || 0), days = Number(match[2] || 0)
  var hours = Number(match[3] || 0), minutes = Number(match[4] || 0), seconds = Number(match[5] || 0)
  return ((weeks * 7 + days) * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000
}

// ---------------------------------------------------------------------------
// Recurrence expansion (JSCalendar recurrenceRules / recurrenceOverrides,
// RFC 8984 §4.3.3-4.3.4)
//
// Scope: frequency daily/weekly/monthly/yearly, interval, count, until,
// byDay (plain weekday or "2nd Tuesday"-style nthOfPeriod), byMonthDay,
// byMonth, plus recurrenceOverrides (excluded / moved / retitled instances).
// byYearDay, byWeekNo, bySetPosition and sub-hour frequencies are out of
// scope for a read-only viewer and are documented as such in the README —
// an event using one of those still shows its plain, unexpanded occurrence.
// ---------------------------------------------------------------------------

var maxOccurrencesPerEvent = 500
var maxRecurrenceIterations = 20000

function addMonthsClamped(year, month, day, deltaMonths) {
  var total = year * 12 + month + deltaMonths
  var y = Math.floor(total / 12)
  var m = ((total % 12) + 12) % 12
  var daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return { year: y, month: m, day: Math.min(day, daysInMonth) }
}

function nthWeekdayOfMonth(year, month, weekday, nth) {
  if (nth > 0) {
    var first = new Date(Date.UTC(year, month, 1))
    var offset = (weekday - first.getUTCDay() + 7) % 7
    var day = 1 + offset + (nth - 1) * 7
    var daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    return day <= daysInMonth ? day : -1
  }
  var last = new Date(Date.UTC(year, month + 1, 0))
  var lastOffset = (last.getUTCDay() - weekday + 7) % 7
  var fromEnd = -nth - 1
  var day2 = last.getUTCDate() - lastOffset - fromEnd * 7
  return day2 >= 1 ? day2 : -1
}

// Every candidate local start (year/month/day, same time-of-day as the
// master) for one recurrenceRule, before recurrenceOverrides are applied and
// before the requested display window narrows them — bounded by count/until
// and by the hard iteration/occurrence caps above regardless of what the
// rule asks for.
function candidateStarts(rule, start) {
  var frequency = String(rule.frequency || "")
  var interval = Math.max(1, parseInt(rule.interval, 10) || 1)
  var count = rule.count !== undefined ? Math.max(0, parseInt(rule.count, 10) || 0) : -1
  var until = rule.until ? parseLocalDateTime(rule.until) : null
  var untilMs = until ? Date.UTC(until.year, until.month - 1, until.day, until.hour, until.minute, until.second) : null
  var byDay = Array.isArray(rule.byDay) ? rule.byDay : null
  var byMonthDay = Array.isArray(rule.byMonthDay) ? rule.byMonthDay : null
  var byMonth = Array.isArray(rule.byMonth) ? rule.byMonth.map(function(m) { return parseInt(m, 10) }) : null

  var out = []
  var iterations = 0

  function withinLimits() {
    if (out.length >= maxOccurrencesPerEvent) return false
    if (count >= 0 && out.length >= count) return false
    return true
  }

  function emit(year, month, day) {
    if (!withinLimits()) return
    var localMs = Date.UTC(year, month, day, start.hour, start.minute, start.second)
    if (untilMs !== null && localMs > untilMs) return
    out.push({ year: year, month: month, day: day, localMs: localMs })
  }

  if (frequency === "daily") {
    var cursor = { year: start.year, month: start.month - 1, day: start.day }
    while (withinLimits() && iterations < maxRecurrenceIterations) {
      iterations++
      var localMs = Date.UTC(cursor.year, cursor.month, cursor.day, start.hour, start.minute, start.second)
      if (untilMs !== null && localMs > untilMs) break
      out.push({ year: cursor.year, month: cursor.month, day: cursor.day, localMs: localMs })
      var next = new Date(Date.UTC(cursor.year, cursor.month, cursor.day + interval))
      cursor = { year: next.getUTCFullYear(), month: next.getUTCMonth(), day: next.getUTCDate() }
    }
  } else if (frequency === "weekly") {
    var days = byDay && byDay.length > 0
      ? byDay.map(function(d) { return JSCAL_WEEKDAYS.indexOf(String(d.day || "").toLowerCase()) }).filter(function(i) { return i >= 0 })
      : [new Date(Date.UTC(start.year, start.month - 1, start.day)).getUTCDay()]
    days.sort(function(a, b) { return a - b })
    var weekAnchor = new Date(Date.UTC(start.year, start.month - 1, start.day))
    weekAnchor.setUTCDate(weekAnchor.getUTCDate() - weekAnchor.getUTCDay())
    var week = 0
    while (withinLimits() && iterations < maxRecurrenceIterations) {
      if (week % interval === 0) {
        for (var i = 0; i < days.length && withinLimits(); i++) {
          iterations++
          var d = new Date(weekAnchor.getTime())
          d.setUTCDate(d.getUTCDate() + days[i] + week * 7)
          if (d.getTime() < Date.UTC(start.year, start.month - 1, start.day)) continue
          emit(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
        }
      }
      week++
      if (week > maxRecurrenceIterations) break
      iterations++
    }
  } else if (frequency === "monthly") {
    var month0 = start.month - 1
    var m = 0
    while (withinLimits() && iterations < maxRecurrenceIterations) {
      iterations++
      var target = addMonthsClamped(start.year, month0, start.day, m * interval)
      if (byDay && byDay.length > 0) {
        for (var bd = 0; bd < byDay.length && withinLimits(); bd++) {
          var entry = byDay[bd]
          var weekday = JSCAL_WEEKDAYS.indexOf(String(entry.day || "").toLowerCase())
          if (weekday < 0) continue
          var nth = entry.nthOfPeriod !== undefined ? parseInt(entry.nthOfPeriod, 10) : 1
          var monthTarget = addMonthsClamped(start.year, month0, 1, m * interval)
          var day = nthWeekdayOfMonth(monthTarget.year, monthTarget.month, weekday, nth)
          if (day > 0) emit(monthTarget.year, monthTarget.month, day)
        }
      } else if (byMonthDay && byMonthDay.length > 0) {
        var monthTarget2 = addMonthsClamped(start.year, month0, 1, m * interval)
        var daysInMonth = new Date(Date.UTC(monthTarget2.year, monthTarget2.month + 1, 0)).getUTCDate()
        for (var md = 0; md < byMonthDay.length && withinLimits(); md++) {
          var n = parseInt(byMonthDay[md], 10)
          var d2 = n > 0 ? n : daysInMonth + n + 1
          if (d2 >= 1 && d2 <= daysInMonth) emit(monthTarget2.year, monthTarget2.month, d2)
        }
      } else {
        emit(target.year, target.month, target.day)
      }
      m++
      if (m > maxRecurrenceIterations) break
    }
  } else if (frequency === "yearly") {
    var y = 0
    while (withinLimits() && iterations < maxRecurrenceIterations) {
      iterations++
      var years = start.year + y * interval
      var months = byMonth && byMonth.length > 0 ? byMonth.map(function(mo) { return mo - 1 }) : [start.month - 1]
      for (var mi = 0; mi < months.length && withinLimits(); mi++) {
        if (byMonthDay && byMonthDay.length > 0) {
          var daysInMonth2 = new Date(Date.UTC(years, months[mi] + 1, 0)).getUTCDate()
          for (var yd = 0; yd < byMonthDay.length && withinLimits(); yd++) {
            var yn = parseInt(byMonthDay[yd], 10)
            var yDay = yn > 0 ? yn : daysInMonth2 + yn + 1
            if (yDay >= 1 && yDay <= daysInMonth2) emit(years, months[mi], yDay)
          }
        } else {
          var daysInTarget = new Date(Date.UTC(years, months[mi] + 1, 0)).getUTCDate()
          emit(years, months[mi], Math.min(start.day, daysInTarget))
        }
      }
      y++
      if (y > maxRecurrenceIterations) break
    }
  } else {
    // Unsupported frequency (hourly/minutely/secondly, or unrecognized): the
    // rule contributes nothing beyond the master's own single occurrence,
    // which the caller already emits regardless of recurrenceRules.
  }

  out.sort(function(a, b) { return a.localMs - b.localMs })
  return out.slice(0, maxOccurrencesPerEvent)
}

// Expands one normalized calendar event into its occurrences overlapping
// [rangeStartMs, rangeEndMs). A non-recurring event yields at most one.
// recurrenceOverrides are matched by the *local* (event-timezone) start
// string of the unmodified occurrence, per RFC 8984 — an override entry with
// `excluded: true` drops that occurrence; any other override object is
// shallow-merged onto it (a changed `start` moves the instance).
function expandOccurrences(event, rangeStartMs, rangeEndMs) {
  var start = parseLocalDateTime(event.startLocal)
  if (!start) return []
  var durationMs = event.durationMs || 0
  var overrides = event.recurrenceOverrides && typeof event.recurrenceOverrides === "object" ? event.recurrenceOverrides : {}

  var bases
  if (Array.isArray(event.recurrenceRules) && event.recurrenceRules.length > 0) {
    bases = []
    for (var r = 0; r < event.recurrenceRules.length && bases.length < maxOccurrencesPerEvent; r++) {
      bases = bases.concat(candidateStarts(event.recurrenceRules[r], start))
    }
    bases.sort(function(a, b) { return a.localMs - b.localMs })
    if (bases.length === 0)
      bases = [{ year: start.year, month: start.month - 1, day: start.day, localMs: Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute, start.second) }]
  } else {
    bases = [{ year: start.year, month: start.month - 1, day: start.day, localMs: Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute, start.second) }]
  }

  var seen = {}
  var out = []
  for (var i = 0; i < bases.length && out.length < maxOccurrencesPerEvent; i++) {
    var base = bases[i]
    var localString = new Date(base.localMs).toISOString().replace(/\.\d+Z$/, "").replace("Z", "")
    if (seen[localString]) continue
    seen[localString] = true

    var override = Object.prototype.hasOwnProperty.call(overrides, localString) ? overrides[localString] : null
    if (override && override.excluded === true) continue

    var startLocal = (override && override.start) ? override.start : localString
    var startMs = event.allDay
      ? Date.UTC(base.year, base.month, base.day)
      : zonedTimeToUtcMs(startLocal, event.timeZone)
    if (isNaN(startMs)) continue
    var instanceDurationMs = (override && override.durationMs !== undefined) ? override.durationMs : durationMs
    var endMs = startMs + instanceDurationMs

    if (endMs <= rangeStartMs || startMs >= rangeEndMs) continue

    out.push({
      recurrenceId: localString,
      startMs: startMs,
      endMs: endMs,
      title: (override && override.title !== undefined) ? override.title : event.title,
      description: (override && override.description !== undefined) ? override.description : event.description,
      location: (override && override.location !== undefined) ? override.location : event.location,
      moved: !!(override && override.start),
      recurring: bases.length > 1 || !!event.recurrenceRules
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Text sanitization — remote titles/descriptions/locations are untrusted
// plaintext: bounded, control/bidi/zero-width characters stripped, never
// rendered as HTML. Same treatment as omarchy-fastmail's Model.js.
// ---------------------------------------------------------------------------

var remoteTitleCharacterLimit = 256
var remoteExcerptCharacterLimit = 2000
var remoteNameCharacterLimit = 160
var remoteErrorCharacterLimit = 512
var remoteCodeCharacterLimit = 64
var remoteIdCharacterLimit = 128

var invisibleCharacters = buildInvisibleCharactersPattern()

function buildInvisibleCharactersPattern() {
  var ranges = []
  ranges.push([0x00, 0x1f])
  ranges.push([0x7f, 0x9f])
  ranges.push([0x200b, 0x200f])
  ranges.push([0x202a, 0x202e])
  ranges.push([0x2060, 0x2064])
  ranges.push([0x2066, 0x2069])
  ranges.push([0xfeff, 0xfeff])
  var body = ""
  for (var i = 0; i < ranges.length; i++) {
    body += String.fromCharCode(ranges[i][0]) + "-" + String.fromCharCode(ranges[i][1])
  }
  return new RegExp("[" + body + "]", "g")
}

function positiveInteger(value, fallback) {
  var parsed = parseInt(String(value || ""), 10)
  return isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function boundedString(value, limit) {
  if (value === undefined || value === null || typeof value === "object") return ""
  var text = String(value)
  var maximum = positiveInteger(limit, remoteExcerptCharacterLimit)
  if (text.length <= maximum) return text
  text = text.substring(0, maximum)
  var last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.substring(0, text.length - 1) : text
}

function cleanText(value, limit) {
  var maximum = positiveInteger(limit, remoteExcerptCharacterLimit)
  return boundedString(value, maximum).replace(invisibleCharacters, " ").replace(/\s+/g, " ").trim()
}

function exceedsUtf8ByteLimit(value, limit) {
  var text = String(value || "")
  var maximum = positiveInteger(limit, 1024 * 1024)
  var bytes = 0
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
        && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i += 1 }
    else bytes += 3
    if (bytes > maximum) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Bounded, hardened process invocation — output size caps, a timeout, and a
// process-group kill on exit, adapted from omarchy-hey-calendar's Model.js
// (itself from 37signals.hey's); see THIRD_PARTY_NOTICES.md.
// ---------------------------------------------------------------------------

var cliResponseByteLimit = 1024 * 1024
var cliErrorByteLimit = 64 * 1024
var finiteCommandTimeoutSec = 25
var finiteCommandKillGraceSec = 2

var boundedCaptureScript = "stdout_limit=$1; stderr_limit=$2; deadline=$3; grace=$4; shift 4; child_pid=; timer_pid=; killer_pid=; timed_out=0; "
  + "stop_timer() { if [ -n \"$timer_pid\" ]; then kill -TERM -- \"-$timer_pid\" 2>/dev/null || true; kill -TERM \"$timer_pid\" 2>/dev/null || true; wait \"$timer_pid\" 2>/dev/null || true; timer_pid=; fi; }; "
  + "start_group_killer() { setpriv --pdeathsig KILL setsid bash -c 'end=$((SECONDS + $1)); while kill -0 -- \"-$2\" 2>/dev/null && [ \"$SECONDS\" -lt \"$end\" ]; do sleep 0.1; done; kill -KILL -- \"-$2\" 2>/dev/null || true' fmcal-output-killer \"$grace\" \"$child_pid\" & killer_pid=$!; }; "
  + "wait_group_killer() { if [ -n \"$killer_pid\" ]; then wait \"$killer_pid\" 2>/dev/null || true; killer_pid=; fi; }; "
  + "cleanup_group() { if [ -n \"$child_pid\" ] && kill -0 -- \"-$child_pid\" 2>/dev/null; then kill -TERM -- \"-$child_pid\" 2>/dev/null || true; start_group_killer; wait_group_killer; fi; }; "
  + "terminate_child() { if [ -n \"$child_pid\" ]; then kill -TERM -- \"-$child_pid\" 2>/dev/null || true; kill -TERM \"$child_pid\" 2>/dev/null || true; start_group_killer; wait \"$child_pid\" 2>/dev/null || true; wait_group_killer; child_pid=; fi; }; "
  + "stop_child() { trap - HUP INT TERM USR1; stop_timer; terminate_child; exit 143; }; "
  + "trap 'timed_out=1' USR1; trap stop_child HUP INT TERM; "
  + "setpriv --pdeathsig KILL setsid \"$@\" "
  + "> >(head -c \"$((stdout_limit + 1))\") "
  + "2> >(head -c \"$((stderr_limit + 1))\" >&2) & child_pid=$!; "
  + "if [ \"$deadline\" -gt 0 ]; then parent_pid=$BASHPID; "
  + "setpriv --pdeathsig KILL setsid bash -c 'sleep \"$1\" || exit 0; kill -USR1 \"$2\" 2>/dev/null || exit 0; kill -TERM -- \"-$3\" 2>/dev/null || true; kill -TERM \"$3\" 2>/dev/null || true; end=$((SECONDS + $4)); while kill -0 -- \"-$3\" 2>/dev/null && [ \"$SECONDS\" -lt \"$end\" ]; do sleep 0.1; done; if kill -0 -- \"-$3\" 2>/dev/null; then kill -KILL -- \"-$3\" 2>/dev/null || true; fi' "
  + "fmcal-output-timeout \"$deadline\" \"$parent_pid\" \"$child_pid\" \"$grace\" & timer_pid=$!; fi; "
  + "wait \"$child_pid\"; status=$?; "
  + "if [ \"$timed_out\" -eq 1 ]; then wait \"$child_pid\" 2>/dev/null || true; status=124; wait \"$timer_pid\" 2>/dev/null || true; timer_pid=; "
  + "else stop_timer; cleanup_group; fi; child_pid=; exit \"$status\""

function boundedCaptureCommand(command, stdoutLimit, stderrLimit, timeoutSeconds, killGraceSeconds) {
  var source = Array.isArray(command) ? command : []
  var stdoutBytes = positiveInteger(stdoutLimit, cliResponseByteLimit)
  var stderrBytes = positiveInteger(stderrLimit, cliErrorByteLimit)
  var deadline = timeoutSeconds === 0 ? 0 : positiveInteger(timeoutSeconds, finiteCommandTimeoutSec)
  var grace = positiveInteger(killGraceSeconds, finiteCommandKillGraceSec)
  return ["setpriv", "--pdeathsig", "TERM", "bash", "-o", "pipefail", "-c",
    boundedCaptureScript, "fmcal-output-guard", String(stdoutBytes), String(stderrBytes),
    String(deadline), String(grace)].concat(source)
}

function shellQuote(value) {
  return "'" + String(value || "").replace(/'/g, "'\\''") + "'"
}

function parseJson(raw, byteLimit) {
  var source = String(raw || "")
  if (exceedsUtf8ByteLimit(source, byteLimit || cliResponseByteLimit))
    return { ok: false, error: "The response exceeded its size limit", code: "" }
  var text = source.trim()
  if (text === "") return { ok: false, error: "The command returned no data", code: "" }
  try {
    var parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { ok: false, error: "The command returned invalid data", code: "" }
    if (parsed.ok === false) {
      return {
        ok: false,
        error: cleanText(parsed.error || "The request failed", remoteErrorCharacterLimit),
        code: boundedString(parsed.code || "", remoteCodeCharacterLimit)
      }
    }
    return { ok: true, value: parsed }
  } catch (error) {
    return { ok: false, error: "Could not parse the response", code: "" }
  }
}

function parseFailure(stdout, stderr) {
  var hasStderr = String(stderr || "").trim() !== ""
  var text = hasStderr ? stderr : stdout
  var result = parseJson(text, hasStderr ? cliErrorByteLimit : cliResponseByteLimit)
  if (result.ok) return { ok: false, error: "The request failed", code: "" }
  return result
}

// "auth" is a stored credential the server rejected; "no_credentials" is
// nothing stored at all — the two need different setup copy ("reconnect" vs
// "connect"), so they stay distinct codes rather than both collapsing into
// one generic auth failure.
function isAuthError(code) {
  var value = boundedString(code || "", remoteCodeCharacterLimit)
  return value === "auth" || value === "no_credentials"
}

function isNoCredentialsError(code) {
  return boundedString(code || "", remoteCodeCharacterLimit) === "no_credentials"
}

function isMissingToolError(code) {
  return boundedString(code || "", remoteCodeCharacterLimit) === "missing_tool"
}

// ---------------------------------------------------------------------------
// Credential storage — a CalDAV username and app password in the system
// keyring via secret-tool (libsecret), under this plugin's own service/account
// pair. The server URL and username ride along as *attributes* of that one
// keyring item, so there is no plain-text config file anywhere and "forget"
// is a single `secret-tool clear`. Deliberately its own entry: this plugin
// never reads any other tool's stored Fastmail credentials (fm-cli's app
// password, Hermes's OAuth cache) and nothing else reads this entry either.
// The password is never a command-line argument and never written to a
// file: it travels lookup -> shell variable -> curl's `-K -` (config from
// stdin) `user =` line, in the memory of one short-lived process.
// ---------------------------------------------------------------------------

var secretService = "ninepointlabs.fastmail-calendar"
var secretAccount = "caldav"
var defaultServerUrl = "https://caldav.fastmail.com"
var fastmailAppPasswordHelpUrl = "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords"
var serverUrlCharacterLimit = 512
var usernameCharacterLimit = 256
var maxDiscoveryRedirects = 5
// https only, a host (optionally a port), and an optional path made of the
// characters a URL path can carry minus anything that could break out of a
// quoting context (quotes, backslashes, whitespace, angle brackets).
var serverUrlPattern = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&+,;=:@%\/-]*)?$/

function validServerUrl(value) {
  var url = String(value === undefined || value === null ? "" : value).trim()
  if (url === "" || url.length > serverUrlCharacterLimit) return ""
  if (!serverUrlPattern.test(url)) return ""
  return url.replace(/\/+$/, "")
}

function serverOrigin(url) {
  var match = String(url || "").match(/^(https:\/\/[^\/]+)/)
  return match ? match[1] : ""
}

function serverPath(url) {
  var match = String(url || "").match(/^https:\/\/[^\/]+(\/.*)?$/)
  return match && match[1] ? match[1] : ""
}

// RFC 6764 bootstrapping: a bare origin starts at /.well-known/caldav (which
// Fastmail redirects to /dav/calendars); a URL with an explicit path is
// taken as the DAV root or calendar home the user wants to start from.
function discoveryStartUrl(server) {
  var url = validServerUrl(server)
  if (url === "") return ""
  var path = serverPath(url)
  return (path === "" || path === "/") ? serverOrigin(url) + "/.well-known/caldav" : url
}

// A DAV href, as the server sent it, reduced to an absolute path on the
// configured origin — anything on another origin (or anything that is not a
// plain path) is refused rather than followed with the stored credentials.
function resolveHref(href, origin) {
  var value = String(href || "").trim()
  if (value === "") return ""
  if (/^https?:\/\//i.test(value)) {
    if (value !== origin && value.indexOf(origin + "/") !== 0) return ""
    value = value.substring(origin.length) || "/"
  }
  if (value.charAt(0) !== "/" || value.length > 1024) return ""
  if (/[\s"'\\<>`]/.test(value) || /[\x00-\x1f\x7f]/.test(value)) return ""
  return value
}

function secretLookupCommand() {
  return boundedCaptureCommand(["secret-tool", "lookup", "service", secretService, "account", secretAccount],
    4096, cliErrorByteLimit)
}

function secretClearCommand() {
  return boundedCaptureCommand(["secret-tool", "clear", "service", secretService, "account", secretAccount],
    4096, cliErrorByteLimit)
}

// The non-secret half of the keyring item. `secret-tool search` prints the
// item's attributes alongside its secret; only the `attribute.` lines are
// let through, so the password itself never reaches this process's stdout.
var accountInfoShell = "secret-tool search service " + shellQuote(secretService) + " account " + shellQuote(secretAccount)
  + " 2>&1 | grep '^attribute\\.' || true"

function accountInfoCommand() {
  return boundedCaptureCommand(["bash", "-c", accountInfoShell, "fmcal-account"], 4096, cliErrorByteLimit)
}

function parseAccountInfo(raw) {
  var server = "", username = ""
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length && i < 64; i++) {
    var match = lines[i].match(/^attribute\.(server|username) = (.*)$/)
    if (!match) continue
    if (match[1] === "server" && server === "") server = validServerUrl(match[2])
    if (match[1] === "username" && username === "") username = boundedString(match[2].trim(), usernameCharacterLimit)
  }
  return { server: server, username: username }
}

// The shell prelude every authenticated request runs: check the two external
// tools exist, read the username (attribute) and password (secret) out of the
// keyring, refuse either if it carries a control character, and build curl's
// config-from-stdin `user =` line with backslash and double quote escaped the
// way curl's config parser expects. Nothing here touches argv or disk.
var caldavCredentialShell = ""
  + "command -v secret-tool >/dev/null 2>&1 || { printf '%s' '{\"ok\":false,\"error\":\"secret-tool (libsecret) is required\",\"code\":\"missing_tool\"}' >&2; exit 1; }; "
  + "command -v curl >/dev/null 2>&1 || { printf '%s' '{\"ok\":false,\"error\":\"curl is required\",\"code\":\"missing_tool\"}' >&2; exit 1; }; "
  + "info=$(secret-tool search service " + shellQuote(secretService) + " account " + shellQuote(secretAccount) + " 2>&1 | grep '^attribute\\.' || true); "
  + "username=$(printf '%s\\n' \"$info\" | sed -n 's/^attribute\\.username = //p' | head -n 1); "
  + "password=$(secret-tool lookup service " + shellQuote(secretService) + " account " + shellQuote(secretAccount) + " 2>/dev/null); "
  + "if [ -z \"$password\" ] || [ -z \"$username\" ]; then printf '%s' '{\"ok\":false,\"error\":\"No calendar credentials stored\",\"code\":\"no_credentials\"}' >&2; exit 1; fi; "
  + "case \"$username$password\" in *[[:cntrl:]]*) printf '%s' '{\"ok\":false,\"error\":\"Stored calendar credentials have unexpected characters\",\"code\":\"auth\"}' >&2; exit 1;; esac; "
  + "esc() { printf '%s' \"$1\" | sed 's/[\\\\\"]/\\\\&/g'; }; "
  + "cfg=$(printf 'user = \"%s:%s\"\\n' \"$(esc \"$username\")\" \"$(esc \"$password\")\"); "
  + "unset password; "

var curlCommon = "curl -sS --max-time 25 --proto =https --max-redirs 0 -K - "
  + "-H 'Content-Type: application/xml; charset=utf-8' "
  + "-w '\\n--fmcal-http-- %{http_code} %{redirect_url}\\n'"
var networkFailure = "{ printf '%s' '{\"ok\":false,\"error\":\"Could not reach the calendar server\",\"code\":\"network\"}' >&2; exit 1; }"

// One request: method, Depth header, URL and XML body as positional args
// (none of them secret), credentials from the prelude. curl handles no
// redirects itself — the caller sees the 3xx plus its Location and decides,
// so the credentials are never replayed to a host this code did not vet.
var caldavRequestShell = "method=$1; depth=$2; url=$3; body=$4; " + caldavCredentialShell
  + "printf '%s\\n' \"$cfg\" | " + curlCommon + " -X \"$method\" -H \"Depth: $depth\" --data-binary \"$body\" \"$url\" || " + networkFailure

function caldavRequestCommand(method, depth, url, body, stdoutLimit) {
  return boundedCaptureCommand(
    ["bash", "-c", caldavRequestShell, "fmcal-caldav", String(method || "PROPFIND"), String(depth || "0"), String(url || ""), String(body || "")],
    stdoutLimit || cliResponseByteLimit, cliErrorByteLimit)
}

// The window fetch: one calendar-query REPORT per calendar href, all in one
// process so the keyring is read once, each response framed by a begin line
// carrying its href and the same status trailer as a single request.
var caldavWindowShell = "origin=$1; body=$2; shift 2; " + caldavCredentialShell
  + "for href in \"$@\"; do printf '\\n--fmcal-begin-- %s\\n' \"$href\"; "
  + "printf '%s\\n' \"$cfg\" | " + curlCommon + " -X REPORT -H 'Depth: 1' --data-binary \"$body\" \"$origin$href\" || " + networkFailure + "; "
  + "done"

var windowResponseByteLimit = 8 * 1024 * 1024

function caldavWindowCommand(origin, hrefs, startUtcMs, endUtcMs) {
  var args = ["bash", "-c", caldavWindowShell, "fmcal-caldav-window", String(origin || ""), calendarQueryBody(startUtcMs, endUtcMs)]
  var list = Array.isArray(hrefs) ? hrefs : []
  for (var i = 0; i < list.length && i < 128; i++) args.push(String(list[i]))
  return boundedCaptureCommand(args, windowResponseByteLimit, cliErrorByteLimit, 90)
}

// Splits curl's output into body + status trailer. A missing trailer means
// the process died before curl could report (or output was cut by the size
// guard), which is an error rather than a body to parse.
function parseHttpResponse(raw, byteLimit) {
  var text = String(raw || "")
  if (exceedsUtf8ByteLimit(text, byteLimit || cliResponseByteLimit))
    return { ok: false, error: "The calendar server response exceeded its size limit", code: "", status: 0, redirect: "", body: "" }
  var match = text.match(/\n--fmcal-http-- (\d{3}) (\S*)\n?$/)
  if (!match)
    return { ok: false, error: "The calendar server returned no status", code: "", status: 0, redirect: "", body: "" }
  return { ok: true, error: "", code: "", status: parseInt(match[1], 10), redirect: boundedString(match[2], 2048), body: text.substring(0, match.index) }
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

// Maps an HTTP failure to the same error/code envelope the shell scripts
// use, so the service treats a 401 from curl exactly like a keyring miss.
function httpFailure(status, what) {
  var label = what || "The calendar server"
  if (status === 401 || status === 403) return { error: label + " rejected the stored username and password", code: "auth" }
  if (status === 404) return { error: label + " has nothing at that address (HTTP 404)", code: "not_found" }
  if (status === 405) return { error: label + " does not accept that request there (HTTP 405)", code: "not_found" }
  return { error: label + " answered HTTP " + status, code: "http" }
}

function parseWindowResponses(raw) {
  var text = String(raw || "")
  if (exceedsUtf8ByteLimit(text, windowResponseByteLimit))
    return { ok: false, error: "The calendar server response exceeded its size limit", code: "", responses: [] }
  var segments = text.split("\n--fmcal-begin-- ")
  var responses = []
  for (var i = 1; i < segments.length && i <= 128; i++) {
    var newline = segments[i].indexOf("\n")
    if (newline < 0) continue
    var href = boundedString(segments[i].substring(0, newline), 1024)
    var response = parseHttpResponse(segments[i].substring(newline + 1), windowResponseByteLimit)
    responses.push({ href: href, status: response.ok ? response.status : 0, body: response.ok ? response.body : "", error: response.ok ? "" : response.error })
  }
  return { ok: true, error: "", code: "", responses: responses }
}

// ---------------------------------------------------------------------------
// A small XML reader for WebDAV multistatus bodies. Element names are kept
// as their local part (prefixes vary by server: D:, d:, A:, cal:), text is
// entity-decoded, attributes are captured, comments/PIs/DOCTYPEs are skipped
// and never expanded, so an untrusted body can at most be malformed — which
// simply yields a tree with nothing useful in it.
// ---------------------------------------------------------------------------

var xmlMaxNodes = 200000

function decodeXmlEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, function(whole, entity) {
    if (entity === "lt") return "<"
    if (entity === "gt") return ">"
    if (entity === "amp") return "&"
    if (entity === "quot") return "\""
    if (entity === "apos") return "'"
    var code = entity.charAt(1) === "x" ? parseInt(entity.substring(2), 16) : parseInt(entity.substring(1), 10)
    if (!isFinite(code) || code < 0 || code > 0x10FFFF) return ""
    try { return String.fromCodePoint(code) } catch (error) { return "" }
  })
}

function xmlLocalName(name) {
  var value = String(name || "")
  var colon = value.indexOf(":")
  return (colon >= 0 ? value.substring(colon + 1) : value).toLowerCase()
}

function parseXmlAttributes(source) {
  var attrs = {}
  var pattern = /([^\s=\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  var match
  while ((match = pattern.exec(String(source || ""))) !== null) {
    attrs[xmlLocalName(match[1])] = decodeXmlEntities(match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[4]))
  }
  return attrs
}

function parseXml(text) {
  var root = { name: "#root", attrs: {}, children: [], text: "" }
  var stack = [root]
  var nodes = 0
  var pattern = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s\/>]+)((?:\s+[^\s=\/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/g
  var match
  var source = String(text || "")
  while ((match = pattern.exec(source)) !== null) {
    var current = stack[stack.length - 1]
    if (match[1] !== undefined) {
      current.text += match[1]
    } else if (match[2] !== undefined) {
      if (stack.length > 1) stack.pop()
    } else if (match[3] !== undefined) {
      if (++nodes > xmlMaxNodes) break
      var node = { name: xmlLocalName(match[3]), attrs: parseXmlAttributes(match[4]), children: [], text: "" }
      current.children.push(node)
      if (match[5] !== "/") stack.push(node)
    } else if (match[6] !== undefined) {
      current.text += decodeXmlEntities(match[6])
    }
  }
  return root
}

function xmlChildren(node, name) {
  if (!node || !Array.isArray(node.children)) return []
  var out = []
  for (var i = 0; i < node.children.length; i++) if (node.children[i].name === name) out.push(node.children[i])
  return out
}

function xmlFind(node, name) {
  if (!node || !Array.isArray(node.children)) return null
  for (var i = 0; i < node.children.length; i++) {
    if (node.children[i].name === name) return node.children[i]
    var deeper = xmlFind(node.children[i], name)
    if (deeper) return deeper
  }
  return null
}

function xmlText(node) {
  return node ? String(node.text || "").trim() : ""
}

// ---------------------------------------------------------------------------
// WebDAV / CalDAV bodies and multistatus parsing
// ---------------------------------------------------------------------------

var davNamespaces = "xmlns:D=\"DAV:\" xmlns:C=\"urn:ietf:params:xml:ns:caldav\" xmlns:A=\"http://apple.com/ns/ical/\""

function propfindDiscoveryBody() {
  return "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
    + "<D:propfind " + davNamespaces + "><D:prop>"
    + "<D:current-user-principal/><C:calendar-home-set/><D:resourcetype/>"
    + "</D:prop></D:propfind>"
}

function propfindCalendarsBody() {
  return "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
    + "<D:propfind " + davNamespaces + "><D:prop>"
    + "<D:displayname/><D:resourcetype/><C:supported-calendar-component-set/>"
    + "<A:calendar-color/><A:calendar-order/>"
    + "</D:prop></D:propfind>"
}

// "YYYYMMDDTHHMMSSZ" — the only date-time form a CalDAV time-range accepts.
function utcStamp(ms) {
  var date = new Date(ms)
  return date.getUTCFullYear() + pad2(date.getUTCMonth() + 1) + pad2(date.getUTCDate())
    + "T" + pad2(date.getUTCHours()) + pad2(date.getUTCMinutes()) + pad2(date.getUTCSeconds()) + "Z"
}

// RFC 4791 §7.8.1: every VEVENT overlapping the window, recurring masters
// included (servers evaluate a time-range against expanded instances), each
// returned as its whole iCalendar object — master plus every override.
function calendarQueryBody(startUtcMs, endUtcMs) {
  return "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
    + "<C:calendar-query " + davNamespaces + ">"
    + "<D:prop><D:getetag/><C:calendar-data/></D:prop>"
    + "<C:filter><C:comp-filter name=\"VCALENDAR\"><C:comp-filter name=\"VEVENT\">"
    + "<C:time-range start=\"" + utcStamp(startUtcMs) + "\" end=\"" + utcStamp(endUtcMs) + "\"/>"
    + "</C:comp-filter></C:comp-filter></C:filter>"
    + "</C:calendar-query>"
}

function parseMultistatus(body) {
  var doc = parseXml(body)
  var multistatus = xmlFind(doc, "multistatus")
  if (!multistatus) return null
  var out = []
  var responses = xmlChildren(multistatus, "response")
  for (var i = 0; i < responses.length && i < 5000; i++) {
    var response = responses[i]
    var href = xmlText(xmlChildren(response, "href")[0])
    var props = []
    var propstats = xmlChildren(response, "propstat")
    for (var p = 0; p < propstats.length; p++) {
      var status = xmlText(xmlChildren(propstats[p], "status")[0])
      if (status !== "" && !/\b2\d\d\b/.test(status)) continue
      var propNodes = xmlChildren(propstats[p], "prop")
      for (var q = 0; q < propNodes.length; q++) props.push(propNodes[q])
    }
    out.push({ href: href, props: props })
  }
  return out
}

// From a PROPFIND on any resource: where the calendar home is (directly, or
// via the principal that knows), both reduced to same-origin paths.
function parseDiscovery(body, origin) {
  var result = { ok: false, error: "", homeHref: "", principalHref: "" }
  var responses = parseMultistatus(body)
  if (!responses) { result.error = "The calendar server did not answer with a WebDAV multistatus"; return result }
  for (var i = 0; i < responses.length; i++) {
    for (var p = 0; p < responses[i].props.length; p++) {
      var prop = responses[i].props[p]
      var home = xmlFind(prop, "calendar-home-set")
      var homeHref = home ? resolveHref(xmlText(xmlChildren(home, "href")[0]), origin) : ""
      if (homeHref !== "" && result.homeHref === "") result.homeHref = homeHref
      var principal = xmlFind(prop, "current-user-principal")
      var principalHref = principal ? resolveHref(xmlText(xmlChildren(principal, "href")[0]), origin) : ""
      if (principalHref !== "" && result.principalHref === "") result.principalHref = principalHref
    }
  }
  result.ok = true
  return result
}

function normalizeCalendarColor(value) {
  var text = String(value || "").trim()
  var match = text.match(/^#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/)
  if (match) return "#" + match[1].toUpperCase()
  var short = text.match(/^#([0-9a-fA-F]{3})$/)
  if (short) return ("#" + short[1].charAt(0) + short[1].charAt(0) + short[1].charAt(1) + short[1].charAt(1) + short[1].charAt(2) + short[1].charAt(2)).toUpperCase()
  return ""
}

function calendarNameFromHref(href) {
  var segments = String(href || "").replace(/\/+$/, "").split("/")
  var last = segments[segments.length - 1] || "Calendar"
  try { return decodeURIComponent(last) } catch (error) { return last }
}

// From a Depth: 1 PROPFIND on the calendar home: every collection that is a
// calendar holding events (schedule in/outboxes and task-only collections
// are skipped), keyed by its path — the one stable id a CalDAV calendar has.
function parseCalendarList(body, origin) {
  var responses = parseMultistatus(body)
  if (!responses) return { ok: false, error: "The calendar server did not answer with a WebDAV multistatus", code: "", calendars: [] }
  var calendars = []
  for (var i = 0; i < responses.length && calendars.length < 128; i++) {
    var href = resolveHref(responses[i].href, origin)
    if (href === "") continue
    var isCalendar = false, isSchedule = false, holdsEvents = true
    var name = "", color = "", order = 0
    for (var p = 0; p < responses[i].props.length; p++) {
      var prop = responses[i].props[p]
      var resourcetype = xmlFind(prop, "resourcetype")
      if (resourcetype) {
        if (xmlChildren(resourcetype, "calendar").length > 0) isCalendar = true
        if (xmlChildren(resourcetype, "schedule-inbox").length > 0 || xmlChildren(resourcetype, "schedule-outbox").length > 0) isSchedule = true
      }
      var components = xmlFind(prop, "supported-calendar-component-set")
      if (components) {
        var comps = xmlChildren(components, "comp")
        if (comps.length > 0) {
          holdsEvents = false
          for (var c = 0; c < comps.length; c++) if (String(comps[c].attrs.name || "").toUpperCase() === "VEVENT") holdsEvents = true
        }
      }
      var displayname = xmlFind(prop, "displayname")
      if (displayname && name === "") name = xmlText(displayname)
      var colorNode = xmlFind(prop, "calendar-color")
      if (colorNode && color === "") color = normalizeCalendarColor(xmlText(colorNode))
      var orderNode = xmlFind(prop, "calendar-order")
      if (orderNode) order = parseInt(xmlText(orderNode), 10) || 0
    }
    if (!isCalendar || isSchedule || !holdsEvents) continue
    calendars.push({
      id: href,
      name: cleanText(name || calendarNameFromHref(href), remoteNameCharacterLimit),
      color: color,
      sortOrder: order,
      isOwner: true
    })
  }
  calendars.sort(function(a, b) { return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) })
  return { ok: true, error: "", code: "", calendars: calendars }
}

// ---------------------------------------------------------------------------
// iCalendar (RFC 5545) reading — just enough of it for a viewer: unfolding,
// property parameters, text escapes, nested components, DATE vs DATE-TIME
// values in UTC / a TZID / floating, DTEND-or-DURATION, RRULE, EXDATE and
// RECURRENCE-ID overrides. Everything is mapped onto the same normalized
// event shape the recurrence engine above already expands.
// ---------------------------------------------------------------------------

function unfoldIcs(text) {
  return String(text || "").replace(/\r\n|\r|\n/g, "\n").replace(/\n[ \t]/g, "")
}

function icsUnescape(value) {
  return String(value || "").replace(/\\([\\;,nN])/g, function(whole, ch) {
    return (ch === "n" || ch === "N") ? "\n" : ch
  })
}

// NAME;PARAM=a,"b;c";OTHER=x:value — parameter values may be quoted (and
// then hold ; , :), so this is a scan rather than a split.
function parseIcsLine(line) {
  var text = String(line || "")
  var i = 0, length = text.length
  var name = ""
  while (i < length && text[i] !== ";" && text[i] !== ":") name += text[i++]
  if (name === "") return null
  var params = {}
  while (i < length && text[i] === ";") {
    i++
    var paramName = ""
    while (i < length && text[i] !== "=" && text[i] !== ";" && text[i] !== ":") paramName += text[i++]
    var values = []
    if (i < length && text[i] === "=") {
      i++
      for (;;) {
        var value = ""
        if (i < length && text[i] === "\"") {
          i++
          while (i < length && text[i] !== "\"") value += text[i++]
          if (i < length) i++
        } else {
          while (i < length && text[i] !== "," && text[i] !== ";" && text[i] !== ":") value += text[i++]
        }
        values.push(value)
        if (i < length && text[i] === ",") { i++; continue }
        break
      }
    }
    params[paramName.toUpperCase()] = values
  }
  if (i >= length || text[i] !== ":") return null
  return { name: name.toUpperCase(), params: params, value: text.substring(i + 1) }
}

function parseIcs(text) {
  var root = { name: "#root", props: [], components: [] }
  var stack = [root]
  var lines = unfoldIcs(text).split("\n")
  for (var i = 0; i < lines.length && i < 200000; i++) {
    if (lines[i] === "") continue
    var prop = parseIcsLine(lines[i])
    if (!prop) continue
    if (prop.name === "BEGIN") {
      var component = { name: prop.value.trim().toUpperCase(), props: [], components: [] }
      stack[stack.length - 1].components.push(component)
      stack.push(component)
    } else if (prop.name === "END") {
      if (stack.length > 1) stack.pop()
    } else {
      stack[stack.length - 1].props.push(prop)
    }
  }
  return root
}

function icsProp(component, name) {
  for (var i = 0; i < component.props.length; i++) if (component.props[i].name === name) return component.props[i]
  return null
}

function icsProps(component, name) {
  var out = []
  for (var i = 0; i < component.props.length; i++) if (component.props[i].name === name) out.push(component.props[i])
  return out
}

function icsComponents(component, name, out) {
  var list = out || []
  for (var i = 0; i < component.components.length; i++) {
    if (component.components[i].name === name) list.push(component.components[i])
    icsComponents(component.components[i], name, list)
  }
  return list
}

// A TZID is trusted only if the platform's own zone database knows it;
// otherwise the trailing "Area/City" of a namespaced id (e.g. the
// "/freeassociation.sourceforge.net/Tzfile/America/Chicago" form) is tried,
// and failing that the time is read as floating. Windows-style names
// ("Central Standard Time") fall into that last bucket — the wall clock
// shown is then the one typed, in the viewer's zone.
var knownTimeZones = {}

function intlKnowsTimeZone(name) {
  if (Object.prototype.hasOwnProperty.call(knownTimeZones, name)) return knownTimeZones[name]
  var known = false
  try { new Intl.DateTimeFormat("en-US", { timeZone: name }); known = true } catch (error) { known = false }
  knownTimeZones[name] = known
  return known
}

function normalizeTzid(value) {
  var tzid = String(value || "").trim()
  if (tzid === "" || tzid.length > 128) return ""
  if (/^(Z|UTC|GMT|Etc\/UTC|Etc\/GMT)$/i.test(tzid)) return "UTC"
  if (intlKnowsTimeZone(tzid)) return tzid
  var segments = tzid.split("/").filter(function(part) { return part !== "" })
  for (var take = 2; take <= 3 && take <= segments.length; take++) {
    var candidate = segments.slice(segments.length - take).join("/")
    if (/^[A-Za-z0-9_+\-\/]+$/.test(candidate) && intlKnowsTimeZone(candidate)) return candidate
  }
  return ""
}

function icsDateValue(prop, fallbackTz) {
  if (!prop) return null
  var raw = String(prop.value || "").trim()
  var isDate = (prop.params.VALUE && String(prop.params.VALUE[0] || "").toUpperCase() === "DATE") || /^\d{8}$/.test(raw)
  if (isDate) {
    var d = raw.match(/^(\d{4})(\d{2})(\d{2})$/)
    if (!d) return null
    return { allDay: true, local: d[1] + "-" + d[2] + "-" + d[3] + "T00:00:00", tz: "" }
  }
  var m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/)
  if (!m) return null
  var local = m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + m[6]
  var tz = m[7] === "Z" ? "UTC" : (prop.params.TZID ? normalizeTzid(prop.params.TZID[0]) : (fallbackTz || ""))
  return { allDay: false, local: local, tz: tz }
}

// Any date value, re-expressed as a local string in the master's zone —
// the key shape expandOccurrences matches overrides by.
function localKeyInZone(value, masterTz, masterAllDay) {
  if (!value) return ""
  if (masterAllDay || value.allDay) return value.local.substring(0, 10) + "T00:00:00"
  if (value.tz === masterTz) return value.local
  var instant = zonedTimeToUtcMs(value.local, value.tz)
  if (isNaN(instant)) return ""
  return utcMsToLocalString(instant, masterTz)
}

var ICS_WEEKDAYS = { SU: "su", MO: "mo", TU: "tu", WE: "we", TH: "th", FR: "fr", SA: "sa" }

// RRULE text to the JSCalendar-shaped rule candidateStarts reads. UNTIL is
// re-expressed in the master's own zone (it arrives in UTC for a zoned
// start, per RFC 5545), a DATE-valued UNTIL covers its whole last day.
function parseRrule(value, masterTz) {
  var rule = {}
  var parts = String(value || "").split(";")
  for (var i = 0; i < parts.length; i++) {
    var eq = parts[i].indexOf("=")
    if (eq < 0) continue
    var key = parts[i].substring(0, eq).toUpperCase()
    var val = parts[i].substring(eq + 1)
    if (key === "FREQ") rule.frequency = val.toLowerCase()
    else if (key === "INTERVAL") rule.interval = parseInt(val, 10) || 1
    else if (key === "COUNT") rule.count = parseInt(val, 10) || 0
    else if (key === "UNTIL") {
      var until = icsDateValue({ value: val, params: {} }, "")
      if (until && until.allDay) rule.until = until.local.substring(0, 10) + "T23:59:59"
      else if (until && until.tz === "UTC") rule.until = utcMsToLocalString(zonedTimeToUtcMs(until.local, "UTC"), masterTz)
      else if (until) rule.until = until.local
    } else if (key === "BYDAY") {
      rule.byDay = []
      var days = val.split(",")
      for (var d = 0; d < days.length; d++) {
        var m = days[d].trim().toUpperCase().match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/)
        if (!m) continue
        var entry = { day: ICS_WEEKDAYS[m[2]] }
        if (m[1] !== undefined) entry.nthOfPeriod = parseInt(m[1], 10)
        rule.byDay.push(entry)
      }
    } else if (key === "BYMONTHDAY") {
      rule.byMonthDay = val.split(",").map(function(n) { return parseInt(n, 10) }).filter(function(n) { return isFinite(n) && n !== 0 })
    } else if (key === "BYMONTH") {
      rule.byMonth = val.split(",").map(function(n) { return parseInt(n, 10) }).filter(function(n) { return n >= 1 && n <= 12 })
    }
    // BYSETPOS, BYYEARDAY, BYWEEKNO, BYHOUR and finer, WKST: not supported;
    // the event still shows on its start and whatever the rest of the rule
    // yields, per the README.
  }
  return rule.frequency ? rule : null
}

function icsDurationMs(component, start) {
  var duration = icsProp(component, "DURATION")
  if (duration) return parseIso8601Duration(String(duration.value || "").replace(/^\+/, ""))
  var end = icsDateValue(icsProp(component, "DTEND"), start.tz)
  if (!end) return start.allDay ? MS_PER_DAY : 0
  if (start.allDay) {
    var s = parseLocalDateTime(start.local), e = parseLocalDateTime(end.local)
    var days = Math.round((Date.UTC(e.year, e.month - 1, e.day) - Date.UTC(s.year, s.month - 1, s.day)) / MS_PER_DAY)
    return Math.max(1, days) * MS_PER_DAY
  }
  var startMs = zonedTimeToUtcMs(start.local, start.tz)
  var endMs = zonedTimeToUtcMs(end.local, end.tz)
  return (isNaN(startMs) || isNaN(endMs)) ? 0 : Math.max(0, endMs - startMs)
}

function icsText(component, name, limit) {
  var prop = icsProp(component, name)
  return prop ? cleanText(icsUnescape(prop.value), limit) : ""
}

// One calendar object (one UID: a master VEVENT plus any RECURRENCE-ID
// instances) to the normalized event the recurrence engine expands. An
// object holding only detached instances (an invitation to a single
// occurrence, say) yields each of them as a standalone event.
function normalizeIcsObject(vevents, objectHref, calendarId) {
  var master = null, instances = []
  for (var i = 0; i < vevents.length; i++) {
    if (icsProp(vevents[i], "RECURRENCE-ID")) instances.push(vevents[i])
    else if (!master) master = vevents[i]
  }
  var out = []
  if (!master) {
    for (var s = 0; s < instances.length && s < 500; s++) {
      var standalone = normalizeIcsEvent(instances[s], objectHref + "#" + s, calendarId, [])
      if (standalone) out.push(standalone)
    }
    return out
  }
  var normalized = normalizeIcsEvent(master, objectHref, calendarId, instances)
  if (normalized) out.push(normalized)
  return out
}

function normalizeIcsEvent(vevent, id, calendarId, instances) {
  var start = icsDateValue(icsProp(vevent, "DTSTART"), "")
  if (!start) return null
  var status = String((icsProp(vevent, "STATUS") || { value: "" }).value || "").trim().toUpperCase()
  var rruleProp = icsProp(vevent, "RRULE")
  var rule = rruleProp ? parseRrule(rruleProp.value, start.tz) : null
  var overrides = {}

  var exdates = icsProps(vevent, "EXDATE")
  for (var e = 0; e < exdates.length; e++) {
    var values = String(exdates[e].value || "").split(",")
    for (var v = 0; v < values.length && v < 2000; v++) {
      var ex = icsDateValue({ value: values[v].trim(), params: exdates[e].params }, start.tz)
      var exKey = localKeyInZone(ex, start.tz, start.allDay)
      if (exKey !== "") overrides[exKey] = { excluded: true }
    }
  }

  for (var n = 0; n < instances.length && n < 2000; n++) {
    var instance = instances[n]
    var recurrenceId = icsDateValue(icsProp(instance, "RECURRENCE-ID"), start.tz)
    var key = localKeyInZone(recurrenceId, start.tz, start.allDay)
    if (key === "") continue
    var instanceStatus = String((icsProp(instance, "STATUS") || { value: "" }).value || "").trim().toUpperCase()
    if (instanceStatus === "CANCELLED") { overrides[key] = { excluded: true }; continue }
    var instanceStart = icsDateValue(icsProp(instance, "DTSTART"), start.tz)
    var patch = { excluded: false }
    var movedTo = localKeyInZone(instanceStart, start.tz, start.allDay)
    if (movedTo !== "" && movedTo !== key) patch.start = movedTo
    if (instanceStart) patch.durationMs = icsDurationMs(instance, instanceStart)
    if (icsProp(instance, "SUMMARY")) patch.title = icsText(instance, "SUMMARY", remoteTitleCharacterLimit) || "Untitled event"
    if (icsProp(instance, "DESCRIPTION")) patch.description = icsText(instance, "DESCRIPTION", remoteExcerptCharacterLimit)
    if (icsProp(instance, "LOCATION")) patch.location = icsText(instance, "LOCATION", remoteNameCharacterLimit)
    overrides[key] = patch
  }

  return {
    id: boundedString(id, 1024),
    uid: boundedString((icsProp(vevent, "UID") || { value: id }).value || id, remoteIdCharacterLimit),
    title: icsText(vevent, "SUMMARY", remoteTitleCharacterLimit) || "Untitled event",
    description: icsText(vevent, "DESCRIPTION", remoteExcerptCharacterLimit),
    location: icsText(vevent, "LOCATION", remoteNameCharacterLimit),
    allDay: start.allDay,
    startLocal: start.local,
    timeZone: start.allDay ? "" : start.tz,
    durationMs: icsDurationMs(vevent, start),
    recurrenceRules: rule ? [rule] : null,
    recurrenceOverrides: overrides,
    calendarId: calendarId,
    status: status === "CANCELLED" ? "cancelled" : "confirmed"
  }
}

// One calendar's REPORT body to expanded occurrences inside
// [rangeStartMs, rangeEndMs), each carrying its calendar's name and color.
function parseCalendarObjects(body, calendar, rangeStartMs, rangeEndMs) {
  var responses = parseMultistatus(body)
  if (!responses) return { ok: false, error: "The calendar server did not answer with a WebDAV multistatus", events: [] }
  var events = []
  for (var i = 0; i < responses.length && events.length < 5000; i++) {
    var objectHref = boundedString(responses[i].href, 1024)
    for (var p = 0; p < responses[i].props.length; p++) {
      var data = xmlFind(responses[i].props[p], "calendar-data")
      if (!data) continue
      var vevents = icsComponents(parseIcs(data.text), "VEVENT")
      var byUid = {}, order = []
      for (var v = 0; v < vevents.length && v < 500; v++) {
        var uid = String((icsProp(vevents[v], "UID") || { value: "" }).value || "").trim() || ("#" + v)
        if (!byUid[uid]) { byUid[uid] = []; order.push(uid) }
        byUid[uid].push(vevents[v])
      }
      for (var u = 0; u < order.length; u++) {
        var normalizedList = normalizeIcsObject(byUid[order[u]], objectHref + (order.length > 1 ? "#" + u : ""), calendar.id)
        for (var m = 0; m < normalizedList.length; m++) {
          var normalized = normalizedList[m]
          if (normalized.status === "cancelled") continue
          var occurrences = expandOccurrences(normalized, rangeStartMs, rangeEndMs)
          for (var o = 0; o < occurrences.length && events.length < 5000; o++) {
            var occ = occurrences[o]
            events.push({
              id: normalized.id + "@" + occ.recurrenceId,
              masterId: normalized.id,
              title: occ.title,
              description: occ.description,
              location: occ.location,
              startMs: occ.startMs,
              endMs: occ.endMs,
              allDay: normalized.allDay,
              recurring: occ.recurring,
              moved: occ.moved,
              calendarId: calendar.id,
              calendarName: calendar.name,
              calendarColor: calendar.color
            })
          }
        }
      }
    }
  }
  return { ok: true, error: "", events: events }
}

// The whole window: every calendar's response, in one pass. A rejected
// credential anywhere is an auth failure for the window; any other
// per-calendar failure is reported as a warning while the rest still show.
function parseCalendarWindow(raw, rangeStartMs, rangeEndMs, calendarsById) {
  var split = parseWindowResponses(raw)
  if (!split.ok) return { ok: false, error: split.error, code: split.code, events: [] }
  var byId = calendarsById && typeof calendarsById === "object" ? calendarsById : {}
  var events = []
  var warnings = []
  for (var i = 0; i < split.responses.length; i++) {
    var response = split.responses[i]
    var calendar = byId[response.href] || { id: response.href, name: calendarNameFromHref(response.href), color: "" }
    if (response.status === 0) { warnings.push(calendar.name + ": " + response.error); continue }
    if (response.status === 401 || response.status === 403)
      return { ok: false, error: httpFailure(response.status).error, code: "auth", events: [] }
    if (response.status !== 207 && response.status !== 200) { warnings.push(calendar.name + ": HTTP " + response.status); continue }
    var parsed = parseCalendarObjects(response.body, calendar, rangeStartMs, rangeEndMs)
    if (!parsed.ok) { warnings.push(calendar.name + ": " + parsed.error); continue }
    for (var e = 0; e < parsed.events.length && events.length < 5000; e++) events.push(parsed.events[e])
  }
  events.sort(function(a, b) { return a.startMs - b.startMs })
  return { ok: true, error: warnings.length > 0 ? cleanText(warnings.join(" · "), remoteErrorCharacterLimit) : "", code: "", events: events }
}

// ---------------------------------------------------------------------------
// Setup: a floating terminal that asks for the server (Fastmail by default),
// username and app password, checks them against the server before storing
// anything, then stores the password via secret-tool's own stdin with the
// server and username as attributes on the same keyring item. Structure
// (lock dir, EXIT trap, IPC completion callback) adapted from
// omarchy-fastmail's Model.js; see THIRD_PARTY_NOTICES.md.
// ---------------------------------------------------------------------------

var setupLockDirectoryName = "setup-lock"
var setupLockShell = "uid=$(id -u) || exit 76; "
  + "runtime=${XDG_RUNTIME_DIR:-/run/user/$uid}; "
  + "[ -d \"$runtime\" ] && [ ! -L \"$runtime\" ] "
  + "&& [ \"$(stat -c %u -- \"$runtime\" 2>/dev/null)\" = \"$uid\" ] "
  + "&& [ \"$(stat -c %a -- \"$runtime\" 2>/dev/null)\" = 700 ] || exit 76; "
  + "ensure_private_dir() { path=$1; "
  + "if mkdir -m 700 -- \"$path\" 2>/dev/null; then return 0; fi; "
  + "[ -d \"$path\" ] && [ ! -L \"$path\" ] "
  + "&& [ \"$(stat -c %u -- \"$path\" 2>/dev/null)\" = \"$uid\" ] "
  + "&& chmod 700 -- \"$path\"; }; "
  + "umask 077; base=\"$runtime/" + secretService + "-$uid\"; "
  + "ensure_private_dir \"$base\" || exit 76; "
  + "lock=\"$base/" + setupLockDirectoryName + "\"; "
  + "ensure_private_dir \"$lock\" || exit 76; "

function setupLockCheckCommand() {
  return ["bash", "-c", setupLockShell + "exec 9<\"$lock\"; flock -n 9"]
}

// The credential-capture script: instructions, three prompts (the password
// one echo-off), input checks, one PROPFIND against the server following
// its redirects by hand (https only, five at most) so a 401 is caught before
// anything is persisted, then `secret-tool clear` + `store` fed the
// password over stdin. The server URL and username are attributes, i.e.
// secret-tool arguments — they are not secrets.
var setupCredentialsScript = "set -eu; clear 2>/dev/null || true; "
  + "printf '%s\\n' 'Calendar setup (CalDAV)' '' "
  + "'Works with Fastmail and any other CalDAV server.' '' "
  + "'Fastmail: Settings > Privacy & Security > Integrations > App passwords,' "
  + "'  New app password, with access limited to Calendars (CalDAV).' "
  + "'  " + fastmailAppPasswordHelpUrl + "' '' "
  + "'The password goes straight to your system keyring — never into this repo,' "
  + "'a log file, or your shell history.' ''; "
  // Terminal query replies (gum's, the emulator's) can be queued on the tty
  // ahead of anything the user types and would be read as the first answer;
  // drain them the way omarchy-show-done does, then also strip any CSI/OSC
  // residue and control characters from what is read.
  + "while IFS= read -rsn 1 -t 0.2 _; do :; done; "
  + "strip_term() { sed -E 's/\\x1b\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\)//g; s/\\x1b\\[[0-9;?]*[ -\\/]*[@-~]//g' | tr -d '[:cntrl:]'; }; "
  + "printf '%s' 'Server URL [" + defaultServerUrl + "]: '; IFS= read -r server; "
  + "server=$(printf '%s' \"$server\" | strip_term | tr -d '[:space:]'); server=${server:-" + defaultServerUrl + "}; server=${server%/}; "
  + "case \"$server\" in https://*) : ;; *) printf '%s\\n' 'The server URL must start with https://'; exit 1;; esac; "
  + "case \"$server\" in *[\\\"\\'\\\\\\`\\<\\>]*|*[[:cntrl:]]*) printf '%s\\n' 'That server URL has unexpected characters.'; exit 1;; esac; "
  + "printf '%s' 'Username (usually your email address): '; IFS= read -r username; "
  + "username=$(printf '%s' \"$username\" | strip_term | tr -d '[:space:]'); "
  + "if [ -z \"$username\" ]; then printf '%s\\n' 'No username entered.'; exit 1; fi; "
  + "printf '%s' 'App password: '; "
  + "stty -echo 2>/dev/null || true; IFS= read -r password; stty echo 2>/dev/null || true; printf '\\n'; "
  + "if [ -z \"$password\" ]; then printf '%s\\n' 'No password entered.'; exit 1; fi; "
  + "case \"$username$password\" in *[[:cntrl:]]*) printf '%s\\n' 'That has unexpected control characters.'; exit 1;; esac; "
  + "esc() { printf '%s' \"$1\" | sed 's/[\\\\\"]/\\\\&/g'; }; "
  + "cfg=$(printf 'user = \"%s:%s\"\\n' \"$(esc \"$username\")\" \"$(esc \"$password\")\"); "
  + "probe() { url=$1; n=0; while :; do "
  + "out=$(printf '%s\\n' \"$cfg\" | curl -sS --max-time 20 --proto =https --max-redirs 0 -K - -o /dev/null -w '%{http_code} %{redirect_url}' -X PROPFIND -H 'Depth: 0' \"$url\") || { printf '%s\\n' \"Could not reach $url\"; exit 1; }; "
  + "code=${out%% *}; redirect=${out#* }; "
  + "case \"$code\" in 301|302|303|307|308) "
  + "case \"$redirect\" in https://*) : ;; *) printf '%s\\n' 'The server redirected somewhere that is not https.'; exit 1;; esac; "
  + "n=$((n + 1)); if [ \"$n\" -gt " + maxDiscoveryRedirects + " ]; then printf '%s\\n' 'Too many redirects.'; exit 1; fi; url=$redirect; continue;; esac; break; done; }; "
  + "printf '%s\\n' 'Checking the server…'; "
  + "case \"$server\" in https://*/*) probe \"$server\";; *) probe \"$server/.well-known/caldav\"; case \"$code\" in 404|405) probe \"$server/\";; esac;; esac; "
  + "case \"$code\" in 2??) : ;; 401|403) printf '%s\\n' 'The server rejected that username and password.'; exit 1;; "
  + "*) printf '%s\\n' \"The server answered HTTP $code — check the server URL.\"; exit 1;; esac; "
  + "secret-tool clear service " + shellQuote(secretService) + " account " + shellQuote(secretAccount) + " 2>/dev/null || true; "
  + "printf '%s' \"$password\" | secret-tool store --label='Fastmail Calendar (CalDAV) app password' service " + shellQuote(secretService) + " account " + shellQuote(secretAccount) + " server \"$server\" username \"$username\"; "
  + "unset password cfg; "
  + "printf '%s\\n' '' 'Saved. You can close this window.'"

function setupLaunchCommand(ipcTarget) {
  var target = shellQuote(ipcTarget)
  var completion = "omarchy-shell -q \"$target\" setupFinished"
  return "target=" + target + "; " + setupLockShell
    + "( flock -n 9 || { printf '%s\\n' 'Calendar setup is already running.'; exit 75; }; "
    + "trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; "
    + "trap 'rc=$?; trap - EXIT; flock -u 9; " + completion + "; exit $rc' EXIT; "
    + setupCredentialsScript + " ) 9<\"$lock\""
}

function setupPlan(hasCredentials, authenticated) {
  return {
    needed: hasCredentials !== true || authenticated !== true,
    title: hasCredentials === true ? "Your stored calendar credentials could not sign in" : "Connect a calendar — Fastmail, or any CalDAV server",
    buttonLabel: hasCredentials === true ? "Reconnect…" : "Connect calendar…"
  }
}

// ---------------------------------------------------------------------------
// Window/day keying for events resolved to absolute instants — an all-day
// event's date key is read straight off its UTC-midnight startMs (never
// shifted by the viewer's zone, since it was never zone-relative to begin
// with); a timed event's key is its start in the viewer's own local zone,
// which is exactly what `new Date(startMs)` already reads as.
// ---------------------------------------------------------------------------

function eventStartKey(event) {
  if (!event) return ""
  if (event.allDay) {
    var d = new Date(event.startMs)
    return dateKey(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  }
  return keyForDate(new Date(event.startMs))
}

function eventsByDay(events) {
  var byDay = {}
  var source = Array.isArray(events) ? events : []
  for (var i = 0; i < source.length; i++) {
    var key = eventStartKey(source[i])
    if (key === "") continue
    if (!byDay[key]) byDay[key] = []
    byDay[key].push(source[i])
  }
  return byDay
}

function eventsOnDay(events, key) {
  var source = Array.isArray(events) ? events : []
  var out = []
  for (var i = 0; i < source.length; i++) if (eventStartKey(source[i]) === key) out.push(source[i])
  return out
}

function eventTimeLabel(event) {
  if (!event || event.allDay) return ""
  var date = new Date(event.startMs)
  var hours = date.getHours()
  var hour12 = hours % 12 === 0 ? 12 : hours % 12
  var minutes = date.getMinutes()
  return hour12 + (minutes === 0 ? "" : ":" + (minutes < 10 ? "0" + minutes : minutes)) + (hours >= 12 ? "pm" : "am")
}

function eventTimeRangeLabel(event) {
  if (!event) return ""
  if (event.allDay) return "All day"
  var start = eventTimeLabel(event)
  if (!event.endMs || event.endMs === event.startMs) return start
  var startDate = new Date(event.startMs)
  var endDate = new Date(event.endMs)
  if (keyForDate(startDate) !== keyForDate(endDate)) return start
  var hours = endDate.getHours()
  var hour12 = hours % 12 === 0 ? 12 : hours % 12
  var minutes = endDate.getMinutes()
  var endLabel = hour12 + (minutes === 0 ? "" : ":" + (minutes < 10 ? "0" + minutes : minutes)) + (hours >= 12 ? "pm" : "am")
  return start + " – " + endLabel
}

function nextEventLabel(events, nowMs) {
  var source = Array.isArray(events) ? events : []
  var now = Number(nowMs || Date.now())
  var best = null
  for (var i = 0; i < source.length; i++) {
    var event = source[i]
    if (!isFinite(event.startMs) || event.startMs < now - 60000) continue
    if (best === null || event.startMs < best.startMs) best = event
  }
  if (!best) return ""
  var time = eventTimeLabel(best)
  return time === "" ? best.title : time + " · " + best.title
}

// ---------------------------------------------------------------------------
// Calendar selection / color / visibility persistence — stable-id keyed, so
// the choice survives a calendar list re-fetch even if Fastmail reorders it.
// Stored as a JSON string in the bar entry's settings (`calendarPrefs`).
// ---------------------------------------------------------------------------

var maximumCalendarPrefEntries = 128
var calendarPrefsCharacterLimit = 32768

// Chromatic palette only — no black/white/grey, which make unreadable dots
// on a themed background. Reused verbatim from omarchy-fastmail's avatar
// palette idea, generalized to a fixed set here since a calendar dot has no
// live theme file to read.
var calendarColorPalette = [
  "#e06c75", "#e5945e", "#e5c07b", "#98c379", "#56b6c2", "#61afef",
  "#c678dd", "#d19a66", "#5cb3a8", "#8fa1d0", "#d17ba0", "#7cae7a"
]

function calendarColorIndex(calendarId, count) {
  var total = Number(count || 0)
  if (!isFinite(total) || total <= 0) return 0
  var text = String(calendarId || "")
  var hash = 5381
  for (var i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  return hash % total
}

function fallbackCalendarColor(calendarId) {
  return calendarColorPalette[calendarColorIndex(calendarId, calendarColorPalette.length)]
}

function parseCalendarPrefs(raw) {
  var text = boundedString(raw, calendarPrefsCharacterLimit)
  if (text.trim() === "") return {}
  try {
    var parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    return {}
  }
}

function serializeCalendarPrefs(prefs) {
  var out = {}
  var keys = Object.keys(prefs || {}).slice(0, maximumCalendarPrefEntries)
  for (var i = 0; i < keys.length; i++) {
    var entry = prefs[keys[i]] || {}
    out[boundedString(keys[i], remoteIdCharacterLimit)] = {
      visible: entry.visible !== false,
      color: entry.color !== undefined && entry.color !== "" ? cleanText(entry.color, 32) : undefined,
      name: entry.name !== undefined && entry.name !== "" ? cleanText(entry.name, remoteNameCharacterLimit) : undefined
    }
  }
  return JSON.stringify(out)
}

// Merges the live calendar list with stored prefs: a calendar not yet seen
// defaults to visible with its own server color (or a stable palette
// fallback); a stored preference's visibility and any color/name override
// carry over even if the calendar was momentarily absent from a transient
// failed fetch — this only reads the two together, callers own persistence.
function mergeCalendarPrefs(calendars, storedPrefsRaw) {
  var prefs = parseCalendarPrefs(storedPrefsRaw)
  var source = Array.isArray(calendars) ? calendars.slice(0, 128) : []
  var out = []
  for (var i = 0; i < source.length; i++) {
    var cal = source[i]
    var pref = prefs[cal.id] || {}
    out.push({
      id: cal.id,
      name: pref.name !== undefined && pref.name !== "" ? pref.name : cal.name,
      serverName: cal.name,
      color: pref.color !== undefined && pref.color !== "" ? pref.color : (cal.color || fallbackCalendarColor(cal.id)),
      visible: pref.visible !== false
    })
  }
  return out
}

function visibleCalendarIds(prefsList) {
  var source = Array.isArray(prefsList) ? prefsList : []
  var out = []
  for (var i = 0; i < source.length; i++) if (source[i].visible) out.push(source[i].id)
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    dateKey: dateKey, keyForDate: keyForDate, dateFromKey: dateFromKey,
    normalizedWeekStart: normalizedWeekStart, weekdayOrder: weekdayOrder, isoWeek: isoWeek,
    monthGrid: monthGrid, stepMonth: stepMonth, weekDays: weekDays, stepWeek: stepWeek, monthName: monthName,
    parseLocalDateTime: parseLocalDateTime, tzOffsetMsAt: tzOffsetMsAt,
    zonedTimeToUtcMs: zonedTimeToUtcMs, utcMsToLocalString: utcMsToLocalString,
    parseIso8601Duration: parseIso8601Duration,
    candidateStarts: candidateStarts, expandOccurrences: expandOccurrences,
    maxOccurrencesPerEvent: maxOccurrencesPerEvent,
    boundedString: boundedString, cleanText: cleanText, exceedsUtf8ByteLimit: exceedsUtf8ByteLimit,
    remoteTitleCharacterLimit: remoteTitleCharacterLimit, remoteExcerptCharacterLimit: remoteExcerptCharacterLimit,
    remoteNameCharacterLimit: remoteNameCharacterLimit, remoteIdCharacterLimit: remoteIdCharacterLimit,
    boundedCaptureCommand: boundedCaptureCommand, shellQuote: shellQuote,
    cliResponseByteLimit: cliResponseByteLimit, cliErrorByteLimit: cliErrorByteLimit,
    parseJson: parseJson, parseFailure: parseFailure, isAuthError: isAuthError,
    isNoCredentialsError: isNoCredentialsError, isMissingToolError: isMissingToolError,
    secretService: secretService, secretAccount: secretAccount, defaultServerUrl: defaultServerUrl,
    fastmailAppPasswordHelpUrl: fastmailAppPasswordHelpUrl, maxDiscoveryRedirects: maxDiscoveryRedirects,
    validServerUrl: validServerUrl, serverOrigin: serverOrigin, serverPath: serverPath,
    discoveryStartUrl: discoveryStartUrl, resolveHref: resolveHref,
    secretLookupCommand: secretLookupCommand, secretClearCommand: secretClearCommand,
    accountInfoShell: accountInfoShell, accountInfoCommand: accountInfoCommand, parseAccountInfo: parseAccountInfo,
    caldavCredentialShell: caldavCredentialShell, caldavRequestShell: caldavRequestShell, caldavRequestCommand: caldavRequestCommand,
    caldavWindowShell: caldavWindowShell, caldavWindowCommand: caldavWindowCommand, windowResponseByteLimit: windowResponseByteLimit,
    parseHttpResponse: parseHttpResponse, isRedirectStatus: isRedirectStatus, httpFailure: httpFailure, parseWindowResponses: parseWindowResponses,
    decodeXmlEntities: decodeXmlEntities, parseXml: parseXml, xmlChildren: xmlChildren, xmlFind: xmlFind, xmlText: xmlText,
    propfindDiscoveryBody: propfindDiscoveryBody, propfindCalendarsBody: propfindCalendarsBody,
    utcStamp: utcStamp, calendarQueryBody: calendarQueryBody,
    parseMultistatus: parseMultistatus, parseDiscovery: parseDiscovery, normalizeCalendarColor: normalizeCalendarColor,
    parseCalendarList: parseCalendarList,
    unfoldIcs: unfoldIcs, icsUnescape: icsUnescape, parseIcsLine: parseIcsLine, parseIcs: parseIcs,
    icsComponents: icsComponents, normalizeTzid: normalizeTzid, icsDateValue: icsDateValue, localKeyInZone: localKeyInZone,
    parseRrule: parseRrule, normalizeIcsObject: normalizeIcsObject, normalizeIcsEvent: normalizeIcsEvent,
    parseCalendarObjects: parseCalendarObjects, parseCalendarWindow: parseCalendarWindow,
    setupLockCheckCommand: setupLockCheckCommand, setupLaunchCommand: setupLaunchCommand,
    setupCredentialsScript: setupCredentialsScript, setupPlan: setupPlan,
    eventStartKey: eventStartKey, eventsByDay: eventsByDay, eventsOnDay: eventsOnDay,
    eventTimeLabel: eventTimeLabel, eventTimeRangeLabel: eventTimeRangeLabel, nextEventLabel: nextEventLabel,
    calendarColorIndex: calendarColorIndex, fallbackCalendarColor: fallbackCalendarColor, calendarColorPalette: calendarColorPalette,
    parseCalendarPrefs: parseCalendarPrefs, serializeCalendarPrefs: serializeCalendarPrefs,
    mergeCalendarPrefs: mergeCalendarPrefs, visibleCalendarIds: visibleCalendarIds
  }
}
