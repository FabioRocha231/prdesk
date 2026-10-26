use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::{AppHandle, Emitter, State};

const READ_BUF: usize = 8192;
// ponytail: backlog kept until the UI attaches; anything past 1 MiB before attach is dropped.
const MAX_BACKLOG: usize = 1 << 20;

/// Output produced before the UI attaches is held here; `None` means the UI is attached and output streams as events.
type Backlog = Arc<Mutex<Option<Vec<u8>>>>;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    backlog: Backlog,
}

#[derive(Default)]
pub struct Sessions {
    next_id: AtomicU32,
    map: Mutex<HashMap<u32, Session>>,
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn shell() -> CommandBuilder {
    // PowerShell on Windows so single-quoted prompts behave like on POSIX shells.
    if cfg!(windows) {
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");
        cmd
    } else {
        // The user's login shell, so PATH matches their terminal and the agent CLIs resolve.
        CommandBuilder::new_default_prog()
    }
}

fn pump(app: AppHandle, id: u32, mut reader: Box<dyn Read + Send>, backlog: Backlog) {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut buf = [0u8; READ_BUF];
    while let Ok(n) = reader.read(&mut buf) {
        if n == 0 {
            break;
        }
        let Ok(mut pending) = backlog.lock() else {
            break;
        };
        match pending.as_mut() {
            Some(held) if held.len() + n <= MAX_BACKLOG => held.extend_from_slice(&buf[..n]),
            Some(_) => {}
            None => {
                if app
                    .emit(&format!("pty-output-{id}"), b64.encode(&buf[..n]))
                    .is_err()
                {
                    break;
                }
            }
        }
    }
    let _ = app.emit(&format!("pty-exit-{id}"), ());
}

/// Starts the user's shell in `cwd` and types `command` into it, so the shell survives the agent exiting.
/// Call `pty_attach` once listening for `pty-output-{id}`; `pty-exit-{id}` fires when the shell ends.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    cwd: String,
    command: String,
    rows: u16,
    cols: u16,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(size(rows, cols))
        .map_err(|e| format!("Could not open a terminal: {e}"))?;
    let mut cmd = shell();
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Could not start the shell: {e}"))?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    writer
        .write_all(format!("{command}\r").as_bytes())
        .map_err(|e| format!("Could not send the agent command: {e}"))?;

    let id = sessions.next_id.fetch_add(1, Ordering::Relaxed);
    let backlog: Backlog = Arc::new(Mutex::new(Some(Vec::new())));
    let pump_backlog = Arc::clone(&backlog);
    std::thread::spawn(move || pump(app, id, reader, pump_backlog));

    sessions
        .map
        .lock()
        .map_err(|_| "Terminal registry poisoned".to_owned())?
        .insert(
            id,
            Session {
                master: pair.master,
                writer,
                child,
                backlog,
            },
        );
    Ok(id)
}

fn with_session<T>(
    sessions: &Sessions,
    id: u32,
    f: impl FnOnce(&mut Session) -> Result<T, String>,
) -> Result<T, String> {
    let mut map = sessions
        .map
        .lock()
        .map_err(|_| "Terminal registry poisoned".to_owned())?;
    let session = map.get_mut(&id).ok_or("Terminal session not found.")?;
    f(session)
}

/// Switches the session to live events and returns (base64) everything printed before.
#[tauri::command]
pub fn pty_attach(sessions: State<'_, Sessions>, id: u32) -> Result<String, String> {
    with_session(&sessions, id, |s| {
        let held = s
            .backlog
            .lock()
            .map_err(|_| "Terminal backlog poisoned".to_owned())?
            .take();
        Ok(base64::engine::general_purpose::STANDARD.encode(held.unwrap_or_default()))
    })
}

#[tauri::command]
pub fn pty_write(sessions: State<'_, Sessions>, id: u32, data: String) -> Result<(), String> {
    with_session(&sessions, id, |s| {
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn pty_resize(
    sessions: State<'_, Sessions>,
    id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    with_session(&sessions, id, |s| {
        s.master.resize(size(rows, cols)).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn pty_kill(sessions: State<'_, Sessions>, id: u32) -> Result<(), String> {
    let session = sessions
        .map
        .lock()
        .map_err(|_| "Terminal registry poisoned".to_owned())?
        .remove(&id);
    if let Some(mut s) = session {
        s.child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}
