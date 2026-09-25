//! Kubernetes: kubeconfig sources, resource listing/editing via kube-rs, pod log streaming.
//! Interactive things (exec, port-forward, a shell bound to a context) run `kubectl` in a
//! terminal tab with KUBECONFIG pointing at a single-context file from `k8s_shell_config`.

use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::{
    api::{Api, ApiResource, DeleteParams, DynamicObject, GroupVersionKind, ListParams, LogParams, Patch, PatchParams},
    config::{KubeConfigOptions, Kubeconfig},
    Client, Config,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, Mutex};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct K8sState {
    clients: Mutex<HashMap<(String, String), Client>>,
    logs: std::sync::Mutex<HashMap<String, oneshot::Sender<()>>>,
}

#[derive(Deserialize, Clone)]
pub struct Ctx {
    file: String,
    context: String,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---------- kubeconfig sources ----------

fn imported_dir() -> Result<PathBuf, String> {
    let dir = dirs::config_dir().ok_or("no config dir")?.join("opsdeck").join("kubeconfigs");
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn sources() -> Vec<(PathBuf, &'static str)> {
    let mut out: Vec<(PathBuf, &'static str)> = Vec::new();
    let mut push = |p: PathBuf, kind| {
        if p.is_file() && !out.iter().any(|(x, _)| *x == p) {
            out.push((p, kind));
        }
    };
    if let Ok(env) = std::env::var("KUBECONFIG") {
        env.split(':').filter(|s| !s.is_empty()).for_each(|s| push(s.into(), "env"));
    }
    if let Some(home) = dirs::home_dir() {
        push(home.join(".kube/config"), "kube");
    }
    if let Ok(dir) = imported_dir() {
        let mut files: Vec<_> = fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| matches!(p.extension().and_then(|e| e.to_str()), Some("yaml" | "yml")))
            .collect();
        files.sort();
        files.into_iter().for_each(|p| push(p, "imported"));
    }
    out
}

fn read_yaml(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_yaml_ng::from_str(&raw).map_err(|e| format!("{}: {e}", path.display()))
}

fn named<'a>(cfg: &'a Value, list: &str, name: &str) -> Option<&'a Value> {
    cfg[list].as_array()?.iter().find(|x| x["name"] == name)
}

#[derive(Serialize)]
pub struct CtxInfo {
    file: String,
    source: &'static str,
    label: String,
    context: String,
    cluster: String,
    user: String,
    namespace: String,
    current: bool,
    server: String,
}

#[tauri::command]
pub fn k8s_contexts() -> Vec<CtxInfo> {
    let mut out = Vec::new();
    for (path, source) in sources() {
        let Ok(cfg) = read_yaml(&path) else { continue };
        let current = cfg["current-context"].as_str().unwrap_or_default();
        let label = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        for c in cfg["contexts"].as_array().into_iter().flatten() {
            let name = c["name"].as_str().unwrap_or_default();
            let cluster = c["context"]["cluster"].as_str().unwrap_or_default();
            out.push(CtxInfo {
                file: path.to_string_lossy().into_owned(),
                source,
                label: label.clone(),
                context: name.into(),
                cluster: cluster.into(),
                user: c["context"]["user"].as_str().unwrap_or_default().into(),
                namespace: c["context"]["namespace"].as_str().unwrap_or("default").into(),
                current: name == current,
                server: named(&cfg, "clusters", cluster)
                    .and_then(|x| x["cluster"]["server"].as_str())
                    .unwrap_or_default()
                    .into(),
            });
        }
    }
    out
}

fn sanitize(s: &str) -> String {
    let s: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' })
        .collect();
    s.trim_matches('.').chars().take(80).collect()
}

fn write_private(path: &Path, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(err)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(err)
}

/// Import from pasted YAML or from a file path (drag & drop). Returns the number of contexts.
#[tauri::command]
pub fn k8s_import(name: Option<String>, yaml: Option<String>, path: Option<String>) -> Result<usize, String> {
    let (raw, default_name) = match (yaml, path) {
        (Some(y), _) if !y.trim().is_empty() => (y, "cluster".to_string()),
        (_, Some(p)) => {
            let p = PathBuf::from(p);
            let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            (fs::read_to_string(&p).map_err(err)?, stem)
        }
        _ => return Err("нужен YAML или путь к файлу".into()),
    };
    let cfg: Value = serde_yaml_ng::from_str(&raw).map_err(|e| format!("это не YAML: {e}"))?;
    let count = cfg["contexts"].as_array().map_or(0, Vec::len);
    if count == 0 || cfg["clusters"].as_array().is_none_or(Vec::is_empty) {
        return Err("в файле нет contexts/clusters — это не kubeconfig".into());
    }
    let name = sanitize(name.as_deref().filter(|n| !n.trim().is_empty()).unwrap_or(&default_name));
    if name.is_empty() {
        return Err("пустое имя".into());
    }
    let target = imported_dir()?.join(format!("{name}.yaml"));
    if target.exists() {
        return Err(format!("«{name}» уже импортирован — выберите другое имя"));
    }
    write_private(&target, &raw)?;
    Ok(count)
}

