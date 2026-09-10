# Third-party notices

The month-grid/week date math in `Model.js` (`monthGrid`, `weekDays`,
`dateKey`, `isoWeek`, `weekdayOrder`, `stepMonth`, `stepWeek`,
`normalizedWeekStart`), the bounded-capture process wrapper
(`boundedCaptureCommand` / `boundedCaptureScript`), the panel/day-detail/bar
widget layout in `Panel.qml`, `DayDetail.qml` and `BarWidget.qml`, and the
overall Service.qml process-orchestration shape are adapted from Ninepoint
Labs' `omarchy-hey-calendar` plugin (MIT License, Copyright (c) 2026
Ninepoint Labs), itself descended from 37signals' `37signals.hey` Omarchy
plugin (MIT License, Copyright (c) 2026 37signals LLC) and, for the date
math, from Omarchy's own built-in `omarchy.clock` shell plugin
(`/usr/share/omarchy/shell/plugins/panels/clock`), so the Month and Year
views line up with the native Omarchy calendar popup. Reused with
attribution under the terms of those licenses.

The setup flow's lock-directory/floating-terminal/IPC-completion structure
(`setupLockShell`, `setupLockCheckCommand`, `setupLaunchCommand` in
`Model.js`, and the matching `setupFinished` IPC handler in `BarWidget.qml`)
is adapted from Ninepoint Labs' `omarchy-fastmail` plugin (MIT License,
Copyright (c) 2026 Ninepoint Labs), reused with attribution under the terms
of that license. This plugin's own setup flow captures a Fastmail API token
directly rather than driving `fm-cli`'s OAuth login — the two plugins share
no runtime dependency and no credential.
