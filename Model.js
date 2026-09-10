// Pure JS: date/grid math, timezone-safe recurrence expansion, JMAP request
// builders/parsers and text sanitization for the Fastmail Calendar plugin. No
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
    return { ok: false, error: "The Fastmail response exceeded its size limit", code: "" }
  var text = source.trim()
  if (text === "") return { ok: false, error: "Fastmail returned no data", code: "" }
  try {
    var parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { ok: false, error: "Fastmail returned invalid data", code: "" }
    if (parsed.ok === false) {
      return {
        ok: false,
        error: cleanText(parsed.error || "The Fastmail request failed", remoteErrorCharacterLimit),
        code: boundedString(parsed.code || "", remoteCodeCharacterLimit)
      }
    }
    return { ok: true, value: parsed }
  } catch (error) {
    return { ok: false, error: "Could not parse the Fastmail response", code: "" }
  }
}

function parseFailure(stdout, stderr) {
  var hasStderr = String(stderr || "").trim() !== ""
  var text = hasStderr ? stderr : stdout
  var result = parseJson(text, hasStderr ? cliErrorByteLimit : cliResponseByteLimit)
  if (result.ok) return { ok: false, error: "The Fastmail request failed", code: "" }
  return result
}

// "auth" is a stored token Fastmail rejected or that lacks calendar access;
// "no_token" is no token stored at all — the two need different setup
// copy ("reconnect" vs "connect"), so they stay distinct codes rather than
// both collapsing into one generic auth failure.
function isAuthError(code) {
  var value = boundedString(code || "", remoteCodeCharacterLimit)
  return value === "auth" || value === "no_token"
}

function isNoTokenError(code) {
  return boundedString(code || "", remoteCodeCharacterLimit) === "no_token"
}

function isMissingToolError(code) {
  return boundedString(code || "", remoteCodeCharacterLimit) === "missing_tool"
}

// ---------------------------------------------------------------------------
// Credential storage — a Fastmail API token, kept in the system keyring via
// secret-tool (libsecret), under this plugin's own service/account pair.
// Deliberately its own keyring entry: this plugin never reads any other
// tool's cached Fastmail credentials (Hermes's OAuth cache included), and
// nothing else can read this plugin's entry either. The token is never a
// command-line argument or written to a file: it travels lookup -> shell
// variable -> curl's `-K -` (config-from-stdin) header, in the memory of a
// single short-lived process, and is validated against a plain-token
// character class before use so a stray quote in a corrupted keyring entry
// cannot break out of the curl config line it is interpolated into.
// ---------------------------------------------------------------------------

var secretService = "ninepointlabs.fastmail-calendar"
var secretAccount = "api-token"
var tokenCharacterPattern = /^[A-Za-z0-9._-]+$/
var tokenCharacterLimit = 512

function validToken(value) {
  var token = String(value === undefined || value === null ? "" : value).trim()
  if (token === "" || token.length > tokenCharacterLimit) return ""
  return tokenCharacterPattern.test(token) ? token : ""
}

var fastmailSessionUrl = "https://api.fastmail.com/jmap/session"
var fastmailApiTokenSettingsUrl = "https://app.fastmail.com/settings/security/tokens"
var calendarsCapability = "urn:ietf:params:jmap:calendars"
var coreCapability = "urn:ietf:params:jmap:core"

function secretLookupCommand() {
  return boundedCaptureCommand(["secret-tool", "lookup", "service", secretService, "account", secretAccount],
    4096, cliErrorByteLimit)
}

function secretClearCommand() {
  return boundedCaptureCommand(["secret-tool", "clear", "service", secretService, "account", secretAccount],
    4096, cliErrorByteLimit)
}

