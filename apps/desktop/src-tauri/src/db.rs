//! Native SQLite core of the LifeMentor Windows shell.
//!
//! Owns a single rusqlite connection to `%APPDATA%/ai.lifementor.app/data/lifementor.sqlite`
//! (WAL, synchronous NORMAL, foreign keys, busy timeout — the same durability profile the
//! web/node drivers apply, docs/03 §1). The web frontend talks to it through the
//! `sql_*` invoke contract implemented by `TauriSqlDriver` in `@lifementor/core`.
//!
//! Every command takes the shared `State<AppState>`; the `Mutex` guarantees one operation
//! at a time (the JS side is single-threaded anyway, but restore swaps the connection).
//!
//! The contract is pinned by `packages/core/test/tauri-driver.test.ts`, which emulates this
//! module against node:sqlite and runs the real `TauriSqlDriver` through it.

use rusqlite::{params, Connection, ValueRef};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

pub struct AppState {
    db: Mutex<Option<Connection>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self { db: Mutex::new(None) }
    }
}

fn locked<'a>(state: &'a tauri::State<AppState>) -> Result<std::sync::MutexGuard<'a, Option<Connection>>, String> {
    state.db.lock().map_err(|e| format!("db lock poisoned: {e}"))
}

fn require<'a>(guard: &'a mut Option<Connection>) -> Result<&'a mut Connection, String> {
    guard.as_mut().ok_or_else(|| "database is not open (sql_open was not called)".to_string())
}

