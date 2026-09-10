// Adapted from omarchy-hey-calendar's DayDetail.qml under the MIT terms in
// THIRD_PARTY_NOTICES.md.
import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "Model.js" as Model

// One day's events, plus an add-event form (the add form and its lenient
// time parsing are adapted from omarchy-hey-calendar's DayDetail.qml). Used
// two ways by Panel.qml: embedded directly as the Today view's body, and as
// the content of the day-detail overlay opened by clicking a day in
// Week/Month/Year. `events` is already filtered to visible calendars by the
// caller; `calendarOptions` are the visible calendars the form can write to.
Item {
  id: root

  property var dayDate: new Date()
  property string dateKey: ""
  property var events: []
  property bool embedded: false
  property var service: null
  property var calendarOptions: []

  property color foreground: Color.foreground
  property color accent: Color.accent
  property color background: Color.popups.background
  property string fontFamily: Style.font.family
  readonly property color dim: Qt.darker(foreground, 1.55)

  signal closeRequested()

  readonly property var safeColorNames: ["black", "blue", "purple", "green", "red", "orange",
    "yellow", "pink", "brown", "teal", "indigo", "gray", "grey", "cyan", "magenta"]

  function eventDotColor(event) {
    var color = String(event && event.calendarColor || "")
    if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color
    var lower = color.toLowerCase()
    return safeColorNames.indexOf(lower) !== -1 ? lower : root.accent
  }

  // ---- Add-event form
  property bool showAddForm: false
  property string addTitle: ""
  property bool addAllDay: false
  property string addStart: "09:00"
  property string addEnd: "10:00"
  property string addLocation: ""
  property string addCalendar: ""
  readonly property string addCalendarEffective: {
    for (var i = 0; i < calendarOptions.length; i++) if (calendarOptions[i].value === addCalendar) return addCalendar
    return calendarOptions.length > 0 ? calendarOptions[0].value : ""
  }

  // Reads whatever was typed leniently ("9", "9:30am", "21:30") rather than
  // requiring exact zero-padded 24h input, and says so when it cannot.
  readonly property bool addValid: addTitle.trim() !== "" && addCalendarEffective !== ""
    && (addAllDay || Model.normalizeTimeOfDay(addStart) !== "")
  readonly property bool addTimeUnreadable: !addAllDay
    && ((addStart.trim() !== "" && Model.normalizeTimeOfDay(addStart) === "") || (addEnd.trim() !== "" && Model.normalizeTimeOfDay(addEnd) === ""))

  function resetAddForm() {
    addTitle = ""
    addAllDay = false
    addStart = "09:00"
    addEnd = "10:00"
    addLocation = ""
    showAddForm = false
    if (service) service.mutationError = ""
  }

  function submitAdd() {
    if (!addValid || !service) return
    var ok = service.addEvent({
      title: addTitle, dateKey: dateKey, allDay: addAllDay,
      startTime: addStart, endTime: addEnd,
      location: addLocation, calendarId: addCalendarEffective
    })
    if (ok) resetAddForm()
  }

  width: parent ? parent.width : 400
  implicitHeight: innerColumn.implicitHeight
  height: implicitHeight

  Column {
    id: innerColumn
    width: parent.width
    spacing: Style.space(14)

    Item {
      width: parent.width
      height: Math.max(headerText.implicitHeight, closeButton.implicitHeight)

      Text {
        id: headerText
        textFormat: Text.PlainText
        anchors.left: parent.left
        anchors.right: root.embedded ? parent.right : closeButton.left
        anchors.rightMargin: root.embedded ? 0 : Style.space(8)
        text: Qt.formatDate(root.dayDate, "dddd, MMMM d")
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.title
        font.bold: true
        elide: Text.ElideRight
      }

      PanelActionButton {
        id: closeButton
        visible: !root.embedded
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        iconText: "󰅖"
        tooltipText: "Close"
        foreground: root.foreground
        fontFamily: root.fontFamily
        onClicked: root.closeRequested()
      }
    }

    PanelSeparator { foreground: root.foreground }

    Column {
      width: parent.width
      spacing: Style.space(8)

      Text {
        visible: root.events.length === 0
        text: "Nothing on the calendar."
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }

      Repeater {
        model: root.events

        Row {
          id: eventRow
          required property var modelData
          width: parent.width
          height: Math.max(eventBody.implicitHeight, Style.space(22))
          spacing: Style.space(8)

          Rectangle {
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(7); height: Style.space(7); radius: width / 2
            color: root.eventDotColor(eventRow.modelData)
          }

          Column {
            id: eventBody
            width: parent.width - Style.space(15)
            spacing: Style.space(1)

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: eventRow.modelData.title
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              elide: Text.ElideRight
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: [
                Model.eventTimeRangeLabel(eventRow.modelData),
                eventRow.modelData.location,
                eventRow.modelData.calendarName
              ].filter(function(s) { return s !== "" }).join(" · ")
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }
        }
      }
    }

    // ---- Add event
    Column {
      visible: root.service !== null && root.calendarOptions.length > 0
      width: parent.width
      spacing: Style.space(6)
      topPadding: Style.space(4)

      Button {
        visible: !root.showAddForm
        text: "+ ADD EVENT"
        foreground: root.dim
        background: "transparent"
        accent: root.accent
        fontFamily: root.fontFamily
        fontSize: Style.font.caption
        horizontalPadding: Style.space(4)
        verticalPadding: Style.space(2)
        onClicked: root.showAddForm = true
      }

      Column {
        visible: root.showAddForm
        width: parent.width
        spacing: Style.space(6)

        TextField {
          id: titleField
          width: parent.width
          placeholderText: "New event title"
          foreground: root.foreground
          accent: root.accent
          maximumLength: Model.eventTitleInputLimit
          onTextChanged: root.addTitle = text
          onAccepted: root.submitAdd()
          Binding on text { value: root.addTitle }
          Connections {
            target: root
            function onShowAddFormChanged() { if (root.showAddForm) Qt.callLater(function() { titleField.forceActiveFocus() }) }
          }
        }

        Toggle {
          width: parent.width
          label: "All day"
          checked: root.addAllDay
          foreground: root.foreground
          accent: root.accent
          fontFamily: root.fontFamily
          onClicked: root.addAllDay = !root.addAllDay
        }

        Row {
          visible: !root.addAllDay
          spacing: Style.space(8)

          TextField {
            width: Style.space(90)
            placeholderText: "09:00"
            foreground: root.foreground
            accent: root.accent
            onTextChanged: root.addStart = text
            onAccepted: root.submitAdd()
            Binding on text { value: root.addStart }
          }

          Text { anchors.verticalCenter: parent.verticalCenter; text: "–"; color: root.dim; font.family: root.fontFamily }

          TextField {
            width: Style.space(90)
            placeholderText: "10:00"
            foreground: root.foreground
            accent: root.accent
            onTextChanged: root.addEnd = text
            onAccepted: root.submitAdd()
            Binding on text { value: root.addEnd }
          }
        }

        Text {
          visible: root.addTimeUnreadable
          width: parent.width
          text: "Times like 9:00, 9:30am, or 21:30 all work — that one isn't readable."
          color: Color.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.Wrap
        }

        TextField {
          width: parent.width
          placeholderText: "Location (optional)"
          foreground: root.foreground
          accent: root.accent
          maximumLength: Model.eventLocationInputLimit
          onTextChanged: root.addLocation = text
          onAccepted: root.submitAdd()
          Binding on text { value: root.addLocation }
        }

        Dropdown {
          visible: root.calendarOptions.length > 1
          width: parent.width
          showLabel: false
          options: root.calendarOptions
          foreground: root.foreground
          background: root.background
          accent: root.accent
          fontFamily: root.fontFamily
          onChanged: function(value) { root.addCalendar = value }
          Binding on value { value: root.addCalendarEffective }
        }

        Text {
          visible: root.service !== null && root.service.mutationError !== ""
          width: parent.width
          text: root.service ? root.service.mutationError : ""
          textFormat: Text.PlainText
          color: Color.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.Wrap
        }

        Row {
          spacing: Style.space(8)

          Button {
            text: root.service && root.service.mutating ? "SAVING…" : "ADD"
            bordered: true
            enabled: root.addValid && !(root.service && root.service.mutating)
            foreground: root.foreground
            background: root.background
            accent: root.accent
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            horizontalPadding: Style.space(10)
            verticalPadding: Style.space(4)
            onClicked: root.submitAdd()
          }

          Button {
            text: "CANCEL"
            foreground: root.dim
            background: "transparent"
            accent: root.accent
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            horizontalPadding: Style.space(10)
            verticalPadding: Style.space(4)
            onClicked: root.resetAddForm()
          }
        }
      }
    }
  }
}