#[tauri::command]
pub async fn k8s_remove_source(state: State<'_, K8sState>, file: String) -> Result<(), String> {
    let path = PathBuf::from(&file);
    if path.parent() != Some(imported_dir()?.as_path()) {
        return Err("удалять можно только импортированные файлы".into());
    }
    fs::remove_file(path).map_err(err)?;
    state.clients.lock().await.retain(|(f, _), _| *f != file);
    Ok(())
}

/// Single-context kubeconfig for kubectl/helm/k9s in a terminal tab. Relative cert paths are
/// made absolute so the file works from its new location.
#[tauri::command]
pub fn k8s_shell_config(ctx: Ctx, namespace: Option<String>) -> Result<String, String> {
    let src = PathBuf::from(&ctx.file);
    let cfg = read_yaml(&src)?;
    let mut c = named(&cfg, "contexts", &ctx.context).ok_or("context not found")?.clone();
    if let Some(ns) = namespace.filter(|n| !n.is_empty()) {
        c["context"]["namespace"] = json!(ns);
    }
    let base = src.parent().unwrap_or(Path::new("/"));
    let absolutize = |mut v: Value, section: &str, keys: &[&str]| {
        for k in keys {
            if let Some(p) = v[section][*k].as_str().filter(|p| Path::new(p).is_relative()) {
                v[section][*k] = json!(base.join(p).to_string_lossy());
            }
        }
        v
    };
    let cluster = named(&cfg, "clusters", c["context"]["cluster"].as_str().unwrap_or_default())
        .cloned()
        .map(|v| absolutize(v, "cluster", &["certificate-authority"]));
    let user = named(&cfg, "users", c["context"]["user"].as_str().unwrap_or_default())
        .cloned()
        .map(|v| absolutize(v, "user", &["client-certificate", "client-key"]));

    let out = json!({
        "apiVersion": "v1",
        "kind": "Config",
        "current-context": ctx.context,
        "contexts": [c],
        "clusters": cluster.into_iter().collect::<Vec<_>>(),
        "users": user.into_iter().collect::<Vec<_>>(),
    });
    let dir = dirs::config_dir().ok_or("no config dir")?.join("opsdeck").join("run");
    fs::create_dir_all(&dir).map_err(err)?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(err)?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let path = dir.join(format!("{}.yaml", sanitize(&format!("{stem}-{}", ctx.context))));
    write_private(&path, &serde_yaml_ng::to_string(&out).map_err(err)?)?;
    Ok(path.to_string_lossy().into_owned())
}

// ---------- per-context preferences ----------

const PREFS_FILE: &str = "k8s.json";

/// Contexts are keyed as "<kubeconfig file>|<context name>".
#[derive(Serialize, Deserialize, Default)]
pub struct K8sPrefs {
    #[serde(default)]
    hidden: Vec<String>,
    /// Read-only contexts: apply / delete / scale / restart are refused by the backend.
    #[serde(default)]
    readonly: Vec<String>,
}

fn ctx_key(ctx: &Ctx) -> String {
    format!("{}|{}", ctx.file, ctx.context)
}

#[tauri::command]
pub fn k8s_prefs_get() -> K8sPrefs {
    crate::store::load_json(PREFS_FILE).unwrap_or_default()
}

#[tauri::command]
pub fn k8s_prefs_set(prefs: K8sPrefs) -> Result<(), String> {
    crate::store::save_json(PREFS_FILE, &prefs)
}

fn ensure_writable(ctx: &Ctx) -> Result<(), String> {
    if k8s_prefs_get().readonly.contains(&ctx_key(ctx)) {
        return Err(format!("контекст «{}» в режиме только чтения — снимите 🔒, чтобы менять ресурсы", ctx.context));
    }
    Ok(())
}

// ---------- API access ----------