// The one shell fragment every authenticated JMAP call runs: check the two
// external tools exist, look the token up, validate its character class,
// then hand it to curl as a config-from-stdin header — never as an argv
// element (so it never appears in `ps`/`/proc/*/cmdline`) and never written
// to disk.
var jmapRequestShell = "method=$1; url=$2; body=$3; "
  + "command -v secret-tool >/dev/null 2>&1 || { printf '%s' '{\"ok\":false,\"error\":\"secret-tool (libsecret) is required\",\"code\":\"missing_tool\"}' >&2; exit 1; }; "
  + "command -v curl >/dev/null 2>&1 || { printf '%s' '{\"ok\":false,\"error\":\"curl is required\",\"code\":\"missing_tool\"}' >&2; exit 1; }; "
  + "token=$(secret-tool lookup service " + shellQuote(secretService) + " account " + shellQuote(secretAccount) + " 2>/dev/null); "
  + "if [ -z \"$token\" ]; then printf '%s' '{\"ok\":false,\"error\":\"No Fastmail API token stored\",\"code\":\"no_token\"}' >&2; exit 1; fi; "
  + "case \"$token\" in *[!A-Za-z0-9._-]*) printf '%s' '{\"ok\":false,\"error\":\"Stored Fastmail token has unexpected characters\",\"code\":\"auth\"}' >&2; exit 1;; esac; "
  + "cfg=$(printf 'header = \"Authorization: Bearer %s\"\\n' \"$token\"); "
  + "if [ \"$method\" = POST ]; then "
  + "printf '%s' \"$cfg\" | curl -sS --max-time 20 -K - -H 'Content-Type: application/json' --data-binary \"$body\" \"$url\"; "
  + "else "
  + "printf '%s' \"$cfg\" | curl -sS --max-time 20 -K - \"$url\"; "
  + "fi"

function jmapRequestCommand(method, url, body) {
  return boundedCaptureCommand(
    ["bash", "-c", jmapRequestShell, "fmcal-jmap", String(method || "GET"), String(url || ""), String(body || "")],
    cliResponseByteLimit, cliErrorByteLimit)
}

// The probe: is a token stored and does it reach a Fastmail account with the
// calendars capability. Reuses the same request path every other call uses,
// so a probe success is a real guarantee the rest will work too.
function probeCommand() {
  return jmapRequestCommand("GET", fastmailSessionUrl, "")
}

// ---------------------------------------------------------------------------
// Setup: a floating terminal that prompts for the token, checks it against
// Fastmail before storing it, and stores it via secret-tool's own stdin
// interface (never argv). Structure (lock dir, EXIT trap, IPC completion
// callback) adapted from omarchy-fastmail's Model.js; see
// THIRD_PARTY_NOTICES.md.
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

// The token-capture script itself: instructions, a hidden `read`, a
// character-class check, one verification call against Fastmail's session
// endpoint (confirms the token is live and has calendars access before it is
// ever persisted), then secret-tool store fed the token over its own stdin.
var setupTokenScript = "set -eu; clear 2>/dev/null || true; "
  + "printf '%s\\n' 'Fastmail Calendar setup' '' "
  + "'1. Open " + fastmailApiTokenSettingsUrl + "' "
  + "'2. Create a new API token with Calendars (read-only) access.' "
  + "'3. Paste it below — it goes straight to your system keyring,' "
  + "'   never into this repo, a log file, or your shell history.' ''; "
  + "printf '%s' 'Fastmail API token: '; "
  + "stty -echo 2>/dev/null || true; IFS= read -r token; stty echo 2>/dev/null || true; printf '\\n'; "
  + "token=$(printf '%s' \"$token\" | tr -d '[:space:]'); "
  + "if [ -z \"$token\" ]; then printf '%s\\n' 'No token entered.'; exit 1; fi; "
  + "case \"$token\" in *[!A-Za-z0-9._-]*) printf '%s\\n' 'That token has unexpected characters — copy it exactly, with nothing extra.'; exit 1;; esac; "
  + "printf '%s\\n' 'Checking the token against Fastmail…'; "
  + "cfg=$(printf 'header = \"Authorization: Bearer %s\"\\n' \"$token\"); "
  + "resp=$(printf '%s' \"$cfg\" | curl -sS --max-time 20 -K - " + shellQuote(fastmailSessionUrl) + "); "
  + "case \"$resp\" in *urn:ietf:params:jmap:calendars*) : ;; *) printf '%s\\n' 'That token could not reach Fastmail Calendars — check its scope and try again.'; exit 1;; esac; "
  + "printf '%s' \"$token\" | secret-tool store --label='Fastmail Calendar API token' service " + shellQuote(secretService) + " account " + shellQuote(secretAccount) + "; "
  + "unset token; "
  + "printf '%s\\n' '' 'Saved. You can close this window.'"

