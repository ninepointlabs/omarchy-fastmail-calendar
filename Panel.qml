// Adapted from omarchy-hey-calendar's Panel.qml under the MIT terms in
// THIRD_PARTY_NOTICES.md.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The calendar panel: Today/Week/Month/Year view switcher, a day-detail
// overlay (read-only: title, time, location, calendar) opened by clicking any
// day in Week/Month/Year, and a Calendars settings page for per-calendar
// visibility, color and display name. Today embeds the day-detail content
// directly since it's the landing view.
Panel {
  id: root
  moduleName: "ninepointlabs.fastmail-calendar"

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  property date today: new Date()
  readonly property string todayKey: Model.keyForDate(today)
  readonly property int weekStart: Model.normalizedWeekStart(null, Qt.locale().firstDayOfWeek)

  property string currentView: setting("view", "month")
  property int viewYear: today.getFullYear()
  property int viewMonth: today.getMonth()
  property date weekAnchor: today

  property bool dayDetailOpen: false
  property string dayDetailKey: ""
  readonly property date dayDetailDate: dayDetailKey !== "" ? (Model.dateFromKey(dayDetailKey) || today) : today

  property bool calendarSettingsOpen: false

  // One service per shell — every bar widget and every open panel reads the
  // same instance, so switching views never fires more than one Fastmail
  // request at a time. A shell without service support gets a local one.
  readonly property var sharedService: bar && bar.shell && typeof bar.shell.serviceFor === "function"
    ? bar.shell.serviceFor(moduleName) : null
  readonly property var service: sharedService || localService

  function pushSettings() { if (service) service.settings = settings }
  onSettingsChanged: pushSettings()
  onServiceChanged: { pushSettings(); updateWindow() }
  Component.onCompleted: pushSettings()

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color accent: Color.accent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color dim: Qt.darker(foreground, 1.55)

  // ---- Calendar visibility: only events on a visible calendar ever reach
  // the grid pips, the day agendas, or the day detail.
  readonly property var calendarPrefs: service ? service.calendarPrefs : []
  function computeVisibleCalendarIds() {
    var ids = {}
    var prefs = root.calendarPrefs
    for (var i = 0; i < prefs.length; i++) if (prefs[i].visible) ids[prefs[i].id] = true
    return ids
  }
  readonly property var visibleCalendarIds: computeVisibleCalendarIds()

  function computeVisibleEvents() {
    var source = service ? service.windowEvents : []
    var ids = root.visibleCalendarIds
    var out = []
    for (var i = 0; i < source.length; i++) if (ids[source[i].calendarId] === true) out.push(source[i])
    return out
  }
  readonly property var visibleEvents: computeVisibleEvents()

  function computeEventDayKeys() {
    var byDay = Model.eventsByDay(root.visibleEvents)
    var out = ({})
    for (var k in byDay) out[k] = true
    return out
  }
  readonly property var eventDayKeys: computeEventDayKeys()

  function dayEvents(key) {
    return Model.eventsOnDay(root.visibleEvents, key)
  }

  // ---------------------------------------------------------- Navigation --

  function updateWindow() {
    if (!service) return
    if (currentView === "today") {
      var tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
      service.requestWindow(todayKey, Model.keyForDate(tomorrow), false)
    } else if (currentView === "week") {
      var days = Model.weekDays(weekAnchor, weekStart, todayKey)
      service.requestWindow(days[0].key, days[6].key, false)
    } else if (currentView === "month") {
      var weeks = Model.monthGrid(viewYear, viewMonth, weekStart, todayKey)
      service.requestWindow(weeks[0].days[0].key, weeks[weeks.length - 1].days[6].key, false)
    } else if (currentView === "year") {
      service.requestWindow(viewYear + "-01-01", viewYear + "-12-31", false)
    }
  }

  onCurrentViewChanged: updateWindow()
  onViewYearChanged: updateWindow()
  onViewMonthChanged: updateWindow()
  onWeekAnchorChanged: updateWindow()

  function persistSettings(values) {
    var entry = { id: root.moduleName }
    for (var existing in root.settings) if (existing !== "id") entry[existing] = root.settings[existing]
    for (var key in values) entry[key] = values[key]
    root.settings = entry
    if (root.hostWidget && "settings" in root.hostWidget) root.hostWidget.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function setView(name) {
    if (currentView === name) {
      goToToday()
      return
    }
    currentView = name
    persistSettings({ view: name })
  }

  function goToToday() {
    viewYear = today.getFullYear()
    viewMonth = today.getMonth()
    weekAnchor = today
  }

  function moveMonth(delta) {
    var next = Model.stepMonth(viewYear, viewMonth, delta)
    viewYear = next.year
    viewMonth = next.month
  }

  function moveWeek(delta) { weekAnchor = Model.stepWeek(weekAnchor, delta) }
  function moveYear(delta) { viewYear += delta }

  function openDay(key) {
    dayDetailKey = key
    dayDetailOpen = true
    Qt.callLater(function() { if (dayDetailFlick) dayDetailFlick.contentY = 0 })
  }

  function closeDayDetail() {
    dayDetailOpen = false
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function refresh() {
    root.today = new Date()
    if (service) service.refresh()
    updateWindow()
  }

  function launchSetup() {
    if (!bar || !service || !hostWidget) return
    if (!service.tryStartSetup()) return
    bar.run("omarchy-launch-floating-terminal-with-presentation " + Util.shellQuote(Model.setupLaunchCommand(hostWidget.moduleName)))
    close()
  }

  // ---- Calendar prefs: visibility, color, and a custom display name, each
  // written back into settings.calendarPrefs keyed by the calendar's own
  // stable JMAP id so the choice survives a re-fetch even if Fastmail
  // reorders or momentarily omits a calendar.
  function updateCalendarPref(id, patch) {
    if (!service) return
    var json = service.nextCalendarPrefsJson(function(byId) {
      var current = byId[id] || { id: id, visible: true, color: "", name: "" }
      var next = { id: id, visible: current.visible, color: current.color, name: current.name }
      for (var key in patch) next[key] = patch[key]
      byId[id] = next
    })
    persistSettings({ calendarPrefs: json })
  }

  function toggleCalendarVisible(id, visible) { updateCalendarPref(id, { visible: visible }) }
  function setCalendarColor(id, color) { updateCalendarPref(id, { color: color }) }
  function setCalendarName(id, name) { updateCalendarPref(id, { name: name }) }

  readonly property var setupPlanValue: Model.setupPlan(service ? service.hasToken : false, service ? service.authenticated : false)
  readonly property bool needsSetup: service && service.probed && setupPlanValue.needed

  readonly property string statusText: {
    if (!service) return ""
    if (service.actionStatus !== "") return service.actionStatus
    if (service.windowError !== "") return service.windowError
    if (service.lastError !== "") return service.lastError
    return ""
  }
  readonly property bool statusIsError: service && (service.windowError !== "" || (service.lastError !== "" && service.actionStatus === ""))

  implicitWidth: 1
  implicitHeight: 1

  onOpenedChanged: {
    if (!opened) {
      dayDetailOpen = false
      calendarSettingsOpen = false
      goToToday()
      return
    }
    today = new Date()
    if (service) { service.refreshIfStale(); service.checkSetupRunning() }
    updateWindow()
    if (mainFlick) mainFlick.contentY = 0
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  Service {
    id: localService
    active: root.sharedService === null
  }

  SystemClock {
    id: clock
    precision: SystemClock.Minutes
    onDateChanged: {
      root.today = date
      if (root.currentView === "today") root.updateWindow()
    }
  }

  // Auto-retry while setup is showing, the same 3s probe cadence
  // 37signals.hey-derived plugins use.
  Timer {
    interval: 3000
    repeat: true
    running: root.opened && root.needsSetup && !root.service.setupRunning
    onTriggered: if (root.service) root.service.refresh()
  }

  // While setup is running in its floating terminal, keep checking the lock
  // so the button re-enables the moment it finishes (success or Ctrl-C).
  Timer {
    interval: 1500
    repeat: true
    running: root.opened && root.service && root.service.setupRunning
    onTriggered: root.service.checkSetupRunning()
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(620))
    contentHeight: panel.fittedContentHeight(
      root.dayDetailOpen
        ? dayDetailInner.implicitHeight + Style.space(24)
        : (root.calendarSettingsOpen
          ? calendarSettingsInner.implicitHeight + Style.space(24)
          : fixedContent.implicitHeight + mainColumn.implicitHeight + Style.space(24)),
      Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.dayDetailOpen || root.calendarSettingsOpen
      onMoveRequested: function(dx, dy) {
        if (root.currentView === "month") { if (dx !== 0) root.moveMonth(dx); if (dy !== 0) root.moveYear(dy) }
        else if (root.currentView === "week" && dx !== 0) root.moveWeek(dx)
        else if (root.currentView === "year" && dy !== 0) root.moveYear(dy)
      }
      onActivateRequested: root.goToToday()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "t" || t === "T") root.goToToday()
        else if (t === "r" || t === "R") root.refresh()
        else if (t === "1") root.setView("today")
        else if (t === "2") root.setView("week")
        else if (t === "3") root.setView("month")
        else if (t === "4") root.setView("year")
        else if (t === "c" || t === "C") root.calendarSettingsOpen = !root.calendarSettingsOpen
      }

      // ---------------------------------------------------------- Main --
      ColumnLayout {
        id: content
        anchors.fill: parent
        visible: !root.dayDetailOpen && !root.calendarSettingsOpen
        spacing: Style.space(12)

        Column {
          id: fixedContent
          Layout.fillWidth: true
          spacing: Style.space(10)

          Item {
            width: parent.width
            implicitHeight: Math.max(titleColumn.implicitHeight, headerButtons.implicitHeight)

            Column {
              id: titleColumn
              anchors.left: parent.left
              anchors.right: headerButtons.left
              anchors.rightMargin: Style.space(8)
              spacing: Style.space(2)

              Text {
                text: "FASTMAIL CALENDAR"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                font.bold: true
              }

              Text {
                visible: text !== ""
                width: parent.width
                text: root.statusText
                textFormat: Text.PlainText
                color: root.statusIsError ? Color.urgent : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideRight
              }
            }

            Row {
              id: headerButtons
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)

              PanelActionButton {
                visible: !root.needsSetup
                iconText: "󰃭"
                tooltipText: "Calendars"
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: root.calendarSettingsOpen = true
              }

              PanelActionButton {
                iconText: service && service.busy ? "󰑓" : "󰑐"
                tooltipText: "Refresh"
                foreground: root.foreground
                fontFamily: root.fontFamily
                enabled: !service || !service.busy
                onClicked: root.refresh()
              }
            }
          }

          PanelSeparator { foreground: root.foreground }

          Row {
            visible: !root.needsSetup
            width: parent.width
            spacing: Style.space(2)

            Repeater {
              model: [
                { key: "today", label: "TODAY" },
                { key: "week", label: "WEEK" },
                { key: "month", label: "MONTH" },
                { key: "year", label: "YEAR" }
              ]

              Button {
                required property var modelData
                text: modelData.label
                selected: root.currentView === modelData.key
                foreground: root.foreground
                background: "transparent"
                accent: root.accent
                fontFamily: root.fontFamily
                fontSize: Style.font.caption
                horizontalPadding: Style.space(9)
                verticalPadding: Style.space(3)
                onClicked: root.setView(modelData.key)
              }
            }
          }

          // ---- Context nav: month/year steppers, or the week's span.
          Item {
            visible: !root.needsSetup && root.currentView !== "today"
            width: parent.width
            height: navRow.implicitHeight + Style.space(6)

            Item {
              id: navRow
              anchors.horizontalCenter: parent.horizontalCenter
              width: Style.space(220)
              implicitHeight: navLabel.implicitHeight

              Text {
                id: navLabel
                textFormat: Text.PlainText
                anchors.horizontalCenter: parent.horizontalCenter
                text: {
                  if (root.currentView === "month") return Qt.formatDate(new Date(root.viewYear, root.viewMonth, 1), "MMMM yyyy").toUpperCase()
                  if (root.currentView === "year") return String(root.viewYear)
                  if (root.currentView === "week") {
                    var days = Model.weekDays(root.weekAnchor, root.weekStart, root.todayKey)
                    return Qt.formatDate(Model.dateFromKey(days[0].key), "MMM d") + " – " + Qt.formatDate(Model.dateFromKey(days[6].key), "MMM d")
                  }
                  return ""
                }
                color: Qt.darker(root.foreground, 1.3)
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.letterSpacing: 1
              }

              PanelActionButton {
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                iconText: "󰅁"
                tooltipText: "Previous"
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: {
                  if (root.currentView === "month") root.moveMonth(-1)
                  else if (root.currentView === "week") root.moveWeek(-1)
                  else if (root.currentView === "year") root.moveYear(-1)
                }
              }

              PanelActionButton {
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                iconText: "󰅂"
                tooltipText: "Next"
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: {
                  if (root.currentView === "month") root.moveMonth(1)
                  else if (root.currentView === "week") root.moveWeek(1)
                  else if (root.currentView === "year") root.moveYear(1)
                }
              }
            }
          }
        }

        Flickable {
          id: mainFlick
          Layout.fillWidth: true
          Layout.fillHeight: true
          contentWidth: width
          contentHeight: mainColumn.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          Column {
            id: mainColumn
            width: mainFlick.width
            spacing: Style.space(10)

            // ---- Setup prompt (no token / signed out)
            Column {
              visible: root.needsSetup
              width: parent.width
              spacing: Style.space(8)
              topPadding: Style.space(16)
              bottomPadding: Style.space(18)

              Text {
                width: parent.width
                text: root.setupPlanValue.title
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.Wrap
              }

              Text {
                visible: service && service.missingTool
                width: parent.width
                text: "secret-tool (libsecret) and curl are required and should already be installed on Omarchy."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.Wrap
              }

              Button {
                visible: !(service && service.missingTool)
                x: Math.round((parent.width - width) / 2)
                text: service && service.setupRunning ? "Setup running…" : root.setupPlanValue.buttonLabel
                enabled: !(service && (service.setupRunning || service.setupChecking))
                bordered: true
                foreground: root.foreground
                background: Color.popups.background
                accent: root.accent
                fontFamily: root.fontFamily
                fontSize: Style.font.body
                horizontalPadding: Style.spacing.controlPaddingX
                verticalPadding: Style.spacing.controlPaddingY
                onClicked: root.launchSetup()
              }
            }

            // ---- Today: the day-detail content, embedded
            DayDetail {
              visible: !root.needsSetup && root.currentView === "today"
              width: parent.width
              dayDate: root.today
              dateKey: root.todayKey
              events: root.dayEvents(root.todayKey)
              embedded: true
              foreground: root.foreground
              accent: root.accent
              background: Color.popups.background
              fontFamily: root.fontFamily
            }

            // ---- Week: seven compact agenda rows
            Column {
              visible: !root.needsSetup && root.currentView === "week"
              width: parent.width
              spacing: Style.space(4)

              Repeater {
                model: Model.weekDays(root.weekAnchor, root.weekStart, root.todayKey)

                Rectangle {
                  id: weekRow
                  required property var modelData
                  readonly property var rowEvents: root.dayEvents(modelData.key)
                  width: parent.width
                  height: rowContent.implicitHeight + Style.space(14)
                  radius: Style.cornerRadius
                  color: weekMouse.containsMouse ? Style.hoverFillFor(root.foreground, root.accent) : "transparent"
                  border.width: modelData.today ? Style.spacing.hairline : 0
                  border.color: Style.normalBorderFor(root.foreground, root.accent)

                  Row {
                    id: rowContent
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.margins: Style.space(10)
                    spacing: Style.space(10)

                    Column {
                      width: Style.space(56)
                      spacing: Style.space(1)

                      Text {
                        textFormat: Text.PlainText
                        text: Qt.formatDate(Model.dateFromKey(weekRow.modelData.key), "ddd").toUpperCase()
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        font.bold: true
                      }
                      Text {
                        textFormat: Text.PlainText
                        text: weekRow.modelData.day
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.title
                        font.bold: weekRow.modelData.today
                      }
                    }

                    Column {
                      width: parent.width - Style.space(76)
                      spacing: Style.space(2)

                      Text {
                        visible: weekRow.rowEvents.length === 0
                        text: "Nothing scheduled"
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.bodySmall
                      }

                      Repeater {
                        model: weekRow.rowEvents.slice(0, 3)

                        Text {
                          required property var modelData
                          textFormat: Text.PlainText
                          width: parent.width
                          text: (Model.eventTimeLabel(modelData) !== "" ? Model.eventTimeLabel(modelData) + " · " : "") + modelData.title
                          color: root.foreground
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.bodySmall
                          elide: Text.ElideRight
                        }
                      }

                      Text {
                        visible: weekRow.rowEvents.length > 3
                        text: "+" + (weekRow.rowEvents.length - 3) + " more"
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                      }
                    }
                  }

                  MouseArea {
                    id: weekMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.openDay(weekRow.modelData.key)
                  }
                }
              }
            }

            // ---- Month: one grid. Locally-defined delegates read root.*
            // directly rather than being separate reusable components — see
            // omarchy-hey-calendar's Panel.qml for why (a known Quickshell
            // build quirk with cross-file component property assignment).
            Repeater {
              model: !root.needsSetup && root.currentView === "month" ? [root.viewMonth] : []

              Column {
                id: monthBlock
                required property int modelData
                readonly property int monthValue: modelData
                x: Math.round((parent.width - width) / 2)
                spacing: Style.space(3)

                Item {
                  width: parent.width
                  height: monthBlockLabelMouse.height

                  Text {
                    id: monthBlockLabel
                    textFormat: Text.PlainText
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: Qt.formatDate(new Date(root.viewYear, monthBlock.monthValue, 1), "MMMM yyyy").toUpperCase()
                    color: Qt.darker(root.foreground, 1.3)
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    font.letterSpacing: 1
                    font.bold: true
                  }

                  MouseArea {
                    id: monthBlockLabelMouse
                    anchors.centerIn: monthBlockLabel
                    width: monthBlockLabel.implicitWidth + Style.space(12)
                    height: monthBlockLabel.implicitHeight + Style.space(8)
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.goToToday()
                  }
                }

                Row {
                  spacing: Style.space(2)
                  Item { width: Style.space(28); height: Style.space(14) }
                  Item { width: Style.space(10); height: Style.space(14) }

                  Repeater {
                    model: Model.weekdayOrder(root.weekStart)

                    Text {
                      textFormat: Text.PlainText
                      required property var modelData
                      width: Style.space(52)
                      height: Style.space(14)
                      horizontalAlignment: Text.AlignHCenter
                      verticalAlignment: Text.AlignVCenter
                      text: Qt.locale("en_US").dayName(modelData, Locale.ShortFormat).substring(0, 2).toUpperCase()
                      color: Qt.darker(root.foreground, 1.5)
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: true
                    }
                  }
                }

                Repeater {
                  model: Model.monthGrid(root.viewYear, monthBlock.monthValue, root.weekStart, root.todayKey)

                  Row {
                    required property var modelData
                    spacing: Style.space(2)

                    Text {
                      textFormat: Text.PlainText
                      width: Style.space(28)
                      height: Style.space(44)
                      horizontalAlignment: Text.AlignHCenter
                      verticalAlignment: Text.AlignVCenter
                      text: modelData.week
                      color: Qt.darker(root.foreground, 1.9)
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }

                    Item { width: Style.space(10); height: Style.space(44) }

                    Repeater {
                      model: modelData.days

                      Rectangle {
                        id: monthBlockCell
                        required property var modelData
                        readonly property bool hasEvent: root.eventDayKeys[modelData.key] === true

                        width: Style.space(52)
                        height: Style.space(44)
                        radius: Style.cornerRadius
                        color: monthBlockDayMouse.containsMouse ? Style.hoverFillFor(root.foreground, root.accent) : "transparent"
                        border.width: modelData.today ? Style.spacing.hairline : 0
                        border.color: Style.normalBorderFor(root.foreground, root.accent)

                        Text {
                          textFormat: Text.PlainText
                          anchors.centerIn: parent
                          anchors.verticalCenterOffset: monthBlockCell.hasEvent ? -Style.space(3) : 0
                          text: monthBlockCell.modelData.day
                          color: monthBlockCell.modelData.inMonth
                            ? (monthBlockCell.modelData.weekend ? Qt.darker(root.foreground, 1.45) : root.foreground)
                            : Qt.darker(root.foreground, 2.2)
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.body
                          font.bold: monthBlockCell.modelData.today
                        }

                        Rectangle {
                          visible: monthBlockCell.hasEvent
                          anchors.horizontalCenter: parent.horizontalCenter
                          anchors.bottom: parent.bottom
                          anchors.bottomMargin: Style.space(5)
                          width: Style.space(4); height: Style.space(4); radius: width / 2
                          color: root.accent
                        }

                        MouseArea {
                          id: monthBlockDayMouse
                          anchors.fill: parent
                          hoverEnabled: true
                          cursorShape: Qt.PointingHandCursor
                          onClicked: root.openDay(monthBlockCell.modelData.key)
                        }
                      }
                    }
                  }
                }
              }
            }

            Grid {
              visible: !root.needsSetup && root.currentView === "year"
              x: Math.round((parent.width - width) / 2)
              columns: 3
              rowSpacing: Style.space(14)
              columnSpacing: Style.space(18)

              Repeater {
                model: 12

                Column {
                  id: yearBlock
                  required property int index
                  spacing: Style.space(3)

                  Text {
                    textFormat: Text.PlainText
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: Model.monthName(yearBlock.index).toUpperCase()
                    color: Qt.darker(root.foreground, 1.2)
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.letterSpacing: 1
                    font.bold: true

                    MouseArea {
                      anchors.fill: parent
                      anchors.margins: -Style.space(4)
                      cursorShape: Qt.PointingHandCursor
                      onClicked: { root.viewMonth = yearBlock.index; root.setView("month") }
                    }
                  }

                  Repeater {
                    model: Model.monthGrid(root.viewYear, yearBlock.index, root.weekStart, root.todayKey)

                    Row {
                      required property var modelData
                      spacing: 1

                      Repeater {
                        model: modelData.days

                        Rectangle {
                          id: yearBlockCell
                          required property var modelData
                          readonly property bool hasEvent: root.eventDayKeys[modelData.key] === true

                          width: Style.space(20)
                          height: Style.space(18)
                          radius: Style.cornerRadius
                          color: yearBlockDayMouse.containsMouse ? Style.hoverFillFor(root.foreground, root.accent) : "transparent"
                          border.width: modelData.today ? Style.spacing.hairline : 0
                          border.color: Style.normalBorderFor(root.foreground, root.accent)

                          Text {
                            textFormat: Text.PlainText
                            anchors.centerIn: parent
                            text: yearBlockCell.modelData.day
                            color: yearBlockCell.modelData.inMonth
                              ? (yearBlockCell.modelData.weekend ? Qt.darker(root.foreground, 1.45) : root.foreground)
                              : Qt.darker(root.foreground, 2.2)
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            font.bold: yearBlockCell.modelData.today
                          }

                          Rectangle {
                            visible: yearBlockCell.hasEvent
                            anchors.horizontalCenter: parent.horizontalCenter
                            anchors.bottom: parent.bottom
                            anchors.bottomMargin: Style.space(1)
                            width: Style.space(3); height: Style.space(3); radius: width / 2
                            color: root.accent
                          }

                          MouseArea {
                            id: yearBlockDayMouse
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.openDay(yearBlockCell.modelData.key)
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // -------------------------------------------------------- Day detail --
      ColumnLayout {
        id: dayDetailPage
        anchors.fill: parent
        visible: root.dayDetailOpen
        spacing: Style.space(12)
        Keys.priority: Keys.AfterItem
        Keys.onEscapePressed: function(event) {
          root.closeDayDetail()
          event.accepted = true
        }

        Flickable {
          id: dayDetailFlick
          Layout.fillWidth: true
          Layout.fillHeight: true
          contentWidth: width
          contentHeight: dayDetailInner.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          DayDetail {
            id: dayDetailInner
            width: dayDetailFlick.width
            dayDate: root.dayDetailDate
            dateKey: root.dayDetailKey
            events: root.dayEvents(root.dayDetailKey)
            embedded: false
            foreground: root.foreground
            accent: root.accent
            background: Color.popups.background
            fontFamily: root.fontFamily
            onCloseRequested: root.closeDayDetail()
          }
        }
      }

      // ---------------------------------------------------- Calendars page --
      ColumnLayout {
        id: calendarSettingsPage
        anchors.fill: parent
        visible: root.calendarSettingsOpen
        spacing: Style.space(12)
        Keys.priority: Keys.AfterItem
        Keys.onEscapePressed: function(event) {
          root.calendarSettingsOpen = false
          event.accepted = true
        }

        Item {
          Layout.fillWidth: true
          implicitHeight: Math.max(calendarsHeaderText.implicitHeight, calendarsCloseButton.implicitHeight)

          Text {
            id: calendarsHeaderText
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.right: calendarsCloseButton.left
            anchors.rightMargin: Style.space(8)
            text: "CALENDARS"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
            font.bold: true
          }

          PanelActionButton {
            id: calendarsCloseButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: "󰅖"
            tooltipText: "Close"
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: root.calendarSettingsOpen = false
          }
        }

        PanelSeparator { foreground: root.foreground }

        Flickable {
          id: calendarSettingsFlick
          Layout.fillWidth: true
          Layout.fillHeight: true
          contentWidth: width
          contentHeight: calendarSettingsInner.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          Column {
            id: calendarSettingsInner
            width: calendarSettingsFlick.width
            spacing: Style.space(12)

            Text {
              visible: root.calendarPrefs.length === 0
              text: "No calendars yet."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }

            Repeater {
              model: root.calendarPrefs

              Column {
                id: calendarRow
                required property var modelData
                width: parent.width
                spacing: Style.space(6)
                bottomPadding: Style.space(8)

                Row {
                  width: parent.width
                  spacing: Style.space(8)

                  Toggle {
                    anchors.verticalCenter: parent.verticalCenter
                    checked: calendarRow.modelData.visible
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                    onClicked: root.toggleCalendarVisible(calendarRow.modelData.id, !calendarRow.modelData.visible)
                  }

                  Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: Style.space(10); height: Style.space(10); radius: width / 2
                    color: calendarRow.modelData.color
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: calendarRow.modelData.serverName
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                }

                TextField {
                  width: parent.width
                  placeholderText: calendarRow.modelData.serverName + " (display name)"
                  foreground: root.foreground
                  accent: root.accent
                  maximumLength: Model.remoteNameCharacterLimit
                  onEditingFinished: root.setCalendarName(calendarRow.modelData.id, text)
                  Binding on text {
                    value: calendarRow.modelData.name === calendarRow.modelData.serverName ? "" : calendarRow.modelData.name
                  }
                }

                Row {
                  spacing: Style.space(6)

                  Repeater {
                    model: Model.calendarColorPalette

                    Rectangle {
                      required property var modelData
                      width: Style.space(16); height: Style.space(16); radius: width / 2
                      color: modelData
                      border.width: calendarRow.modelData.color === modelData ? Style.spacing.hairline * 2 : 0
                      border.color: root.foreground

                      MouseArea {
                        anchors.fill: parent
                        anchors.margins: -Style.space(2)
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.setCalendarColor(calendarRow.modelData.id, modelData)
                      }
                    }
                  }
                }
              }
            }

            PanelSeparator { visible: root.calendarPrefs.length > 0; foreground: root.foreground }

            Button {
              visible: service && service.hasToken
              text: "FORGET FASTMAIL TOKEN"
              foreground: root.dim
              background: "transparent"
              accent: root.accent
              fontFamily: root.fontFamily
              fontSize: Style.font.caption
              horizontalPadding: Style.space(4)
              verticalPadding: Style.space(2)
              onClicked: if (service) service.forgetToken()
            }
          }
        }
      }
    }
  }
}
