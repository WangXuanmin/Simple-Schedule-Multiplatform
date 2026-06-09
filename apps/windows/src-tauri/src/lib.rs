use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_window_state::StateFlags;

#[derive(Default)]
struct TopmostState(Mutex<bool>);

#[tauri::command]
fn set_always_on_top(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window was not found.".to_string())?;
    window
        .set_always_on_top(enabled)
        .map_err(|error| error.to_string())?;

    let state = app.state::<TopmostState>();
    let mut current = state.0.lock().map_err(|error| error.to_string())?;
    *current = enabled;
    Ok(())
}

#[tauri::command]
fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn minimize_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window was not found.".to_string())?;
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window was not found.".to_string())?;
    window.hide().map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(TopmostState::default())
        .plugin(tauri_plugin_autostart::Builder::new().app_name("Simple Schedule").build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            set_always_on_top,
            minimize_window,
            hide_window,
            app_exit
        ])
        .setup(|app| {
            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Simple Schedule");
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示/隐藏", true, None::<&str>)?;
    let new_task = MenuItem::with_id(app, "new_task", "新建任务", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "立即同步", true, None::<&str>)?;
    let topmost = MenuItem::with_id(app, "topmost", "置顶：已关闭", true, None::<&str>)?;
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = MenuItem::with_id(
        app,
        "autostart",
        if autostart_enabled {
            "开机自启：已开启"
        } else {
            "开机自启：已关闭"
        },
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &new_task, &sync, &topmost, &autostart, &quit])?;
    let icon = app.default_window_icon().cloned();
    let topmost_item = topmost.clone();
    let autostart_item = autostart.clone();

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Simple Schedule")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                toggle_main_window(app);
            }
            "new_task" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = app.emit("new-task-requested", ());
                }
            }
            "topmost" => {
                if let Some(window) = app.get_webview_window("main") {
                    let enabled = match app.state::<TopmostState>().0.lock() {
                        Ok(mut current) => {
                            *current = !*current;
                            *current
                        }
                        Err(_) => return,
                    };

                    let _ = window.set_always_on_top(enabled);
                    let _ = topmost_item.set_text(if enabled {
                        "置顶：已开启"
                    } else {
                        "置顶：已关闭"
                    });
                    let _ = app.emit("topmost-changed", enabled);
                }
            }
            "sync" => {
                let _ = app.emit("sync-requested", ());
            }
            "autostart" => {
                let enabled = match app.autolaunch().is_enabled() {
                    Ok(current) => !current,
                    Err(_) => return,
                };
                let result = if enabled {
                    app.autolaunch().enable()
                } else {
                    app.autolaunch().disable()
                };
                if result.is_ok() {
                    let _ = autostart_item.set_text(if enabled {
                        "开机自启：已开启"
                    } else {
                        "开机自启：已关闭"
                    });
                    let _ = app.emit("autostart-changed", enabled);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = icon {
        tray = tray.icon(icon);
    }

    tray.build(app)?;

    Ok(())
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}