function setupLaunchCommand(ipcTarget) {
  var target = shellQuote(ipcTarget)
  var completion = "omarchy-shell -q \"$target\" setupFinished"
  return "target=" + target + "; " + setupLockShell
    + "( flock -n 9 || { printf '%s\\n' 'Fastmail Calendar setup is already running.'; exit 75; }; "
    + "trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; "
    + "trap 'rc=$?; trap - EXIT; flock -u 9; " + completion + "; exit $rc' EXIT; "
    + setupTokenScript + " ) 9<\"$lock\""
}

function setupPlan(hasToken, authenticated) {
  return {
    needed: hasToken !== true || authenticated !== true,
    title: hasToken === true ? "Your stored Fastmail token could not sign in" : "Connect your Fastmail calendars",
    buttonLabel: hasToken === true ? "Reconnect Fastmail…" : "Connect Fastmail…"
  }
}

// ---------------------------------------------------------------------------
// JMAP request bodies
// ---------------------------------------------------------------------------

function sessionRequestCommand() {
  return jmapRequestCommand("GET", fastmailSessionUrl, "")
}

function parseSession(raw) {
  var result = parseJson(raw)
  if (!result.ok) return { ok: false, error: result.error, code: result.code, apiUrl: "", accountId: "" }
  var value = result.value
  var primary = value.primaryAccounts && typeof value.primaryAccounts === "object" ? value.primaryAccounts : {}
  var accountId = boundedString(primary[calendarsCapability] || "", remoteIdCharacterLimit)
  var apiUrl = boundedString(value.apiUrl || "", 2048)
  if (accountId === "" || apiUrl === "")
    return { ok: false, error: "This Fastmail token does not have calendar access", code: "auth", apiUrl: "", accountId: "" }
  return { ok: true, error: "", code: "", apiUrl: apiUrl, accountId: accountId }
}

function calendarGetRequestBody(accountId) {
  return JSON.stringify({
    using: [coreCapability, calendarsCapability],
    methodCalls: [["Calendar/get", { accountId: accountId, ids: null }, "c0"]]
  })
}

function calendarGetCommand(apiUrl, accountId) {
  return jmapRequestCommand("POST", apiUrl, calendarGetRequestBody(accountId))
}

function parseCalendarGet(raw) {
  var result = parseJson(raw)
  if (!result.ok) return { ok: false, error: result.error, code: result.code, calendars: [] }
  var responses = Array.isArray(result.value.methodResponses) ? result.value.methodResponses : []
  var payload = responses.length > 0 && responses[0][0] === "Calendar/get" ? responses[0][1] : null
  if (!payload) return { ok: false, error: "Fastmail did not return any calendars", code: "", calendars: [] }
  var list = Array.isArray(payload.list) ? payload.list : []
  var calendars = []
  for (var i = 0; i < list.length && calendars.length < 128; i++) {
    var entry = list[i] || {}
    var id = boundedString(entry.id || "", remoteIdCharacterLimit)
    if (id === "") continue
    calendars.push({
      id: id,
      name: cleanText(entry.name || "Calendar", remoteNameCharacterLimit),
      color: cleanText(entry.color || "", 32),
      sortOrder: Number(entry.sortOrder || 0),
      isOwner: entry.isOwnedByAccount !== false
    })
  }
  calendars.sort(function(a, b) { return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) })
  return { ok: true, error: "", code: "", calendars: calendars }
}

