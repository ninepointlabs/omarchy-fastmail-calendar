// Node test runner (`node --test tests/about.test.cjs`) for the About page's
// facts: they come from the repo's own files (manifest.json, LICENSE, git
// history), so these check About.js against the real files, and check that
// the privacy statement names every network host the code can reach.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const About = require("../About.js")
const Model = require("../Model.js")

const ROOT = path.join(__dirname, "..")
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8")

test("version comes from manifest.json", () => {
  const manifest = JSON.parse(read("manifest.json"))
  assert.equal(About.manifestVersion(read("manifest.json")), manifest.version)
  assert.equal(About.manifestVersion("not json"), "")
  assert.equal(About.manifestVersion(""), "")
  assert.equal(About.manifestVersion('{"version":"1.0 <b>"}'), "")
  assert.equal(About.NAME, manifest.name)
  assert.equal(manifest.author, "Nine Point Labs")
})

test("license summary and text come from LICENSE", () => {
  const text = read("LICENSE")
  assert.equal(About.licenseSummary(text), "MIT License, © 2026 Nine Point Labs")
  const body = About.reflow(text)
  assert.ok(body.startsWith("MIT License\n\nCopyright (c) 2026 Nine Point Labs\n\nPermission is hereby granted"))
  assert.ok(body.includes("THE SOFTWARE IS PROVIDED \"AS IS\""))
  assert.ok(!body.includes("a copy\nof"), "one line per paragraph")
  assert.ok(About.reflow(read("THIRD_PARTY_NOTICES.md")).startsWith("# Third-party notices\n\n"))
})

test("facts: Nine Point Labs, created date, support address", () => {
  assert.equal(About.ORGANIZATION, "Nine Point Labs")
  assert.equal(About.SUPPORT_EMAIL, "help@ninepointlabs.com")
  const first = execFileSync("git", ["log", "--reverse", "--format=%ad", "--date=format:%B %Y"],
    { cwd: ROOT, encoding: "utf8" }).split("\n")[0]
  assert.equal(About.CREATED, first)
})

test("no file still spells the company Ninepoint", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n")
    .filter(f => f && !f.endsWith(".png"))
  for (const f of files) assert.doesNotMatch(read(f), /Ninepoint\s+Labs|NINEPOINT\s+LABS/, f)
})

test("privacy statement names every network host in the code", () => {
  assert.match(About.PRIVACY, /no telemetry/)
  assert.match(About.PRIVACY, /never edits or deletes/)
  assert.ok(About.PRIVACY.includes(Model.secretService), "names the keyring entry")
  assert.ok(About.PRIVACY.includes("~/.config/omarchy/shell.json"))
  // XML namespace names look like URLs but are never fetched.
  const namespaces = new Set(["apple.com"])
  const hosts = new Set()
  const sources = fs.readdirSync(ROOT).filter(f => /\.(qml|js)$/.test(f))
    .concat(fs.readdirSync(path.join(ROOT, "bin")).map(f => path.join("bin", f)))
  for (const f of sources) {
    for (const m of read(f).matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
      if (/\.[A-Za-z]{2,}$/.test(m[1]) && !namespaces.has(m[1])) hosts.add(m[1])
    }
  }
  assert.ok(hosts.has(new URL(Model.defaultServerUrl).host), "the scan sees the default server")
  for (const host of hosts) assert.ok(About.PRIVACY.includes(host), host + " is not named in the privacy text")
  // ...and the namespace exemption really is only Apple's iCal XML namespace.
  for (const f of sources)
    for (const m of read(f).matchAll(/https?:\/\/apple\.com[^"\\\s]*/g)) assert.equal(m[0], "http://apple.com/ns/ical/", f)
})

test("toolkit versions are probed, and the support mail prefills them", () => {
  assert.equal(About.probedVersion((major, minor) => major === 6 && minor <= 11, 6), "6.11")
  assert.equal(About.probedVersion((major, minor) => major === 0 && minor <= 3, 0), "0.3")
  assert.equal(About.probedVersion(() => false, 6), "")
  assert.equal(About.probedVersion(null, 6), "")
  assert.equal(About.builtWith("", ""), "Quickshell and Qt")
  const details = About.details("0.1.0", "0.3", "6.11", "Hyprland, wayland")
  assert.equal(details, "Fastmail Calendar 0.1.0\nQuickshell 0.3, Qt 6.11\nHyprland, wayland")
  const url = About.mailto("0.1.0", details)
  assert.ok(url.startsWith("mailto:help@ninepointlabs.com?subject=Fastmail%20Calendar%200.1.0&body="))
  assert.equal(decodeURIComponent(url.split("&body=")[1]), "\n\n--\n" + details)
})
