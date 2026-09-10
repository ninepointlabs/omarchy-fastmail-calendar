// Adapted from omarchy-hey-calendar's DayDetail.qml under the MIT terms in
// THIRD_PARTY_NOTICES.md.
import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// One day's events, read-only. Used two ways by Panel.qml: embedded directly
// as the Today view's body, and as the content of the day-detail overlay
// opened by clicking a day in Week/Month/Year. `events` is already filtered
// to visible calendars by the caller.
Item {
  id: root

  property var dayDate: new Date()
  property string dateKey: ""
  property var events: []
  property bool embedded: false

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
  }
}