// One combined request: query the events overlapping the window (server-side
// filter on `after`/`before`), then fetch the full objects for whatever
// matched via a JMAP back-reference (`#ids`) — a single round trip, per
// RFC 8620 §3.7. `after`/`before` are UTC instants (Z-suffixed) — JMAP's
// CalendarEvent/query filter reads both in absolute time, not the event's
// own zone, so the window itself needs no timezone handling; only the
// events it returns do (see expandOccurrences above).
function calendarEventWindowRequestBody(accountId, calendarIds, afterIso, beforeIso) {
  return JSON.stringify({
    using: [coreCapability, calendarsCapability],
    methodCalls: [
      ["CalendarEvent/query", {
        accountId: accountId,
        filter: { inCalendars: calendarIds, after: afterIso, before: beforeIso },
        limit: 2000
      }, "q0"],
      ["CalendarEvent/get", {
        accountId: accountId,
        "#ids": { resultOf: "q0", name: "CalendarEvent/query", path: "/ids" }
      }, "e0"]
    ]
  })
}

function calendarEventWindowCommand(apiUrl, accountId, calendarIds, afterIso, beforeIso) {
  return jmapRequestCommand("POST", apiUrl, calendarEventWindowRequestBody(accountId, calendarIds, afterIso, beforeIso))
}

function normalizeCalendarEvent(raw) {
  var value = raw && typeof raw === "object" ? raw : {}
  var id = boundedString(value.id || "", remoteIdCharacterLimit)
  if (id === "") return null
  var allDay = value.showWithoutTime === true
  var start = boundedString(value.start || "", 32)
  if (start === "") return null
  var calendarIds = value.calendarIds && typeof value.calendarIds === "object" ? Object.keys(value.calendarIds) : []
  var overrides = {}
  if (value.recurrenceOverrides && typeof value.recurrenceOverrides === "object") {
    var keys = Object.keys(value.recurrenceOverrides)
    for (var i = 0; i < keys.length && i < 2000; i++) {
      var patch = value.recurrenceOverrides[keys[i]] || {}
      overrides[keys[i]] = {
        excluded: patch.excluded === true,
        start: patch.start !== undefined ? boundedString(patch.start, 32) : undefined,
        title: patch.title !== undefined ? cleanText(patch.title, remoteTitleCharacterLimit) : undefined,
        description: patch.description !== undefined ? cleanText(patch.description, remoteExcerptCharacterLimit) : undefined,
        location: patch.location !== undefined ? cleanText(locationText(patch.locations), remoteNameCharacterLimit) : undefined,
        durationMs: patch.duration !== undefined ? parseIso8601Duration(patch.duration) : undefined
      }
    }
  }
  return {
    id: id,
    uid: boundedString(value.uid || id, remoteIdCharacterLimit),
    title: cleanText(value.title || "Untitled event", remoteTitleCharacterLimit),
    description: cleanText(value.description || "", remoteExcerptCharacterLimit),
    location: cleanText(locationText(value.locations), remoteNameCharacterLimit),
    allDay: allDay,
    startLocal: start,
    timeZone: allDay ? "" : boundedString(value.timeZone || "", 64),
    durationMs: parseIso8601Duration(value.duration),
    recurrenceRules: Array.isArray(value.recurrenceRules) ? value.recurrenceRules : null,
    recurrenceOverrides: overrides,
    calendarId: calendarIds.length > 0 ? boundedString(calendarIds[0], remoteIdCharacterLimit) : "",
    status: boundedString(value.status || "confirmed", 32)
  }
}

function locationText(locations) {
  if (!locations || typeof locations !== "object") return ""
  var keys = Object.keys(locations)
  for (var i = 0; i < keys.length; i++) {
    var loc = locations[keys[i]]
    if (loc && typeof loc === "object" && loc.name) return String(loc.name)
  }
  return ""
}