async fn client(state: &K8sState, ctx: &Ctx) -> Result<Client, String> {
    let key = (ctx.file.clone(), ctx.context.clone());
    if let Some(c) = state.clients.lock().await.get(&key) {
        return Ok(c.clone());
    }
    let kc = Kubeconfig::read_from(&ctx.file).map_err(err)?;
    let opts = KubeConfigOptions { context: Some(ctx.context.clone()), ..Default::default() };
    let mut cfg = Config::from_custom_kubeconfig(kc, &opts).await.map_err(err)?;
    cfg.connect_timeout = Some(Duration::from_secs(5));
    // log follow streams can be silent for a long time; per-request timeouts are applied below
    cfg.read_timeout = None;
    let c = Client::try_from(cfg).map_err(err)?;
    state.clients.lock().await.insert(key, c.clone());
    Ok(c)
}

/// Drop a cached client after a failure so expired exec/oidc tokens get re-fetched.
async fn forget(state: &K8sState, ctx: &Ctx) {
    state.clients.lock().await.remove(&(ctx.file.clone(), ctx.context.clone()));
}

async fn timed<T, E: std::fmt::Display>(fut: impl std::future::Future<Output = Result<T, E>>) -> Result<T, String> {
    match tokio::time::timeout(REQUEST_TIMEOUT, fut).await {
        Ok(r) => r.map_err(err),
        Err(_) => Err("таймаут запроса к API (20 с)".into()),
    }
}

/// (group, version, kind, plural, namespaced)
const KINDS: &[(&str, &str, &str, &str, bool)] = &[
    ("", "v1", "Pod", "pods", true),
    ("apps", "v1", "Deployment", "deployments", true),
    ("apps", "v1", "StatefulSet", "statefulsets", true),
    ("apps", "v1", "DaemonSet", "daemonsets", true),
    ("apps", "v1", "ReplicaSet", "replicasets", true),
    ("batch", "v1", "Job", "jobs", true),
    ("batch", "v1", "CronJob", "cronjobs", true),
    ("", "v1", "Service", "services", true),
    ("networking.k8s.io", "v1", "Ingress", "ingresses", true),
    ("", "v1", "ConfigMap", "configmaps", true),
    ("", "v1", "Secret", "secrets", true),
    ("", "v1", "PersistentVolumeClaim", "persistentvolumeclaims", true),
    ("", "v1", "Event", "events", true),
    ("", "v1", "Node", "nodes", false),
    ("", "v1", "Namespace", "namespaces", false),
    ("", "v1", "PersistentVolume", "persistentvolumes", false),
];

fn api(client: Client, kind: &str, ns: Option<&str>) -> Result<Api<DynamicObject>, String> {
    let &(g, v, k, plural, namespaced) =
        KINDS.iter().find(|x| x.3 == kind).ok_or_else(|| format!("unknown kind {kind}"))?;
    let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(g, v, k), plural);
    Ok(match (namespaced, ns.filter(|n| !n.is_empty())) {
        (true, Some(ns)) => Api::namespaced_with(client, ns, &ar),
        _ => Api::all_with(client, &ar),
    })
}

fn clean(mut v: Value) -> Value {
    if let Some(meta) = v.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.remove("managedFields");
        if let Some(a) = meta.get_mut("annotations").and_then(Value::as_object_mut) {
            a.remove("kubectl.kubernetes.io/last-applied-configuration");
        }
    }
    v
}

