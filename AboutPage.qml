import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "About.js" as About

// The body of the panel's About page: who made the plugin, its version and
// license, where to get help, and what it does with your data. Panel.qml
// hosts it under a CALENDARS-style header (info button, `I`, or the `about`
// IPC call). Nothing here runs a process or touches the network: the
// version is read from manifest.json, the texts from LICENSE and
// THIRD_PARTY_NOTICES.md, and the toolkit versions are probed in-process.
Column {
  id: root

  property string pluginDir: ""
  property color foreground: Color.foreground
  property color accent: Color.accent
  property string fontFamily: Style.font.family
  readonly property color dim: Qt.darker(foreground, 1.55)

  property bool showLicense: false
  property bool showNotices: false
  property string copiedLabel: ""

  readonly property string version: About.manifestVersion(manifestFile.loaded ? manifestFile.text() : "")
  readonly property string quickshellVersion: About.probedVersion(function(a, b) { return Quickshell.hasVersion(a, b) }, 0)
  readonly property string qtVersion: About.probedVersion(function(a, b) { return Quickshell.hasQtVersion(a, b) }, 6)
  readonly property string details: About.details(root.version, root.quickshellVersion, root.qtVersion,
    (Quickshell.env("XDG_CURRENT_DESKTOP") || "unknown desktop") + ", " + Qt.platform.pluginName)
  readonly property real labelWidth: Style.space(84)
  readonly property real valueWidth: width - labelWidth - Style.space(10)

  // Back to the collapsed state, so the next visit starts from the top.
  function reset() {
    showLicense = false
    showNotices = false
    copiedLabel = ""
  }

  function copyText(text, label) {
    Quickshell.clipboardText = text
    copiedLabel = label
    copiedTimer.restart()
  }

  spacing: Style.space(10)

  Timer { id: copiedTimer; interval: 1500; onTriggered: root.copiedLabel = "" }

  FileView { id: manifestFile; path: root.visible && root.pluginDir !== "" ? root.pluginDir + "/manifest.json" : ""; printErrors: false }
  FileView { id: licenseFile; path: root.visible && root.pluginDir !== "" ? root.pluginDir + "/LICENSE" : ""; printErrors: false }
  FileView { id: noticesFile; path: root.showNotices && root.pluginDir !== "" ? root.pluginDir + "/THIRD_PARTY_NOTICES.md" : ""; printErrors: false }

  component Label: Text {
    width: root.labelWidth
    textFormat: Text.PlainText
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    font.bold: true
  }

  component Value: Text {
    width: root.valueWidth
    textFormat: Text.PlainText
    wrapMode: Text.Wrap
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  component SmallButton: Button {
    bordered: true
    foreground: root.foreground
    accent: root.accent
    fontFamily: root.fontFamily
    fontSize: Style.font.caption
    horizontalPadding: Style.space(8)
    verticalPadding: Style.space(3)
  }

  Row {
    width: parent.width
    spacing: Style.space(12)

    OpticalGlyph {
      id: appIcon
      width: Style.space(40)
      height: width
      anchors.verticalCenter: parent.verticalCenter
      text: "󰃭"
      fontFamily: root.fontFamily
      fontSize: Style.space(30)
      color: root.accent
    }

    Column {
      width: parent.width - appIcon.width - parent.spacing
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        textFormat: Text.PlainText
        text: About.NAME
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.title
        font.bold: true
      }
      Text {
        width: parent.width
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        text: About.TAGLINE
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
      }
      Text {
        objectName: "aboutVersion"
        textFormat: Text.PlainText
        text: "Version " + (root.version || "unknown")
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  PanelSeparator { foreground: root.foreground }

  Grid {
    width: parent.width
    columns: 2
    columnSpacing: Style.space(10)
    rowSpacing: Style.space(8)

    Label { text: "MADE BY" }
    Value { text: About.ORGANIZATION }

    Label { text: "CREATED" }
    Value { text: About.CREATED }

    Label { text: "LICENSE" }
    Column {
      width: root.valueWidth
      spacing: Style.space(4)
      Value { text: About.licenseSummary(licenseFile.loaded ? licenseFile.text() : "") || "MIT License" }
      Flow {
        width: parent.width
        spacing: Style.space(6)
        SmallButton {
          objectName: "aboutLicenseButton"
          text: root.showLicense ? "Hide license" : "Read license"
          onClicked: root.showLicense = !root.showLicense
        }
        SmallButton {
          objectName: "aboutNoticesButton"
          text: root.showNotices ? "Hide third-party notices" : "Third-party notices"
          onClicked: root.showNotices = !root.showNotices
        }
      }
    }

    Label { text: "SUPPORT" }
    Column {
      width: root.valueWidth
      spacing: Style.space(4)
      Value { text: About.SUPPORT_EMAIL }
      Flow {
        width: parent.width
        spacing: Style.space(6)
        SmallButton {
          text: "Email"
          tooltipText: "Opens your mail app with the version details filled in"
          onClicked: Qt.openUrlExternally(About.mailto(root.version, root.details))
        }
        SmallButton {
          text: root.copiedLabel === "email" ? "Copied" : "Copy"
          onClicked: root.copyText(About.SUPPORT_EMAIL, "email")
        }
        SmallButton {
          text: root.copiedLabel === "details" ? "Copied" : "Copy version details"
          onClicked: root.copyText(root.details, "details")
        }
      }
    }

    Label { text: "PRIVACY" }
    Value { objectName: "aboutPrivacy"; text: About.PRIVACY }

    Label { text: "BUILT WITH" }
    Value { color: root.dim; text: About.builtWith(root.quickshellVersion, root.qtVersion) }
  }

  Text {
    objectName: "aboutLicenseText"
    visible: root.showLicense
    width: parent.width
    textFormat: Text.PlainText
    wrapMode: Text.Wrap
    text: licenseFile.loaded ? About.reflow(licenseFile.text()) : "LICENSE could not be read from the plugin folder."
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  Text {
    objectName: "aboutNoticesText"
    visible: root.showNotices
    width: parent.width
    textFormat: Text.PlainText
    wrapMode: Text.Wrap
    text: noticesFile.loaded ? About.reflow(noticesFile.text()) : "See THIRD_PARTY_NOTICES.md in the plugin folder."
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }
}