// Parses the CalendarEvent/get half of the combined window request and
// expands every returned master into its occurrences inside
// [rangeStartMs, rangeEndMs), attaching each instance's calendar (name,
// color) from `calendarsById` for display, and dropping cancelled events.
function parseCalendarEventWindow(raw, rangeStartMs, rangeEndMs, calendarsById) {
  var result = parseJson(raw)
  if (!result.ok) return { ok: false, error: result.error, code: result.code, events: [] }
  var responses = Array.isArray(result.value.methodResponses) ? result.value.methodResponses : []
  var payload = null
  for (var i = 0; i < responses.length; i++) if (responses[i][0] === "CalendarEvent/get") { payload = responses[i][1]; break }
  if (!payload) return { ok: false, error: "Fastmail did not return any events", code: "", events: [] }
  var list = Array.isArray(payload.list) ? payload.list : []
  var byId = calendarsById && typeof calendarsById === "object" ? calendarsById : {}
  var events = []

  for (var m = 0; m < list.length && m < 2000; m++) {
    var normalized = normalizeCalendarEvent(list[m])
    if (!normalized || normalized.status === "cancelled") continue
    var calendar = byId[normalized.calendarId] || null
    var occurrences = expandOccurrences(normalized, rangeStartMs, rangeEndMs)
    for (var o = 0; o < occurrences.length && events.length < 5000; o++) {
      var occ = occurrences[o]
      events.push({
        id: normalized.id + (occ.recurrenceId !== undefined ? "@" + occ.recurrenceId : ""),
        masterId: normalized.id,
        title: occ.title,
        description: occ.description,
        location: occ.location,
        startMs: occ.startMs,
        endMs: occ.endMs,
        allDay: normalized.allDay,
        recurring: occ.recurring,
        moved: occ.moved,
        calendarId: normalized.calendarId,
        calendarName: calendar ? calendar.name : "",
        calendarColor: calendar ? calendar.color : ""
      })
    }
  }
  events.sort(function(a, b) { return a.startMs - b.startMs })
  return { ok: true, error: "", code: "", events: events }
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
    isNoTokenError: isNoTokenError, isMissingToolError: isMissingToolError,
    secretService: secretService, secretAccount: secretAccount,
    validToken: validToken, tokenCharacterPattern: tokenCharacterPattern,
    fastmailSessionUrl: fastmailSessionUrl, fastmailApiTokenSettingsUrl: fastmailApiTokenSettingsUrl,
    secretLookupCommand: secretLookupCommand, secretClearCommand: secretClearCommand,
    jmapRequestShell: jmapRequestShell, jmapRequestCommand: jmapRequestCommand, probeCommand: probeCommand,
    setupLockCheckCommand: setupLockCheckCommand, setupLaunchCommand: setupLaunchCommand,
    setupTokenScript: setupTokenScript, setupPlan: setupPlan,
    sessionRequestCommand: sessionRequestCommand, parseSession: parseSession,
    calendarGetCommand: calendarGetCommand, calendarGetRequestBody: calendarGetRequestBody, parseCalendarGet: parseCalendarGet,
    calendarEventWindowCommand: calendarEventWindowCommand, calendarEventWindowRequestBody: calendarEventWindowRequestBody,
    normalizeCalendarEvent: normalizeCalendarEvent, parseCalendarEventWindow: parseCalendarEventWindow,
    eventStartKey: eventStartKey, eventsByDay: eventsByDay, eventsOnDay: eventsOnDay,
    eventTimeLabel: eventTimeLabel, eventTimeRangeLabel: eventTimeRangeLabel, nextEventLabel: nextEventLabel,
    calendarColorIndex: calendarColorIndex, fallbackCalendarColor: fallbackCalendarColor, calendarColorPalette: calendarColorPalette,
    parseCalendarPrefs: parseCalendarPrefs, serializeCalendarPrefs: serializeCalendarPrefs,
    mergeCalendarPrefs: mergeCalendarPrefs, visibleCalendarIds: visibleCalendarIds
  }
}
