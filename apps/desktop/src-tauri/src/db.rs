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

use rusqlite::types::{ToSql, Value, ValueRef};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

/// The open database: the connection plus the file path it was opened from (backup/restore
/// need the path; rusqlite does not expose it portably, so we keep the one we opened with).
struct OpenDb {
    conn: Connection,
    path: PathBuf,
}

pub struct AppState {
    db: Mutex<Option<OpenDb>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self { db: Mutex::new(None) }
    }
}

fn locked<'a>(state: &'a tauri::State<AppState>) -> Result<std::sync::MutexGuard<'a, Option<OpenDb>>, String> {
    state.db.lock().map_err(|e| format!("db lock poisoned: {e}"))
}

fn require<'a>(guard: &'a mut Option<OpenDb>) -> Result<&'a mut OpenDb, String> {
    guard.as_mut().ok_or_else(|| "database is not open (sql_open was not called)".to_string())
}

/// JSON parameter (from TauriSqlDriver) → rusqlite value.
/// The JS side already normalizes: bool→0/1, Date→ISO string, bigint→number.
fn to_param(v: &serde_json::Value) -> Value {
    match v {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Integer(i64::from(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else {
                Value::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => Value::Text(s.clone()),
        // Objects/arrays (none expected from the driver) are stored as their JSON text.
        _ => Value::Text(serde_json::to_string(v).unwrap_or_default()),
    }
}

/// JSON parameters → owned rusqlite values (caller keeps them alive for the query).
fn to_values(params: &Option<Vec<serde_json::Value>>) -> Vec<Value> {
    params.as_deref().unwrap_or_default().iter().map(to_param).collect()
}

/// The form `Params` is implemented for in rusqlite 0.32: `&[&dyn ToSql]`.
/// `values` must outlive the returned references (it does — same function scope).
fn as_params<'a>(values: &'a Vec<Value>) -> Vec<&'a dyn ToSql> {
    values.iter().map(|v| v as &'a dyn ToSql).collect()
}

/// One row → JSON object (column name → value). Column names are captured from the
/// statement BEFORE `query_map` (the closure may not borrow the statement).
/// The schema has no BLOB columns; a stray BLOB maps to null (honest, not fake data).
fn row_to_json(names: &[String], row: &rusqlite::Row) -> Result<serde_json::Value, rusqlite::Error> {
    let mut map = serde_json::Map::new();
    for (i, name) in names.iter().enumerate() {
        let value = match row.get_ref(i) {
            Ok(ValueRef::Null) => serde_json::Value::Null,
            Ok(ValueRef::Integer(v)) => serde_json::json!(v),
            Ok(ValueRef::Real(v)) => serde_json::json!(v),
            Ok(ValueRef::Text(t)) => serde_json::Value::String(String::from_utf8_lossy(t).into_owned()),
            Ok(ValueRef::Blob(_)) => serde_json::Value::Null,
            Err(e) => return Err(e),
        };
        map.insert(name.clone(), value);
    }
    Ok(serde_json::Value::Object(map))
}

fn column_names(stmt: &rusqlite::Statement) -> Vec<String> {
    stmt.column_names().iter().map(|s| s.to_string()).collect()
}

fn first_row(conn: &Connection, sql: &str, params: &Option<Vec<serde_json::Value>>) -> Result<Option<serde_json::Value>, String> {
    let values = to_values(params);
    let bound = as_params(&values);
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let names = column_names(&stmt);
    let mut rows = stmt
        .query_map(bound.as_slice(), |row| row_to_json(&names, row))
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(Ok(row)) => Ok(Some(row)),
        Some(Err(e)) => Err(e.to_string()),
        None => Ok(None),
    }
}

fn all_rows(conn: &Connection, sql: &str, params: &Option<Vec<serde_json::Value>>) -> Result<Vec<serde_json::Value>, String> {
    let values = to_values(params);
    let bound = as_params(&values);
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let names = column_names(&stmt);
    let mut rows = stmt
        .query_map(bound.as_slice(), |row| row_to_json(&names, row))
        .map_err(|e| e.to_string())?;
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
    *guard = Some(OpenDb { conn, path: p });
    Ok(())
}

#[tauri::command]
pub fn sql_close(state: tauri::State<AppState>) -> Result<(), String> {
    let mut guard = locked(&state)?;
    if let Some(db) = guard.take() {
        // close() consumes the connection and returns it on success (Result<Connection>).
        db.conn.close().map_err(|(_conn, e)| format!("close: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn sql_exec(state: tauri::State<AppState>, sql: String) -> Result<(), String> {
    let mut guard = locked(&state)?;
    let db = require(&mut guard)?;
    db.conn.execute_batch(&sql).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sql_run(state: tauri::State<AppState>, sql: String, params: Option<Vec<serde_json::Value>>) -> Result<serde_json::Value, String> {
    let mut guard = locked(&state)?;
    let db = require(&mut guard)?;
    let values = to_values(&params);
    let bound = as_params(&values);
    let changes = db.conn.execute(&sql, bound.as_slice()).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "changes": changes, "lastInsertRowid": db.conn.last_insert_rowid() }))
}

#[tauri::command]
pub fn sql_all(state: tauri::State<AppState>, sql: String, params: Option<Vec<serde_json::Value>>) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = locked(&state)?;
    let db = require(&mut guard)?;
    all_rows(&db.conn, &sql, &params)
}

#[tauri::command]
pub fn sql_get(state: tauri::State<AppState>, sql: String, params: Option<Vec<serde_json::Value>>) -> Result<Option<serde_json::Value>, String> {
    let mut guard = locked(&state)?;
    let db = require(&mut guard)?;
    first_row(&db.conn, &sql, &params)
}

#[tauri::command]
pub fn sql_pragma(state: tauri::State<AppState>, name: String) -> Result<serde_json::Value, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("invalid pragma name".to_string());
    }
    let mut guard = locked(&state)?;
    let db = require(&mut guard)?;
    let sql = format!("PRAGMA {name};");
    let mut stmt = db.conn.prepare(&sql).map_err(|e| e.to_string())?;
    let names = column_names(&stmt);
    let mut rows = stmt
        .query_map(params![], |row| row_to_json(&names, row))
        .map_err(|e| e.to_string())?;
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
    let db = require(&mut guard)?;
    let _ = db.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    let bytes = std::fs::read(&db.path).map_err(|e| format!("snapshot read failed: {e}"))?;
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
        let db = require(&mut guard)?; // &mut OpenDb
        let path = db.path.clone();
        // close() consumes the connection and returns it on success (Result<Connection>).
        db.conn.close().map_err(|(_conn, e)| format!("close before restore: {e}"))?;
        guard.take(); // remove the (closed) database from state
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
    *guard = Some(OpenDb { conn, path });
    Ok(())
}
