//! Alerts from Grafana, pulled: OpsDeck periodically GETs Grafana's Alertmanager API for every
//! Grafana connector with credentials (nothing listens on this machine, so a changing IP or NAT
//! doesn't matter). Current alerts are keyed by fingerprint; a bounded event history is kept on disk.

use crate::{connectors, keepass::KeepassState, store};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::oneshot;

const CONFIG_FILE: &str = "alerts-config.json";
const DATA_FILE: &str = "alerts.json";
const HISTORY_CAP: usize = 1000;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct AlertsConfig {
    pub poll_enabled: bool,
    pub poll_seconds: u64,
    pub notify: bool,
    pub notify_resolved: bool,
}

impl Default for AlertsConfig {
    fn default() -> Self {
        Self {
            poll_enabled: true,
            poll_seconds: 60,
            notify: true,
            notify_resolved: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Alert {
    pub fingerprint: String,
    /// firing | resolved
    pub status: String,
    pub silenced: bool,
    /// name of the Grafana connector it was polled from
    pub source: String,
    pub name: String,
    pub severity: String,
    pub summary: String,
    pub description: String,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub starts_at: String,
    pub ends_at: String,
    pub generator_url: String,
    pub silence_url: String,
    pub dashboard_url: String,
    pub panel_url: String,
    pub value: String,
    pub received_at: String,
    pub acked: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Data {
    current: HashMap<String, Alert>,
    history: VecDeque<Alert>,
}

#[derive(Default)]
pub struct AlertsState {
    data: Mutex<Data>,
    poll_stop: Mutex<Option<oneshot::Sender<()>>>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn config() -> AlertsConfig {
    store::load_json(CONFIG_FILE).unwrap_or_default()
}

// ---------- payload parsing ----------

fn str_map(v: &Value) -> BTreeMap<String, String> {
    v.as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())))
        .collect()
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

/// One alert from the Alertmanager v2 API (webhook-style "firing"/"resolved" status also accepted).
fn parse_alert(a: &Value, source: &str) -> Alert {
    let labels = str_map(&a["labels"]);
    let annotations = str_map(&a["annotations"]);
    // API v2 has status {state: active|suppressed|unprocessed}; webhooks have "firing"/"resolved"
    let (status, silenced) = match &a["status"] {
        Value::String(st) => (st.clone(), false),
        Value::Object(o) => ("firing".to_string(), o.get("state").and_then(Value::as_str) == Some("suppressed")),
        _ => ("firing".to_string(), false),
    };
    let fingerprint = match s(&a["fingerprint"]) {
        f if !f.is_empty() => f,
        // no fingerprint (older senders): stable hash of the label set
        _ => format!("{:x}", labels.iter().fold(0xcbf29ce484222325u64, |h, (k, v)| {
            format!("{k}={v};").bytes().fold(h, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
        })),
    };
    let ends = s(&a["endsAt"]);
    Alert {
        fingerprint,
        status,
        silenced,
        source: source.into(),
        name: labels.get("alertname").cloned().unwrap_or_else(|| "alert".into()),
        severity: labels.get("severity").or(labels.get("priority")).cloned().unwrap_or_default(),
        summary: annotations.get("summary").cloned().unwrap_or_default(),
        description: annotations.get("description").or(annotations.get("message")).cloned().unwrap_or_default(),
        starts_at: s(&a["startsAt"]),
        ends_at: if ends.starts_with("0001-") { String::new() } else { ends },
        generator_url: s(&a["generatorURL"]),
        silence_url: s(&a["silenceURL"]),
        dashboard_url: s(&a["dashboardURL"]),
        panel_url: s(&a["panelURL"]),
        value: s(&a["valueString"]),
        received_at: now(),
        labels,
        annotations,
        acked: false,
    }
}

// ---------- state updates ----------

fn persist(data: &Data) {
    let _ = store::save_json(DATA_FILE, data);
}

pub fn load_data(state: &AlertsState) {
    let d: Data = store::load_json(DATA_FILE).unwrap_or_default();
    *state.data.lock().unwrap() = d;
}

fn firing_count(d: &Data) -> usize {
    d.current.values().filter(|a| a.status == "firing" && !a.acked && !a.silenced).count()
}

/// Applies alerts; returns the ones that are news (newly firing or just resolved).
fn apply(app: &AppHandle, incoming: Vec<Alert>) {
    let state = app.state::<AlertsState>();
    let mut news: Vec<Alert> = Vec::new();
    let count = {
        let mut d = state.data.lock().unwrap();
        for mut a in incoming {
            let prev = d.current.get(&a.fingerprint);
            let changed = prev.is_none_or(|p| p.status != a.status);
            if let Some(p) = prev {
                // ack sticks while the same incident keeps firing
                a.acked = p.acked && p.status == a.status && p.starts_at == a.starts_at;
            }
            if changed {
                d.history.push_front(a.clone());
                news.push(a.clone());
            }
            if a.status == "resolved" {
                d.current.remove(&a.fingerprint);
            } else {
                d.current.insert(a.fingerprint.clone(), a);
            }
        }
        d.history.truncate(HISTORY_CAP);
        persist(&d);
        firing_count(&d)
    };
    let _ = app.emit("alerts-changed", count);
    notify(app, &news);
}

fn notify(app: &AppHandle, news: &[Alert]) {
    let cfg = config();
    if !cfg.notify {
        return;
    }
    let shown: Vec<&Alert> = news
        .iter()
        .filter(|a| !a.silenced && (a.status == "firing" || cfg.notify_resolved))
        .collect();
    // one notification per alert up to 3, then a summary
    for a in shown.iter().take(3) {
        let icon = if a.status == "resolved" { "✅" } else if a.severity.contains("crit") { "🔴" } else { "🟠" };
        let body = [a.summary.as_str(), a.description.as_str(), a.value.as_str()]
            .into_iter()
            .find(|x| !x.is_empty())
            .unwrap_or(&a.source)
            .chars()
            .take(240)
            .collect::<String>();
        let _ = app.notification().builder().title(format!("{icon} {}", a.name)).body(body).show();
    }
    if shown.len() > 3 {
        let _ = app.notification().builder().title(format!("🔔 Ещё {} алертов", shown.len() - 3)).body("Откройте раздел алертов в OpsDeck").show();
    }
}

// ---------- pull: Grafana Alertmanager API ----------

async fn poll_once(app: &AppHandle) -> Vec<String> {
    let kp = app.state::<KeepassState>();
    let mut errors = Vec::new();
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(15)).build() {
        Ok(c) => c,
        Err(e) => return vec![e.to_string()],
    };
    for c in connectors::all().unwrap_or_default().into_iter().filter(|c| c.kind == "grafana") {
        let (user, pass) = match connectors::credentials(&kp, &c) {
            Ok(x) => x,
            Err(e) => { errors.push(format!("{}: {e}", c.name)); continue; }
        };
        if pass.is_empty() {
            continue;
        }
        let url = format!("{}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=true&inhibited=true", c.url.trim_end_matches('/'));
        let req = client.get(&url);
        // service account token (auth "token") → Bearer; login/password → basic auth
        let req = if c.auth == "token" { req.bearer_auth(&pass) } else { req.basic_auth(&user, Some(&pass)) };
        let res = req.send().await;
        let list: Vec<Value> = match res {
            Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
            Ok(r) => { errors.push(format!("{}: HTTP {}", c.name, r.status())); continue; }
            Err(e) => { errors.push(format!("{}: {e}", c.name)); continue; }
        };
        let mut alerts: Vec<Alert> = list.iter().map(|a| parse_alert(a, &c.name)).collect();
        let seen: HashSet<String> = alerts.iter().map(|a| a.fingerprint.clone()).collect();
        // alerts of this source that disappeared from the API have been resolved
        {
            let d = app.state::<AlertsState>();
            let d = d.data.lock().unwrap();
            for a in d.current.values().filter(|a| a.source == c.name && !seen.contains(&a.fingerprint)) {
                let mut r = a.clone();
                r.status = "resolved".into();
                r.ends_at = now();
                r.received_at = now();
                alerts.push(r);
            }
        }
        apply(app, alerts);
    }
    errors
}

fn start_poll(app: AppHandle, secs: u64, stop: oneshot::Receiver<()>) {
    tauri::async_runtime::spawn(async move {
        let mut stop = stop;
        let mut tick = tokio::time::interval(Duration::from_secs(secs.max(15)));
        loop {
            tokio::select! {
                _ = &mut stop => break,
                _ = tick.tick() => {
                    let errors = poll_once(&app).await;
                    let _ = app.emit("alerts-poll", errors);
                }
            }
        }
    });
}

/// (Re)starts the poller according to the saved config.
pub async fn restart(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AlertsState>();
    if let Some(tx) = state.poll_stop.lock().unwrap().take() {
        let _ = tx.send(());
    }
    let cfg = config();
    if cfg.poll_enabled {
        let (tx, rx) = oneshot::channel();
        *state.poll_stop.lock().unwrap() = Some(tx);
        start_poll(app.clone(), cfg.poll_seconds, rx);
    }
    Ok(())
}

// ---------- commands ----------

#[derive(Serialize)]
pub struct AlertsView {
    current: Vec<Alert>,
    history: Vec<Alert>,
    firing: usize,
}

#[tauri::command]
pub fn alerts_get(state: State<AlertsState>, history_limit: Option<usize>) -> AlertsView {
    let d = state.data.lock().unwrap();
    let mut current: Vec<Alert> = d.current.values().cloned().collect();
    current.sort_by(|a, b| b.starts_at.cmp(&a.starts_at));
    AlertsView { firing: firing_count(&d), current, history: d.history.iter().take(history_limit.unwrap_or(300)).cloned().collect() }
}

#[tauri::command]
pub fn alerts_ack(app: AppHandle, state: State<AlertsState>, fingerprint: String, acked: bool) {
    let count = {
        let mut d = state.data.lock().unwrap();
        if let Some(a) = d.current.get_mut(&fingerprint) {
            a.acked = acked;
        }
        persist(&d);
        firing_count(&d)
    };
    let _ = app.emit("alerts-changed", count);
}

/// Forget current alerts (e.g. stale ones from a source that stopped sending) and/or history.
#[tauri::command]
pub fn alerts_clear(app: AppHandle, state: State<AlertsState>, current: bool, history: bool) {
    let count = {
        let mut d = state.data.lock().unwrap();
        if current {
            d.current.clear();
        }
        if history {
            d.history.clear();
        }
        persist(&d);
        firing_count(&d)
    };
    let _ = app.emit("alerts-changed", count);
}

#[tauri::command]
pub fn alerts_config_get() -> AlertsConfig {
    config()
}

#[tauri::command]
pub async fn alerts_config_set(app: AppHandle, config: AlertsConfig) -> Result<(), String> {
    store::save_json(CONFIG_FILE, &config)?;
    restart(&app).await
}

/// Poll right now (button in the UI); returns per-connector errors.
#[tauri::command]
pub async fn alerts_poll_now(app: AppHandle) -> Vec<String> {
    poll_once(&app).await
}
