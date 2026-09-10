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
// more than one request at a time. Read-only: there is no event mutation
// here, only CalDAV discovery, the calendar list, and the events in whatever
// date window the panel asks for — plus one write: creating an event (a
// single CalDAV PUT, see addEvent below).
//
// A refresh runs the RFC 6764 discovery chain step by step, one bounded curl
// process per step, each parsed here before the next is chosen:
//   account  — server + username out of the keyring (no network)
//   discover — PROPFIND the start URL (/.well-known/caldav, or the path the
//              user gave); follow up to five https redirects by hand
//   principal — PROPFIND the current-user-principal for its calendar home
//   calendars — PROPFIND Depth: 1 the home for its calendar collections
// then the window fetch REPORTs every calendar for the visible range.
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
  property bool hasCredentials: false
  property bool authenticated: false
  property bool missingTool: false
  property string lastError: ""
  property string server: ""
  property string username: ""
  property string homeHref: ""
  readonly property string origin: Model.serverOrigin(server)

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

  // ---- Setup flow (floating terminal) and the "forget" action.
  property bool setupRunning: false
  readonly property bool setupChecking: setupLockProcess.running
  property string actionStatus: ""

  // ---- Event creation (the one write this plugin does)
  property bool mutating: false
  property string mutationError: ""

  readonly property bool busy: probing || windowLoading || forgetProcess.running || mutating

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function conciseError(value, fallback) {
    var text = Model.cleanText(value || fallback || "Calendar request failed", Model.remoteExcerptCharacterLimit)
    return text.length > 200 ? text.substring(0, 197) + "…" : text
  }

  // -------------------------------------------------------------- Probe --

  function refresh() {
    if (!active || probing) return
    probing = true
    probeError = false
    lastError = ""
    _accountOut = ""
    accountProcess.running = true
  }

  function refreshIfStale() {
    if (windowLoadedAtMs <= 0 || Date.now() - windowLoadedAtMs >= 300000) refresh()
  }

  function failProbe(message, code) {
    probed = true
    probing = false
    missingTool = Model.isMissingToolError(code)
    if (missingTool) {
      hasCredentials = false
      authenticated = false
      lastError = conciseError(message, "secret-tool and curl are required")
      return
    }
    if (Model.isNoCredentialsError(code)) {
      hasCredentials = false
      authenticated = false
      lastError = ""
      return
    }
    hasCredentials = true
    if (code === "auth") {
      authenticated = false
      lastError = conciseError(message, "The calendar server rejected the stored credentials")
      return
    }
    // A network/HTTP failure with credentials present: keep whatever was
    // already loaded on screen and surface the error, rather than bouncing
    // the viewer back to setup for a flaky connection.
    probeError = true
    lastError = conciseError(message, "Could not reach the calendar server")
  }

  property string _accountOut: ""

  Process {
    id: accountProcess
    running: false
    command: Model.accountInfoCommand()
    stdout: StdioCollector { id: accountStdout; waitForEnd: true; onStreamFinished: root._accountOut = text }
    onExited: function(exitCode) {
      var info = Model.parseAccountInfo(String(accountStdout.text || root._accountOut || ""))
      if (exitCode !== 0 || info.server === "" || info.username === "") {
        root.server = ""
        root.username = ""
        root.failProbe("No calendar credentials stored", "no_credentials")
        return
      }
      root.server = info.server
      root.username = info.username
      root._stage = "discover"
      root._redirects = 0
      root._triedRoot = false
      root.runStep("PROPFIND", "0", Model.discoveryStartUrl(info.server), Model.propfindDiscoveryBody())
    }
  }

  property string _stage: ""
  property int _redirects: 0
  property bool _triedRoot: false
  property string _stepUrl: ""
  property string _stepOut: ""
  property string _stepErr: ""

  function runStep(method, depth, url, body) {
    _stepUrl = url
    _stepOut = ""
    _stepErr = ""
    stepProcess.command = Model.caldavRequestCommand(method, depth, url, body)
    stepProcess.running = true
  }

  Process {
    id: stepProcess
    running: false
    command: []
    stdout: StdioCollector { id: stepStdout; waitForEnd: true; onStreamFinished: root._stepOut = text }
    stderr: StdioCollector { id: stepStderr; waitForEnd: true; onStreamFinished: root._stepErr = text }
    onExited: function(exitCode) {
      root.finishStep(exitCode, String(stepStdout.text || root._stepOut || ""), String(stepStderr.text || root._stepErr || ""))
    }
  }

  function finishStep(exitCode, stdout, stderr) {
    if (exitCode !== 0) {
      var failure = Model.parseFailure(stdout, stderr)
      failProbe(failure.error, failure.code)
      return
    }
    var response = Model.parseHttpResponse(stdout)
    if (!response.ok) { failProbe(response.error, "http"); return }

    if (Model.isRedirectStatus(response.status)) {
      var target = Model.validServerUrl(response.redirect)
      if (target === "" || _redirects >= Model.maxDiscoveryRedirects) {
        failProbe("The calendar server redirected somewhere this plugin will not follow", "http")
        return
      }
      _redirects++
      if (_stage === "calendars") runStep("PROPFIND", "1", target, Model.propfindCalendarsBody())
      else runStep("PROPFIND", "0", target, Model.propfindDiscoveryBody())
      return
    }

    if (response.status === 401 || response.status === 403) {
      failProbe(Model.httpFailure(response.status).error, "auth")
      return
    }

    if (_stage === "discover") {
      var wellKnown = _stepUrl.indexOf("/.well-known/caldav") >= 0
      if ((response.status === 404 || response.status === 405) && wellKnown && !_triedRoot) {
        // No well-known support: PROPFIND the server root instead, which
        // still answers current-user-principal on any conforming server.
        _triedRoot = true
        runStep("PROPFIND", "0", origin + "/", Model.propfindDiscoveryBody())
        return
      }
      if (response.status !== 207 && response.status !== 200) {
        failProbe(Model.httpFailure(response.status).error, "http")
        return
      }
      var discovered = Model.parseDiscovery(response.body, origin)
      if (!discovered.ok) { failProbe(discovered.error, "http"); return }
      if (discovered.homeHref !== "") { startCalendars(discovered.homeHref); return }
      if (discovered.principalHref !== "") {
        _stage = "principal"
        runStep("PROPFIND", "0", origin + discovered.principalHref, Model.propfindDiscoveryBody())
        return
      }
      var explicitPath = Model.serverPath(server)
      if (explicitPath !== "" && explicitPath !== "/") {
        // The user pointed at a specific path and it answered without a
        // principal — treat it as the calendar home itself.
        startCalendars(explicitPath)
        return
      }
      failProbe("Could not find a calendar home on this server", "http")
      return
    }

    if (_stage === "principal") {
      if (response.status !== 207 && response.status !== 200) {
        failProbe(Model.httpFailure(response.status, "The principal address").error, "http")
        return
      }
      var principalInfo = Model.parseDiscovery(response.body, origin)
      if (!principalInfo.ok || principalInfo.homeHref === "") {
        failProbe("The calendar server did not report a calendar home", "http")
        return
      }
      startCalendars(principalInfo.homeHref)
      return
    }

    if (_stage === "calendars") {
      if (response.status !== 207 && response.status !== 200) {
        failProbe(Model.httpFailure(response.status, "The calendar home").error, "http")
        return
      }
      var listed = Model.parseCalendarList(response.body, origin)
      if (!listed.ok) { failProbe(listed.error, "http"); return }
      probed = true
      probing = false
      probeError = false
      missingTool = false
      hasCredentials = true
      authenticated = true
      lastError = ""
      calendars = listed.calendars
      if (windowStart !== "" && windowEnd !== "") requestWindow(windowStart, windowEnd, true)
      else if (calendars.length === 0) windowEvents = []
      return
    }

    failProbe("Unexpected discovery state", "http")
  }

  function startCalendars(href) {
    homeHref = href
    _stage = "calendars"
    _redirects = 0
    runStep("PROPFIND", "1", origin + href, Model.propfindCalendarsBody())
  }

  // -------------------------------------------------------------- Window --

  // Asks for a date window (Today/Week/Month/Year all resolve to one of
  // these before calling in). `force` re-fetches even if the window is
  // unchanged — used after the calendar list loads or changes shape.
  // startKey/endKey are inclusive "YYYY-MM-DD" local calendar days; the
  // instant range sent to the server (and used to bound recurrence
  // expansion) is midnight of startKey to midnight of the day after endKey,
  // in this machine's own zone — the same zone every display computation
  // already reads dates in.
  function requestWindow(startKey, endKey, force) {
    if (!active) return
    if (!force && startKey === windowStart && endKey === windowEnd && windowLoadedAtMs > 0) return
    windowStart = startKey
    windowEnd = endKey
    if (!probed || !hasCredentials || !authenticated || origin === "") return
    if (calendars.length === 0) { windowEvents = []; return }
    if (windowLoading) { _windowQueued = true; return }

    var startDate = Model.dateFromKey(startKey)
    var endDate = Model.dateFromKey(endKey)
    if (!startDate || !endDate) return
    var rangeStartMs = startDate.getTime()
    var rangeEndMs = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1).getTime()

    var hrefs = []
    for (var i = 0; i < calendars.length; i++) hrefs.push(calendars[i].id)

    windowLoading = true
    windowError = ""
    _eventsOut = ""
    _eventsErr = ""
    _windowRangeStartMs = rangeStartMs
    _windowRangeEndMs = rangeEndMs
    eventsProcess.command = Model.caldavWindowCommand(origin, hrefs, rangeStartMs, rangeEndMs)
    eventsProcess.running = true
  }

  property bool _windowQueued: false
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
        if (Model.isAuthError(failure.code)) { root.authenticated = false; root.lastError = root.conciseError(failure.error, ""); return }
        root.windowError = root.conciseError(failure.error, "Could not load events")
      } else {
        var byId = {}
        for (var i = 0; i < root.calendars.length; i++) byId[root.calendars[i].id] = root.calendars[i]
        var parsed = Model.parseCalendarWindow(stdout, root._windowRangeStartMs, root._windowRangeEndMs, byId)
        if (!parsed.ok) {
          if (Model.isAuthError(parsed.code)) { root.authenticated = false; root.lastError = root.conciseError(parsed.error, ""); return }
          root.windowError = root.conciseError(parsed.error, "Could not load events")
        } else {
          root.windowEvents = parsed.events
          root.windowError = parsed.error
        }
      }
      if (root._windowQueued) {
        root._windowQueued = false
        root.requestWindow(root.windowStart, root.windowEnd, true)
      }
    }
  }

  // ----------------------------------------------------------- Add event --

  // Builds the iCalendar object from the form fields and PUTs it into the
  // chosen calendar. Returns false (with mutationError set) when the input
  // is not usable; the request's own outcome lands in mutationError /
  // actionStatus asynchronously, followed by a window re-fetch on success.
  function addEvent(fields) {
    if (!active || mutating) return false
    if (!authenticated || origin === "") { mutationError = "Connect a calendar first"; return false }
    var prepared = Model.prepareNewEvent(fields)
    if (!prepared.ok) { mutationError = prepared.error; return false }
    mutationError = ""
    mutating = true
    _putOut = ""
    _putErr = ""
    putProcess.command = Model.caldavPutCommand(origin + prepared.href, prepared.body)
    putProcess.running = true
    return true
  }

  property string _putOut: ""
  property string _putErr: ""

  Process {
    id: putProcess
    running: false
    command: []
    stdout: StdioCollector { id: putStdout; waitForEnd: true; onStreamFinished: root._putOut = text }
    stderr: StdioCollector { id: putStderr; waitForEnd: true; onStreamFinished: root._putErr = text }
    onExited: function(exitCode) {
      var stdout = String(putStdout.text || root._putOut || "")
      var stderr = String(putStderr.text || root._putErr || "")
      root.mutating = false
      if (exitCode !== 0) {
        var failure = Model.parseFailure(stdout, stderr)
        if (Model.isAuthError(failure.code)) root.authenticated = false
        root.mutationError = root.conciseError(failure.error, "Could not save the event")
        return
      }
      var result = Model.parsePutResponse(stdout)
      if (!result.ok) {
        if (Model.isAuthError(result.code)) root.authenticated = false
        root.mutationError = root.conciseError(result.error, "Could not save the event")
        return
      }
      root.mutationError = ""
      root.actionStatus = "Event added"
      actionStatusTimer.restart()
      if (root.windowStart !== "" && root.windowEnd !== "") root.requestWindow(root.windowStart, root.windowEnd, true)
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

  // ---------------------------------------------------- Forget credentials --

  function forgetCredentials() {
    if (forgetProcess.running) return
    forgetProcess.running = true
  }

  Process {
    id: forgetProcess
    running: false
    command: Model.secretClearCommand()
    onExited: function(exitCode) {
      root.hasCredentials = false
      root.authenticated = false
      root.calendars = []
      root.windowEvents = []
      root.server = ""
      root.username = ""
      root.homeHref = ""
      root.actionStatus = "Calendar credentials removed"
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
