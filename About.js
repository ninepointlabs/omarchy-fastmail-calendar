// Facts and text for the panel's About page (AboutPage.qml), kept out of QML
// so node can check them against the repo (tests/about.test.cjs).
//
// The version comes from manifest.json and the license from LICENSE at run
// time, so neither is copied here and neither can drift from the real file.

var NAME = "Fastmail Calendar"
var TAGLINE = "Your CalDAV calendars in the Omarchy bar: Today, Week, Month and Year views, day detail and quick add. Fastmail by default; any CalDAV server works."
var ORGANIZATION = "Nine Point Labs"
var CREATED = "September 2026" // first commit: 2026-09-10
var SUPPORT_EMAIL = "help@ninepointlabs.com"

// Must stay true to what the plugin does (see README's Security section).
// Network: curl, HTTPS only, to the one CalDAV server set up in the keyring
// entry (Model.defaultServerUrl unless the user typed another), redirects
// only within that server's domain. Credentials: secret-tool (libsecret),
// never a file. Events: parsed in memory, never written to disk. Settings:
// shell.json via the bar's own settings store. www.fastmail.help is only
// printed as text in the setup terminal.
var PRIVACY = "No Nine Point Labs account and no telemetry. The plugin talks only to the CalDAV server you "
  + "connect: caldav.fastmail.com (Fastmail) unless you enter another https:// server at setup. Over "
  + "HTTPS it discovers your calendars (/.well-known/caldav), reads the events for the dates you are "
  + "viewing, and sends an event only when you add one; it never edits or deletes. Redirects are followed "
  + "only within that server's own domain. Your server URL, username and app password are stored only "
  + "in your system keyring (secret-tool, service ninepointlabs.fastmail-calendar); the password is never "
  + "written to a file, a command line or a log. Forget calendar credentials removes them. Events are kept "
  + "in memory only, not cached on disk. Your calendar names, colors and visibility and your view and bar "
  + "choices are saved in ~/.config/omarchy/shell.json. The setup terminal shows a link to Fastmail's help (www.fastmail.help) "
  + "but does not open it."

// "0.1.0" from manifest.json's text, or "" when it can't be read.
function manifestVersion(text) {
  var parsed
  try { parsed = JSON.parse(String(text || "")) } catch (e) { return "" }
  var version = parsed && typeof parsed.version === "string" ? parsed.version : ""
  return /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? version : ""
}

// "MIT License, © 2026 Nine Point Labs" from LICENSE's text: its first line
// plus its copyright line, as written there.
function licenseSummary(text) {
  var lines = String(text || "").split("\n")
  var name = ""
  var holder = ""
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue
    if (name === "") name = line
    var m = /^Copyright\s+(?:\(c\)|©)\s*(.+)$/i.exec(line)
    if (m) { holder = "© " + m[1]; break }
  }
  return holder ? name + ", " + holder : name
}

// One line per paragraph, so LICENSE / THIRD_PARTY_NOTICES.md wrap to the
// panel's width.
function reflow(text) {
  var paras = String(text || "").replace(/\r/g, "").split(/\n\s*\n/)
  var out = []
  for (var i = 0; i < paras.length; i++) {
    var p = paras[i].replace(/\s+/g, " ").trim()
    if (p !== "") out.push(p)
  }
  return out.join("\n\n")
}

// Highest minor version `has(major, minor)` accepts, as "major.minor"
// (Quickshell.hasVersion / hasQtVersion only answer yes or no), or "".
function probedVersion(has, major) {
  if (typeof has !== "function" || !has(major, 0)) return ""
  var minor = 0
  while (minor < 99 && has(major, minor + 1)) minor++
  return major + "." + minor
}

function builtWith(quickshell, qt) {
  var out = []
  if (quickshell) out.push("Quickshell " + quickshell)
  if (qt) out.push("Qt " + qt)
  return out.length ? out.join(", ") : "Quickshell and Qt"
}

// Version details to paste into a support email.
function details(version, quickshell, qt, desktop) {
  return NAME + " " + (version || "unknown version") + "\n"
    + builtWith(quickshell, qt) + "\n"
    + (desktop || "unknown desktop")
}

function mailto(version, detailText) {
  return "mailto:" + SUPPORT_EMAIL
    + "?subject=" + encodeURIComponent(NAME + " " + (version || ""))
    + "&body=" + encodeURIComponent("\n\n--\n" + detailText)
}

if (typeof module !== "undefined") {
  module.exports = {
    NAME: NAME, TAGLINE: TAGLINE, ORGANIZATION: ORGANIZATION, CREATED: CREATED,
    SUPPORT_EMAIL: SUPPORT_EMAIL, PRIVACY: PRIVACY,
    manifestVersion: manifestVersion, licenseSummary: licenseSummary, reflow: reflow,
    probedVersion: probedVersion, builtWith: builtWith, details: details, mailto: mailto
  }
}