/// JSON parameter (from TauriSqlDriver) → rusqlite value.
/// The JS side already normalizes: bool→0/1, Date→ISO string, bigint→number.
fn to_param(v: &serde_json::Value) -> rusqlite::Value {
    match v {
        serde_json::Value::Null => rusqlite::Value::Null,
        serde_json::Value::Bool(b) => rusqlite::Value::Integer(i64::from(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                rusqlite::Value::Integer(i)
            } else {
                rusqlite::Value::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => rusqlite::Value::Text(s.clone()),
        _ => rusqlite::Value::Text(serde_json::to_string(v).unwrap_or_default()),
    }
}

fn bind(params: &Option<Vec<serde_json::Value>>) -> Vec<rusqlite::Value> {
    params.as_deref().unwrap_or_default().iter().map(to_param).collect()
}

/// One row → JSON object (column name → value). The schema has no BLOB columns.
fn row_to_json(row: &rusqlite::Row) -> Result<serde_json::Value, rusqlite::Error> {
    let stmt = row.statement();
    let count = stmt.column_count();
    let mut map = serde_json::Map::new();
    for i in 0..count {
        let name = stmt.column_name(i).to_string();
        let value = match row.value(i) {
            ValueRef::Null => serde_json::Value::Null,
            ValueRef::Integer(v) => serde_json::json!(v),
            ValueRef::Real(v) => serde_json::json!(v),
            ValueRef::Text(t) => serde_json::Value::String(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(_) => serde_json::Value::Null,
        };
        map.insert(name, value);
    }
    Ok(serde_json::Value::Object(map))
}

fn first_row(conn: &Connection, sql: &str, params: &Option<Vec<serde_json::Value>>) -> Result<Option<serde_json::Value>, String> {
    let bound = bind(params);
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query_map(bound.as_slice(), row_to_json).map_err(|e| e.to_string())?;
    match rows.next() {
        Some(Ok(row)) => Ok(Some(row)),
        Some(Err(e)) => Err(e.to_string()),
        None => Ok(None),
    }
}

fn all_rows(conn: &Connection, sql: &str, params: &Option<Vec<serde_json::Value>>) -> Result<Vec<serde_json::Value>, String> {
    let bound = bind(params);
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query_map(bound.as_slice(), row_to_json).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next() {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/* ── commands (invoke contract of TauriSqlDriver) ────────────────────── */

#[tauri::command]
pub fn sql_open(state: tauri::State<AppState>, path: String, durability: String, busy_timeout_ms: Option<u32>) -> Result<(), String> {
    let busy = u64::from(busy_timeout_ms.unwrap_or(5000));
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cannot create data dir: {e}"))?;
        }
    }
    let conn = Connection::open(&p).map_err(|e| format!("cannot open sqlite: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| format!("wal: {e}"))?;
    let sync = match durability.as_str() {
        "paranoid" => "FULL",
        "fast" => "OFF",
        _ => "NORMAL",
    };
    conn.pragma_update(None, "synchronous", sync).map_err(|e| format!("synchronous: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON").map_err(|e| format!("foreign_keys: {e}"))?;
    conn.busy_timeout(Duration::from_millis(busy)).map_err(|e| format!("busy_timeout: {e}"))?;
    let _ = conn.pragma_update(None, "wal_autocheckpoint", 1000);
    let _ = conn.pragma_update(None, "cache_size", -8000);
    let _ = conn.pragma_update(None, "temp_store", "MEMORY");
    let mut guard = locked(&state)?;
    *guard = Some(conn);
    Ok(())
}

#[tauri::command]
pub fn sql_close(state: tauri::State<AppState>) -> Result<(), String> {
    let mut guard = locked(&state)?;
    if let Some(conn) = guard.take() {
        conn.close().map_err(|e| format!("close: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn sql_exec(state: tauri::State<AppState>, sql: String) -> Result<(), String> {
    let mut guard = locked(&state)?;
    let conn = require(&mut guard)?;
    conn.execute_batch(&sql).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sql_run(state: tauri::State<AppState>, sql: String, params: Option<Vec<serde_json::Value>>) -> Result<serde_json::Value, String> {
    let mut guard = locked(&state)?;
    let conn = require(&mut guard)?;
    let bound = bind(&params);
    let changes = conn.execute(&sql, bound.as_slice()).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "changes": changes, "lastInsertRowid": conn.last_insert_rowid() }))
}

#[tauri::command]
pub fn sql_all(state: tauri::State<AppState>, sql: String, params: Option<Vec<serde_json::Value>>) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = locked(&state)?;
    let conn = require(&mut guard)?;
    all_rows(conn, &sql, &params)
}

#[tauri::command]
pub fn sql_get(state: tauri::State<AppState>, sql: String, params: Option<Vec<serde_json::Value>>) -> Result<Option<serde_json::Value>, String> {
    let mut guard = locked(&state)?;
    let conn = require(&mut guard)?;
    first_row(conn, &sql, &params)
}

#[tauri::command]
pub fn sql_pragma(state: tauri::State<AppState>, name: String) -> Result<serde_json::Value, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("invalid pragma name".to_string());
    }
    let mut guard = locked(&state)?;
    let conn = require(&mut guard)?;
    let sql = format!("PRAGMA {name};");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query_map(params![], row_to_json).map_err(|e| e.to_string())?;
    match rows.next() {
        Some(Ok(row)) => {
            // The JS driver reads the scalar: first column of the first row.
            let first = row.as_object().and_then(|o| o.values().next()).cloned().unwrap_or(serde_json::Value::Null);
            Ok(first)
        }
        Some(Err(e)) => Err(e.to_string()),
        None => Ok(serde_json::Value::Null),
    }
}

/// Consistent byte snapshot: truncate the WAL into the main file (idempotent — the JS
/// driver already checkpoints before calling), then read the file. Returns raw bytes.
#[tauri::command]
pub fn sql_backup_bytes(state: tauri::State<AppState>) -> Result<tauri::ipc::Response, String> {
    let mut guard = locked(&state)?;
    let conn = require(&mut guard)?;
    let path = conn
        .path()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "in-memory database cannot be serialized".to_string())?;
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    let bytes = std::fs::read(&path).map_err(|e| format!("snapshot read failed: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Restore from a byte snapshot: swap the connection, replace the file (and stale
/// WAL/SHM sidecars), reopen with the same durability profile.
#[tauri::command]
pub fn sql_restore_bytes(state: tauri::State<AppState>, bytes: Vec<u8>) -> Result<(), String> {
    if bytes.len() < 100 {
        return Err("refusing to restore: snapshot is too small to be a SQLite file".to_string());
    }
    let path = {
        let mut guard = locked(&state)?;
        let conn = require(&mut guard)?; // &mut Connection
        let path = conn
            .path()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| "cannot determine database path".to_string())?;
        conn.close().map_err(|e| format!("close before restore: {e}"))?;
        guard.take(); // remove the (closed) connection from state
        path
    };
    std::fs::write(&path, &bytes).map_err(|e| format!("snapshot write failed: {e}"))?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", path.to_string_lossy()));
        let _ = std::fs::remove_file(sidecar);
    }
    let conn = Connection::open(&path).map_err(|e| format!("reopen after restore: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_millis(5000)).map_err(|e| e.to_string())?;
    let mut guard = locked(&state)?;
    *guard = Some(conn);
    Ok(())
}