#[tauri::command]
pub async fn k8s_list(
    state: State<'_, K8sState>,
    ctx: Ctx,
    kind: String,
    namespace: Option<String>,
) -> Result<Vec<Value>, String> {
    let c = client(&state, &ctx).await?;
    let res = timed(api(c, &kind, namespace.as_deref())?.list(&ListParams::default())).await;
    match res {
        Ok(list) => Ok(list.items.into_iter().filter_map(|o| serde_json::to_value(o).ok()).map(clean).collect()),
        Err(e) => {
            forget(&state, &ctx).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn k8s_get_yaml(
    state: State<'_, K8sState>,
    ctx: Ctx,
    kind: String,
    namespace: Option<String>,
    name: String,
) -> Result<String, String> {
    let c = client(&state, &ctx).await?;
    let obj = timed(api(c, &kind, namespace.as_deref())?.get(&name)).await?;
    serde_yaml_ng::to_string(&clean(serde_json::to_value(obj).map_err(err)?)).map_err(err)
}

/// Server-side apply of an edited manifest. resourceVersion (if kept) acts as a conflict guard.
#[tauri::command]
pub async fn k8s_apply_yaml(
    state: State<'_, K8sState>,
    ctx: Ctx,
    kind: String,
    namespace: Option<String>,
    yaml: String,
) -> Result<(), String> {
    ensure_writable(&ctx)?;
    let v = clean(serde_yaml_ng::from_str::<Value>(&yaml).map_err(|e| format!("YAML: {e}"))?);
    let name = v["metadata"]["name"].as_str().ok_or("metadata.name missing")?.to_string();
    let ns = v["metadata"]["namespace"].as_str().map(str::to_string).or(namespace);
    let c = client(&state, &ctx).await?;
    let params = PatchParams::apply("opsdeck").force();
    timed(api(c, &kind, ns.as_deref())?.patch(&name, &params, &Patch::Apply(&v))).await?;
    Ok(())
}

#[tauri::command]
pub async fn k8s_delete(
    state: State<'_, K8sState>,
    ctx: Ctx,
    kind: String,
    namespace: Option<String>,
    name: String,
) -> Result<(), String> {
    ensure_writable(&ctx)?;
    let c = client(&state, &ctx).await?;
    timed(api(c, &kind, namespace.as_deref())?.delete(&name, &DeleteParams::default())).await?;
    Ok(())
}

#[tauri::command]
pub async fn k8s_scale(
    state: State<'_, K8sState>,
    ctx: Ctx,
    kind: String,
    namespace: String,
    name: String,
    replicas: u32,
) -> Result<(), String> {
    ensure_writable(&ctx)?;
    if !matches!(kind.as_str(), "deployments" | "statefulsets" | "replicasets") {
        return Err("scale не поддерживается для этого типа".into());
    }
    let c = client(&state, &ctx).await?;
    let patch = json!({ "spec": { "replicas": replicas } });
    timed(api(c, &kind, Some(&namespace))?.patch(&name, &PatchParams::default(), &Patch::Merge(&patch))).await?;
    Ok(())
}

/// Same as `kubectl rollout restart`.
#[tauri::command]
pub async fn k8s_restart(
    state: State<'_, K8sState>,
    ctx: Ctx,
    kind: String,
    namespace: String,
    name: String,
) -> Result<(), String> {
    ensure_writable(&ctx)?;
    if !matches!(kind.as_str(), "deployments" | "statefulsets" | "daemonsets") {
        return Err("restart не поддерживается для этого типа".into());
    }
    let c = client(&state, &ctx).await?;
    let now = chrono::Utc::now().to_rfc3339();
    let patch = json!({ "spec": { "template": { "metadata": { "annotations": {
        "kubectl.kubernetes.io/restartedAt": now } } } } });
    timed(api(c, &kind, Some(&namespace))?.patch(&name, &PatchParams::default(), &Patch::Merge(&patch))).await?;
    Ok(())
}

// ---------- logs ----------

#[derive(Deserialize)]
pub struct LogRequest {
    namespace: String,
    pod: String,
    container: Option<String>,
    tail: Option<i64>,
    previous: Option<bool>,
    timestamps: Option<bool>,
}

/// Streams lines as `k8s-log-{id}` (batched), then `k8s-log-end-{id}` with an optional error.
#[tauri::command]
pub async fn k8s_logs_start(
    app: AppHandle,
    state: State<'_, K8sState>,
    ctx: Ctx,
    id: String,
    req: LogRequest,
) -> Result<(), String> {
    let c = client(&state, &ctx).await?;
    let pods: Api<Pod> = Api::namespaced(c, &req.namespace);
    let previous = req.previous.unwrap_or(false);
    let lp = LogParams {
        container: req.container.filter(|c| !c.is_empty()),
        follow: !previous,
        previous,
        tail_lines: Some(req.tail.unwrap_or(500)),
        timestamps: req.timestamps.unwrap_or(false),
        ..Default::default()
    };
    let reader = timed(pods.log_stream(&req.pod, &lp)).await?;

    let (tx, mut rx) = oneshot::channel();
    if let Some(old) = state.logs.lock().unwrap().insert(id.clone(), tx) {
        let _ = old.send(());
    }

    tauri::async_runtime::spawn(async move {
        let mut lines = reader.lines();
        let mut batch: Vec<String> = Vec::new();
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        let data_event = format!("k8s-log-{id}");
        let error = loop {
            tokio::select! {
                _ = &mut rx => break None,
                _ = tick.tick() => {
                    if !batch.is_empty() { let _ = app.emit(&data_event, std::mem::take(&mut batch)); }
                }
                line = lines.next() => match line {
                    Some(Ok(l)) => {
                        batch.push(l);
                        if batch.len() >= 1000 { let _ = app.emit(&data_event, std::mem::take(&mut batch)); }
                    }
                    Some(Err(e)) => break Some(e.to_string()),
                    None => break None,
                },
            }
        };
        if !batch.is_empty() {
            let _ = app.emit(&data_event, batch);
        }
        let _ = app.emit(&format!("k8s-log-end-{id}"), error);
    });
    Ok(())
}

#[tauri::command]
pub fn k8s_logs_stop(state: State<K8sState>, id: String) {
    if let Some(tx) = state.logs.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}
