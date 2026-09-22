use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::image::Image;
use tauri::include_image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const TRAY_ICON: Image<'_> = include_image!("./icons/tray-icon.png");

struct Backend {
    child: Mutex<Option<Child>>,
    sidecar: Mutex<Option<CommandChild>>,
}

fn port_open() -> bool {
    TcpStream::connect_timeout(
        &"127.0.0.1:38888".parse().expect("static addr"),
        Duration::from_millis(200),
    )
    .is_ok()
}

fn wait_for_port() {
    for _ in 0..50 {
        if port_open() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("data");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn frontend_dir(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let nested = dir.join("frontend");
        if nested.exists() {
            return nested;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../frontend")
}

fn spawn_with_bun(_app: &AppHandle, data: &PathBuf, frontend: &PathBuf) -> Result<Child, String> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../backend/src/index.ts");
    Command::new("bun")
        .arg("run")
        .arg(script)
        .env("COMPANION_DATA_DIR", data)
        .env("COMPANION_FRONTEND_DIR", frontend)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("bun spawn failed: {e}"))
}

fn spawn_backend(app: &AppHandle) -> Result<(), String> {
    if port_open() {
        return Ok(());
    }
    let data = data_dir(app)?;
    let frontend = frontend_dir(app);
    match app.shell().sidecar("companion-server") {
        Ok(cmd) => {
            let (_rx, child) = cmd
                .env("COMPANION_DATA_DIR", data.to_string_lossy().as_ref())
                .env("COMPANION_FRONTEND_DIR", frontend.to_string_lossy().as_ref())
                .spawn()
                .map_err(|e| format!("sidecar spawn failed: {e}"))?;
            *app.state::<Backend>()
                .sidecar
                .lock()
                .map_err(|e| e.to_string())? = Some(child);
        }
        Err(_) => {
            let child = spawn_with_bun(app, &data, &frontend)?;
            *app.state::<Backend>()
                .child
                .lock()
                .map_err(|e| e.to_string())? = Some(child);
        }
    }
    wait_for_port();
    Ok(())
}

fn kill_backend(app: &AppHandle) {
    if let Ok(mut guard) = app.state::<Backend>().child.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
    }
    if let Ok(mut guard) = app.state::<Backend>().sidecar.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(Backend {
            child: Mutex::new(None),
            sidecar: Mutex::new(None),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            spawn_backend(&handle).map_err(|e| e.to_string())?;
            let _ = app.autolaunch().enable();

            let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(TRAY_ICON)
                .icon_as_template(true)
                .tooltip("AI Companion")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building AI Companion")
        .run(|app_handle, event| {
            match event {
                RunEvent::Reopen { .. } => show_main_window(app_handle),
                RunEvent::Exit => kill_backend(app_handle),
                _ => {}
            }
        });
}

