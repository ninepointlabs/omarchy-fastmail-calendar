// Calendar grid functions derived from omarchy-hey-calendar; see LICENSE.
var MS_PER_DAY = 86400000
var WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
var MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"]

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

function weekStartSettingName(index) {
  return WEEKDAY_NAMES[normalizedWeekStart(index, 1)]
}

function toggledWeekStart(index) {
  return normalizedWeekStart(index, 1) === 1 ? 0 : 1
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

// A single week's seven days, for the Week view. `anchorKey` is any date
// inside the week; the week itself is derived from weekStart the same way
// monthGrid derives its rows.
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
  var next = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate() + delta * 7)
  return next
}

function monthName(month) {
  return MONTH_NAMES[((Number(month) % 12) + 12) % 12]
}

