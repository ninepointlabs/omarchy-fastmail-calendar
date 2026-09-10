// Process orchestration adapted from omarchy-hey-calendar's and
// omarchy-fastmail's Service.qml under the MIT terms in
// THIRD_PARTY_NOTICES.md.
import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// The plugin's data layer, instantiated once per shell as its `service`
// entry point — every bar widget (one per monitor) and every open panel
// reads this one instance, so switching months or opening a day never fires
// more than one Fastmail request at a time. Read-only: there is no event
// mutation here, only session probing, the calendar list, and the events in
// whatever date window the panel asks for.
Item {
  id: root

  property var shell: null
  property var settings: ({})
  // A widget-local instance, built only under a shell without service
  // support, stays inert once a shared one exists.
  property bool active: true

  // ---- Setup / auth state
  property bool probed: false
  property bool probing: false
  property bool probeError: false
  property bool hasToken: false
  property bool authenticated: false
  property bool missingTool: false
  property string lastError: ""
  property string apiUrl: ""
  property string accountId: ""

  // ---- Calendars — every calendar on the account, regardless of the
  //      viewer's visibility choice; visibility only filters what is shown
  //      (see Model.mergeCalendarPrefs), never what is fetched, so toggling
  //      a calendar on screen is instant and needs no network round trip.
  property var calendars: []
  readonly property var calendarPrefs: Model.mergeCalendarPrefs(calendars, setting("calendarPrefs", ""))

  // ---- The currently requested date window (Today/Week/Month/Year all
  //      funnel through this — the panel asks for whatever window its
  //      active view needs, and the service owns exactly one in flight).
  property string windowStart: ""
  property string windowEnd: ""
  property var windowEvents: []
  property bool windowLoading: false
  property string windowError: ""
  property double windowLoadedAtMs: 0

  // ---- Setup flow (floating terminal) and the "forget token" action.
  property bool setupRunning: false
  readonly property bool setupChecking: setupLockProcess.running
  property string actionStatus: ""

  readonly property bool busy: probing || windowLoading || calendarsProcess.running || forgetProcess.running

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function conciseError(value, fallback) {
    var text = Model.cleanText(value || fallback || "Fastmail request failed", Model.remoteExcerptCharacterLimit)
    return text.length > 200 ? text.substring(0, 197) + "…" : text
  }

  // -------------------------------------------------------------- Probe --

  function refresh() {
    if (!active || probing) return
    probing = true
    probeError = false
    lastError = ""
    _sessionOut = ""
    _sessionErr = ""
    sessionProcess.running = true
  }

  function refreshIfStale() {
    if (windowLoadedAtMs <= 0 || Date.now() - windowLoadedAtMs >= 300000) refresh()
  }

  property string _sessionOut: ""
  property string _sessionErr: ""

  Process {
    id: sessionProcess
    running: false
    command: Model.sessionRequestCommand()
    stdout: StdioCollector { id: sessionStdout; waitForEnd: true; onStreamFinished: root._sessionOut = text }
    stderr: StdioCollector { id: sessionStderr; waitForEnd: true; onStreamFinished: root._sessionErr = text }
    onExited: function(exitCode) {
      root.finishSession(exitCode, String(sessionStdout.text || root._sessionOut || ""), String(sessionStderr.text || root._sessionErr || ""))
    }
  }

  function finishSession(exitCode, stdout, stderr) {
    probed = true
    probing = false
    probeError = false

    if (exitCode !== 0) {
      var failure = Model.parseFailure(stdout, stderr)
      missingTool = Model.isMissingToolError(failure.code)
      hasToken = !Model.isNoTokenError(failure.code)
      authenticated = false
      apiUrl = ""
      accountId = ""
      if (missingTool) lastError = conciseError(failure.error, "secret-tool and curl are required")
      else if (!hasToken) lastError = ""
      else {
        probeError = true
        lastError = conciseError(failure.error, "Could not reach Fastmail")
      }
      return
    }

    missingTool = false
    var session = Model.parseSession(stdout)
    if (!session.ok) {
      hasToken = true
      authenticated = false
      apiUrl = ""
      accountId = ""
      lastError = conciseError(session.error, "Could not sign in to Fastmail")
      return
    }

    hasToken = true
    authenticated = true
    lastError = ""
    apiUrl = session.apiUrl
    accountId = session.accountId
    fetchCalendars()
  }

  // ------------------------------------------------------------ Calendars --

  property string _calendarsOut: ""
  property string _calendarsErr: ""

  function fetchCalendars() {
    _calendarsOut = ""
    _calendarsErr = ""
    calendarsProcess.command = Model.calendarGetCommand(apiUrl, accountId)
    calendarsProcess.running = true
  }

  Process {
    id: calendarsProcess
    running: false
    command: []
    stdout: StdioCollector { id: calendarsStdout; waitForEnd: true; onStreamFinished: root._calendarsOut = text }
    stderr: StdioCollector { id: calendarsStderr; waitForEnd: true; onStreamFinished: root._calendarsErr = text }
    onExited: function(exitCode) {
      var stdout = String(calendarsStdout.text || root._calendarsOut || "")
      var stderr = String(calendarsStderr.text || root._calendarsErr || "")
      if (exitCode !== 0) {
        var failure = Model.parseFailure(stdout, stderr)
        if (Model.isAuthError(failure.code)) { root.authenticated = false; return }
        root.lastError = root.conciseError(failure.error, "Could not list Fastmail calendars")
        return
      }
      var parsed = Model.parseCalendarGet(stdout)
      if (!parsed.ok) {
        if (Model.isAuthError(parsed.code)) { root.authenticated = false; return }
        root.lastError = root.conciseError(parsed.error, "Could not list Fastmail calendars")
        return
      }
      root.calendars = parsed.calendars
      if (root.windowStart !== "" && root.windowEnd !== "") root.requestWindow(root.windowStart, root.windowEnd, true)
    }
  }

  // -------------------------------------------------------------- Window --

  // Asks for a date window (Today/Week/Month/Year all resolve to one of
  // these before calling in). `force` re-fetches even if the window is
  // unchanged — used after the calendar list loads or changes shape.
  // startKey/endKey are inclusive "YYYY-MM-DD" local calendar days; the
  // instant range sent to Fastmail (and used to bound recurrence expansion)
  // is midnight of startKey to midnight of the day after endKey, in this
  // machine's own zone — the same zone every display computation already
  // reads dates in.
  function requestWindow(startKey, endKey, force) {
    if (!active) return
    if (!force && startKey === windowStart && endKey === windowEnd && windowLoadedAtMs > 0) return
    windowStart = startKey
    windowEnd = endKey
    if (!probed || !hasToken || !authenticated || apiUrl === "" || accountId === "") return
    if (calendars.length === 0) { windowEvents = []; return }

    var startDate = Model.dateFromKey(startKey)
    var endDate = Model.dateFromKey(endKey)
    if (!startDate || !endDate) return
    var rangeStartMs = startDate.getTime()
    var rangeEndMs = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1).getTime()

    var ids = []
    for (var i = 0; i < calendars.length; i++) ids.push(calendars[i].id)

    windowLoading = true
    windowError = ""
    _eventsOut = ""
    _eventsErr = ""
    _windowRangeStartMs = rangeStartMs
    _windowRangeEndMs = rangeEndMs
    eventsProcess.command = Model.calendarEventWindowCommand(
      apiUrl, accountId, ids, new Date(rangeStartMs).toISOString(), new Date(rangeEndMs).toISOString())
    eventsProcess.running = true
  }

  property double _windowRangeStartMs: 0
  property double _windowRangeEndMs: 0
  property string _eventsOut: ""
  property string _eventsErr: ""

  Process {
    id: eventsProcess
    running: false
    command: []
    stdout: StdioCollector { id: eventsStdout; waitForEnd: true; onStreamFinished: root._eventsOut = text }
    stderr: StdioCollector { id: eventsStderr; waitForEnd: true; onStreamFinished: root._eventsErr = text }
    onExited: function(exitCode) {
      var stdout = String(eventsStdout.text || root._eventsOut || "")
      var stderr = String(eventsStderr.text || root._eventsErr || "")
      root.windowLoading = false
      root.windowLoadedAtMs = Date.now()
      if (exitCode !== 0) {
        var failure = Model.parseFailure(stdout, stderr)
        if (Model.isAuthError(failure.code)) { root.authenticated = false; return }
        root.windowError = root.conciseError(failure.error, "Could not load Fastmail events")
        return
      }
      var byId = {}
      for (var i = 0; i < root.calendars.length; i++) byId[root.calendars[i].id] = root.calendars[i]
      var parsed = Model.parseCalendarEventWindow(stdout, root._windowRangeStartMs, root._windowRangeEndMs, byId)
      if (!parsed.ok) {
        if (Model.isAuthError(parsed.code)) { root.authenticated = false; return }
        root.windowError = parsed.error
        return
      }
      root.windowEvents = parsed.events
    }
  }

  // --------------------------------------------------------- Calendar prefs --

  // Visibility, color and name overrides are settings the panel writes
  // straight into `settings.calendarPrefs`; the service only reads it back
  // through calendarPrefs above. Nothing here re-fetches on a change since
  // every calendar's events are already in windowEvents.
  function nextCalendarPrefsJson(mutator) {
    var byId = {}
    for (var i = 0; i < calendarPrefs.length; i++) byId[calendarPrefs[i].id] = calendarPrefs[i]
    mutator(byId)
    return Model.serializeCalendarPrefs(byId)
  }

  // ------------------------------------------------------------- Setup --

  function tryStartSetup() {
    if (setupRunning || setupChecking) return false
    setupRunning = true
    return true
  }

  function finishSetup() {
    setupRunning = false
  }

  function checkSetupRunning() {
    if (!setupLockProcess.running) setupLockProcess.running = true
  }

  Process {
    id: setupLockProcess
    running: false
    command: Model.setupLockCheckCommand()
    onExited: function(exitCode) {
      root.setupRunning = exitCode === 1
      if (exitCode !== 0 && exitCode !== 1)
        root.lastError = "Setup needs a private runtime directory ($XDG_RUNTIME_DIR, mode 700) to run"
    }
  }

  // ---------------------------------------------------------- Forget token --

  property string _forgetOut: ""
  property string _forgetErr: ""

  function forgetToken() {
    if (forgetProcess.running) return
    _forgetOut = ""
    _forgetErr = ""
    forgetProcess.running = true
  }

  Process {
    id: forgetProcess
    running: false
    command: Model.secretClearCommand()
    stdout: StdioCollector { id: forgetStdout; waitForEnd: true; onStreamFinished: root._forgetOut = text }
    stderr: StdioCollector { id: forgetStderr; waitForEnd: true; onStreamFinished: root._forgetErr = text }
    onExited: function(exitCode) {
      root.hasToken = false
      root.authenticated = false
      root.calendars = []
      root.windowEvents = []
      root.apiUrl = ""
      root.accountId = ""
      root.actionStatus = "Fastmail token removed"
      actionStatusTimer.restart()
    }
  }

  Timer {
    id: actionStatusTimer
    interval: 2500
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  Timer {
    id: refreshTimer
    interval: 300000
    repeat: true
    running: root.active
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  onActiveChanged: if (active && !probed) refresh()
}
