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

  readonly property bool busy: toolsProbing || probing || windowLoading || forgetProcess.running || mutating

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function conciseError(value, fallback) {
    var text = Model.cleanText(value || fallback || "Calendar request failed", Model.remoteExcerptCharacterLimit)
    return text.length > 200 ? text.substring(0, 197) + "…" : text
  }

  // ------------------------------------------------- Trusted tool table --

  // Every external program this plugin runs is bound to an absolute path in a
  // fixed system directory (see Model.js's "Trusted executable resolution").
  // The table is built once, here, by running Model.toolResolutionScript —
  // a builtin-only script — under each absolute bash candidate in turn. Until
  // it resolves, every command builder returns an empty command and nothing
  // starts: no capture, no keyring read, no request, no setup. There is no
  // PATH fallback at any point.
  property var tools: ({})
  property bool toolsReady: false
  property bool toolsProbing: false
  property string toolsError: ""
  readonly property string missingToolMessage: toolsError !== "" ? toolsError
    : "secret-tool (libsecret) and curl are required and should already be installed on Omarchy."

  // The environment every subprocess gets in place of the session's own: a
  // fixed PATH, a pinned locale, and only the session-bus handles libsecret
  // needs to reach the keyring daemon. Nothing else the viewer's shell
  // exported — LD_PRELOAD, http_proxy, CURL_HOME — is carried over.
  readonly property var processEnvironment: Model.minimalEnvironment({
    XDG_RUNTIME_DIR: Quickshell.env("XDG_RUNTIME_DIR"),
    DBUS_SESSION_BUS_ADDRESS: Quickshell.env("DBUS_SESSION_BUS_ADDRESS"),
    HOME: Quickshell.env("HOME"),
    USER: Quickshell.env("USER")
  })

  readonly property var toolProbeEnvironment: Model.probeEnvironment()

  // The process supervisor ships in this checkout (bin/bounded-run). Model
  // validates the path; anything that is not a plain local file path leaves
  // the tool table incomplete, and nothing runs.
  readonly property string supervisorScript: {
    var text = String(Qt.resolvedUrl("bin/bounded-run"))
    if (text.indexOf("file://") !== 0) return ""
    try { return decodeURIComponent(text.substring(7)) } catch (error) { return "" }
  }

  property int _bashCandidate: 0
  property bool _probeStarted: false
  property bool _probeSettled: false
  property string _probeOut: ""

  function resolveTools() {
    if (toolsReady || toolsProbing) return
    _bashCandidate = 0
    startToolProbe()
  }

  function startToolProbe() {
    var candidates = Model.bashCandidates
    if (_bashCandidate >= candidates.length) {
      failToolResolution("No shell found in " + Model.trustedBinaryDirectories.join(", ")
        + " — the calendar will not run commands through the session PATH")
      return
    }
    var command = Model.toolResolutionCommand(candidates[_bashCandidate], supervisorScript)
    if (command.length === 0) { _bashCandidate++; startToolProbe(); return }
    toolsProbing = true
    _probeStarted = false
    _probeSettled = false
    _probeOut = ""
    toolProbe.command = command
    toolProbe.running = true
  }

  // Fail closed: the table stays empty, so every builder keeps returning an
  // empty command, and the panel shows why instead of a bare "not connected".
  function failToolResolution(message) {
    toolsProbing = false
    toolsReady = false
    tools = ({})
    toolsError = message
    probed = true
    probing = false
    missingTool = true
    hasCredentials = false
    authenticated = false
    lastError = conciseError(message, "Required tools are missing")
  }

  Process {
    id: toolProbe
    running: false
    command: []
    clearEnvironment: true
    environment: root.toolProbeEnvironment
    stdout: StdioCollector { id: toolProbeStdout; waitForEnd: true; onStreamFinished: root._probeOut = text }
    onStarted: root._probeStarted = true
    onExited: function(exitCode) {
      if (root._probeSettled) return
      root._probeSettled = true
      // Started but said nothing usable, or never started at all: try the
      // next absolute candidate rather than widening the search.
      if (!root._probeStarted) { root._bashCandidate++; root.startToolProbe(); return }
      var table = Model.parseToolTable(String(toolProbeStdout.text || root._probeOut || ""), root.supervisorScript)
      if (!table.ok) {
        root.failToolResolution("The calendar needs tools it could not find. " + table.error)
        return
      }
      root.toolsProbing = false
      root.toolsError = ""
      root.missingTool = false
      root.tools = table.tools
      root.toolsReady = true
      if (root.active) root.refresh()
    }
    // A candidate that is not on disk never starts, so `running` falls back
    // to false without an exit. Move on to the next candidate.
    onRunningChanged: {
      if (running || root._probeSettled || root._probeStarted) return
      root._probeSettled = true
      root._bashCandidate++
      root.startToolProbe()
    }
  }

  // -------------------------------------------------------------- Probe --

  function refresh() {
    if (!active || probing) return
    if (!toolsReady) { resolveTools(); return }
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
    clearEnvironment: true
    environment: root.processEnvironment
    command: Model.accountInfoCommand(root.tools)
    stdout: StdioCollector { id: accountStdout; waitForEnd: true; onStreamFinished: root._accountOut = text }
    onExited: function(exitCode) {
      // A deadline, a size cap or a supervisor that could not start is not
      // "no credentials": report it as such instead of sending the viewer
      // back to setup.
      if (Model.isSupervisorOutcome(exitCode)) {
        var failure = Model.captureFailure(exitCode, "", "")
        root.failProbe(failure.error, failure.code)
        return
      }
      var info
      try { info = Model.parseAccountInfo(String(accountStdout.text || root._accountOut || "")) } catch (error) { info = { server: "", username: "" } }
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
  property string _stepBoundary: ""

  function runStep(method, depth, url, body) {
    _stepUrl = url
    _stepOut = ""
    _stepErr = ""
    _stepBoundary = Model.newBoundary()
    stepProcess.command = Model.caldavRequestCommand(tools, method, depth, url, body, _stepBoundary)
    stepProcess.running = true
  }

  Process {
    id: stepProcess
    running: false
    clearEnvironment: true
    environment: root.processEnvironment
    command: []
    stdout: StdioCollector { id: stepStdout; waitForEnd: true; onStreamFinished: root._stepOut = text }
    stderr: StdioCollector { id: stepStderr; waitForEnd: true; onStreamFinished: root._stepErr = text }
    onExited: function(exitCode) {
      // A parser throw must never leave the service stuck "probing".
      try {
        root.finishStep(exitCode, String(stepStdout.text || root._stepOut || ""), String(stepStderr.text || root._stepErr || ""))
      } catch (error) {
        root.failProbe("Could not read the calendar server's answer", "http")
      }
    }
  }

  function finishStep(exitCode, stdout, stderr) {
    if (exitCode !== 0) {
      var failure = Model.captureFailure(exitCode, stdout, stderr)
      failProbe(failure.error, failure.code)
      return
    }
    var response = Model.parseHttpResponse(stdout, undefined, _stepBoundary)
    if (!response.ok) { failProbe(response.error, "http"); return }

    if (Model.isRedirectStatus(response.status)) {
      // Only within the configured server's own domain — the credentials
      // travel with the next request.
      var target = Model.redirectAllowed(response.redirect, server)
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
    if (!active || !toolsReady) return
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
    _windowBoundary = Model.newBoundary()
    eventsProcess.command = Model.caldavWindowCommand(tools, origin, hrefs, rangeStartMs, rangeEndMs, _windowBoundary)
    eventsProcess.running = true
  }

  property bool _windowQueued: false
  property string _windowBoundary: ""
  property double _windowRangeStartMs: 0
  property double _windowRangeEndMs: 0
  property string _eventsOut: ""
  property string _eventsErr: ""

  Process {
    id: eventsProcess
    running: false
    clearEnvironment: true
    environment: root.processEnvironment
    command: []
    stdout: StdioCollector { id: eventsStdout; waitForEnd: true; onStreamFinished: root._eventsOut = text }
    stderr: StdioCollector { id: eventsStderr; waitForEnd: true; onStreamFinished: root._eventsErr = text }
    onExited: function(exitCode) {
      var stdout = String(eventsStdout.text || root._eventsOut || "")
      var stderr = String(eventsStderr.text || root._eventsErr || "")
      root.windowLoading = false
      root.windowLoadedAtMs = Date.now()
      if (exitCode !== 0) {
        var failure = Model.captureFailure(exitCode, stdout, stderr)
        if (Model.isAuthError(failure.code)) { root.authenticated = false; root.lastError = root.conciseError(failure.error, ""); return }
        root.windowError = root.conciseError(failure.error, "Could not load events")
      } else {
        var byId = {}
        for (var i = 0; i < root.calendars.length; i++) byId[root.calendars[i].id] = root.calendars[i]
        var parsed
        try {
          parsed = Model.parseCalendarWindow(stdout, root._windowRangeStartMs, root._windowRangeEndMs, byId, root._windowBoundary)
        } catch (error) {
          parsed = { ok: false, error: "Could not read the events the server returned", code: "", events: [] }
        }
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
    _putBoundary = Model.newBoundary()
    putProcess.command = Model.caldavPutCommand(tools, origin + prepared.href, prepared.body, _putBoundary)
    putProcess.running = true
    return true
  }

  property string _putOut: ""
  property string _putErr: ""
  property string _putBoundary: ""

  Process {
    id: putProcess
    running: false
    clearEnvironment: true
    environment: root.processEnvironment
    command: []
    stdout: StdioCollector { id: putStdout; waitForEnd: true; onStreamFinished: root._putOut = text }
    stderr: StdioCollector { id: putStderr; waitForEnd: true; onStreamFinished: root._putErr = text }
    onExited: function(exitCode) {
      var stdout = String(putStdout.text || root._putOut || "")
      var stderr = String(putStderr.text || root._putErr || "")
      root.mutating = false
      if (exitCode !== 0) {
        var failure = Model.captureFailure(exitCode, stdout, stderr)
        if (Model.isAuthError(failure.code)) root.authenticated = false
        root.mutationError = root.conciseError(failure.error, "Could not save the event")
        return
      }
      var result = Model.parsePutResponse(stdout, root._putBoundary)
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
    if (!toolsReady || setupRunning || setupChecking) return false
    setupRunning = true
    return true
  }

  function finishSetup() {
    setupRunning = false
  }

  function checkSetupRunning() {
    if (!toolsReady) return
    if (!setupLockProcess.running) setupLockProcess.running = true
  }

  Process {
    id: setupLockProcess
    running: false
    clearEnvironment: true
    environment: root.processEnvironment
    command: Model.setupLockCheckCommand(root.tools)
    onExited: function(exitCode) {
      root.setupRunning = exitCode === 1
      if (Model.isSupervisorOutcome(exitCode))
        root.lastError = "Could not check whether calendar setup is already running"
      else if (exitCode !== 0 && exitCode !== 1)
        root.lastError = "Setup needs a private runtime directory ($XDG_RUNTIME_DIR, mode 700) to run"
    }
  }

  // ---------------------------------------------------- Forget credentials --

  function forgetCredentials() {
    if (!toolsReady || forgetProcess.running) return
    forgetProcess.running = true
  }

  Process {
    id: forgetProcess
    running: false
    clearEnvironment: true
    environment: root.processEnvironment
    command: Model.secretClearCommand(root.tools)
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
