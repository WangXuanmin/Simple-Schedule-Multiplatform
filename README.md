# Simple Schedule

Simple Schedule is a personal task app for Windows and iPhone. Windows uses the
installable PWA in `apps/web`; iPhone can use the native SwiftUI app in
`apps/ios`, or the PWA from Safari.

## 功能介绍

- Todo 和 Completed 两个任务视图。
- 添加任务时可设置任务名称和截止时间。
- Todo 任务按截止时间排序。
- 可完成、恢复和删除任务。
- 已完成任务会在 5 天后自动隐藏。
- 使用 Supabase 账号登录后，Windows PWA 和 iOS 原生 App 之间自动同步任务。
- 支持 Supabase Realtime，同一账号的其他设备修改任务后会自动刷新。
- 离线或同步失败时会先保存在本地，之后重新联网再同步。
- 截止时间颜色提示：
  - 今天及之前：红色。
  - 距今天小于 3 个自然日：蓝色。
  - 更远时间：默认灰色。
- 左下角显示同步状态。
- 右上角刷新按钮可手动触发同步。

## 使用说明

在线版本：

```text
https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/
```

### Windows

1. 用 Edge 或 Chrome 打开在线版本。
2. 登录 Supabase 账号。
3. 浏览器提示可安装时，选择安装应用。
4. 之后可从开始菜单、任务栏或桌面应用窗口打开。

### iPhone

原生 iOS App：

1. 用 Xcode 打开 `apps/ios/SimpleScheduleIOS.xcodeproj`。
2. 选择 `SimpleScheduleIOS` target 和模拟器或真机。
3. 如需真机运行，确认 Signing Team 已设置为你的 Apple 开发者账号。
4. 运行后用和 Windows PWA 相同的 Supabase 账号登录。

Safari PWA：

1. 用 Safari 打开在线版本。
2. 登录同一个 Supabase 账号。
3. 点击 Safari 分享按钮。
4. 选择“添加到主屏幕”。
5. 之后从主屏幕图标打开。

### 同步

- 新增、完成、恢复、删除任务后，应用会自动同步。
- 如果另一台设备已打开，同步通常会自动刷新到当前设备。
- 如果设备处于后台、睡眠或断网，回到前台或重新联网后会自动同步。
- 如需立即确认最新数据，可点击右上角刷新按钮。
