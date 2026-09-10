// Adapted from omarchy-hey-calendar's BarWidget.qml under the MIT terms in
// THIRD_PARTY_NOTICES.md.
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The bar chip: today's date, or the next upcoming event when one exists and
// the setting allows it — then hosts the full Today/Week/Month/Year panel on
// click, the same Loader + hostWidget handoff omarchy.clock uses so this
// widget can stand in for the panel as the bar's popout identity.
BarWidget {
  id: root
  moduleName: "ninepointlabs.fastmail-calendar"

  property date today: clock.date
  readonly property string todayKey: Model.keyForDate(today)

  readonly property bool showNextEvent: setting("showNextEvent", true) === true

  readonly property var service: panelLoader.item ? panelLoader.item.service : null
  readonly property var todaysEvents: service ? Model.eventsOnDay(panelLoader.item.visibleEvents, todayKey) : []
  readonly property string nextEvent: showNextEvent && service ? Model.nextEventLabel(todaysEvents, Date.now()) : ""

  // ---- Label format. Right-click walks date/date+time layouts, written back
  // to shell.json so it's what's shown from then on — same idea as
  // omarchy.clock's own bar label.
  readonly property string configuredFormat: vertical ? setting("verticalFormat", "ddd\n—\nd") : setting("format", "ddd d MMM")
  readonly property var formatPresets: vertical
    ? ["ddd\n—\nd", "dd\nMMM", "MMM\nd", "HH\n—\nmm"]
    : ["ddd d MMM", "dddd, MMMM d", "d MMM yyyy", "MMM d"]

  function cycleFormat() {
    var current = String(configuredFormat)
    var index = formatPresets.indexOf(current)
    var next = formatPresets[(index + 1) % formatPresets.length]
    if (next === current) return

    var entry = { id: root.moduleName }
    for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    entry[vertical ? "verticalFormat" : "format"] = next
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  readonly property string dateText: Qt.formatDateTime(today, configuredFormat)
  readonly property string displayText: nextEvent !== "" ? nextEvent : dateText
  readonly property var verticalLines: dateText.split("\n")

  function refresh() {
    today = new Date()
    if (panelLoader.item && panelLoader.item.refresh) panelLoader.item.refresh()
  }

  // ---- Panel popup. Shape contract for shell.summon/hide/toggle routing:
  //      Bar.findPanelWidget requires open/close/opened on the bar-widget root.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }

  readonly property real openPanelIndicatorWidth: button.labelWidth
  readonly property real openPanelIndicatorHeight: Math.max(Style.space(10), Math.round(Style.bar.iconSlot * 0.55))

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  SystemClock {
    id: clock
    precision: SystemClock.Minutes
    onDateChanged: root.today = date
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "ninepointlabs.fastmail-calendar"

    function refresh(): void { root.broadcast("refresh") }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
    // Called back by the floating setup terminal's completion trap once the
    // credential-capture script exits, success or cancel either way, so the
    // panel's setup state and "setup running" lock re-check immediately
    // rather than waiting for the next 3s poll.
    function setupFinished(): string {
      if (root.service) { root.service.finishSetup(); root.service.refresh() }
      return "ok"
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.vertical ? "" : root.displayText
    labelVisible: !root.vertical
    hasVisualContent: root.vertical ? root.verticalLines.length > 0 : text !== ""
    fixedHeight: root.vertical ? root.verticalLines.length * Style.bar.iconSlot : -1
    horizontalMargin: 8.75
    verticalPadding: 8.75
    tooltipText: root.nextEvent !== "" ? "Fastmail Calendar · " + root.nextEvent : "Fastmail Calendar"

    onPressed: function(b) {
      if (b === Qt.RightButton) root.cycleFormat()
      else if (b === Qt.MiddleButton) root.refresh()
      else root.togglePanel()
    }

    Column {
      visible: root.vertical
      anchors.fill: parent

      Repeater {
        model: root.verticalLines

        OpticalGlyph {
          required property string modelData
          width: button.width
          height: Style.bar.iconSlot
          text: modelData
          fontFamily: button.fontFamily
          fontSize: button.fontSize
          color: button.foreground
        }
      }
    }
  }
}
