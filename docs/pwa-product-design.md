# PWA Product Design

## Product Positioning

Simple Schedule PWA is a personal schedule app for one user across Windows and
iPhone. It should feel like the original Simple-Schedule widget: compact,
quiet, deadline-focused, and quick to operate.

The iPhone version is not an App Store app. It is a web app installed from
Safari with "Add to Home Screen". The Windows version is the same web app
installed from Edge or Chrome.

Cloud sync is mandatory. The product is not a single-device local-only app; the
cloud database is what lets Windows and iPhone share the same schedule.

## Primary User Story

As the owner of the schedule, I want to add and complete tasks on either my
Windows computer or my iPhone, so the other device always shows the same list.

## Installation Experience

### iPhone

1. Open the app URL in Safari.
2. Tap Share.
3. Tap Add to Home Screen.
4. Keep "Open as Web App" enabled if iOS shows the option.
5. Tap Add.
6. Launch Simple Schedule from the Home Screen icon.

### Windows

1. Open the app URL in Edge or Chrome.
2. Use the browser install action.
3. Pin the installed app to the taskbar or Start menu.
4. Launch Simple Schedule as a standalone desktop window.

## Core Screens

### Todo

Default screen. Shows active tasks sorted by earliest deadline.

Required elements:

- Current date label
- Todo task list
- Add task button
- Switch to Completed
- Sync state indicator

Task item:

- Completion circle
- Task title
- Deadline text
- Delete action

Deadline color rule:

- Deadline today or earlier: deadline time is red.
- Future deadline less than 3 calendar days away: deadline time is blue.
- Later future deadlines use the default muted time color.
- Completed tasks show completion time and do not use deadline urgency colors.

### Completed

Shows completed tasks sorted by latest completion time.

Required elements:

- Completed task list
- Reopen action through the completion circle
- Delete action
- Switch back to Todo

Completed tasks older than 5 days are hidden by the app rule.

### Add Task

On iPhone, use a bottom sheet style panel. On Windows, use a compact inline
panel similar to the original widget.

Fields:

- Task title
- Deadline date and time

Actions:

- Save
- Cancel

### Login

The app is for personal use, so the login flow can be simple.

MVP choice:

- Email + password through Supabase Auth

Reason:

- Supabase's built-in magic-link email provider has low sending limits.
- Password login is more stable for repeated local testing.
- The same account can be reused on Windows and iPhone without requesting a new
  email every time.

Before real multi-device use, login must be connected to the cloud database so
both devices resolve to the same user record.

### Settings

Settings should stay minimal:

- Account status
- Sign out only if a settings screen is added later
- Install guidance when not running as an installed PWA
- App version

## Interaction Model

### iPhone

- Tap the circle to complete or reopen.
- Swipe or long press can reveal delete later, but MVP can use a visible icon.
- Use large enough touch targets.
- Keep the task list readable in one hand.
- Avoid desktop-only controls such as pin, minimize, and close.

### Windows

- Compact window-like layout in an installed browser app.
- Keyboard-friendly add flow.
- Visible delete and complete controls.
- No native always-on-top in the PWA MVP.
- The task surface fills the app viewport by default instead of rendering as a
  centered card.
- The app does not enforce an artificial minimum content height. If the window
  is resized very short, normal browser/PWA scrolling handles overflow.

Always-on-top note:

- Browser-installed PWAs cannot reliably force Windows always-on-top from web
  code.
- Use Windows PowerToys Always On Top, or a dedicated Electron/Tauri wrapper
  later if native pinning becomes a hard requirement.

## Visual Direction

Keep the original feeling:

- Warm paper-like background
- Small, dense task list
- Rounded controls around 8px
- Calm accent color for actions
- Clear overdue state
- Clear near-deadline time color
- Completed tasks visually softened

Home Screen icon:

- iOS uses `icons/apple-touch-icon.png`.
- The web manifest uses PNG icons at 192x192 and 512x512.
- SVG remains only as a source/reference asset because Safari Home Screen icons
  should use PNG for reliable rendering.

Do not make it a marketing landing page. The first screen after opening should
be the actual task app.

## Sync UX

The app should make sync understandable without being noisy.

States:

- Synced
- Syncing
- Offline
- Needs attention

Behavior:

- User actions apply immediately locally.
- If offline, changes stay queued.
- When online again, queued changes sync automatically.
- Add, complete, reopen, and delete actions automatically attempt cloud sync.
- No primary manual sync button is shown in the task surface.
- No sign-out button is shown in the main task surface because this is a
  personal single-user app.
- The cloud database is the shared source of truth across devices.

## Notifications

Notifications are optional for MVP.

Later, for iOS Home Screen web apps, Web Push can be used on supported iOS
versions. Server-side reminders are more reliable than trying to depend on
background web timers.

## MVP Scope

Build first:

- Installable PWA shell
- Todo and Completed screens
- Add, complete, reopen, delete
- IndexedDB local cache
- Offline support
- Cloud database schema
- Sync API contract
- Automatic sync attempts after task changes
- Same visual style as original

Build second:

- Authentication
- Automatic background sync attempts while the app is open
- Conflict handling
- Web Push reminders
- Windows install polish
