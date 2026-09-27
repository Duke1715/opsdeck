//! Web panels (Grafana, ArgoCD, GitLab…) embedded as tabs of the main window.
//!
//! Tauri's multiwebview on Linux packs child webviews into the window's GtkBox next to the main
//! webview, where positioning has no effect. So at startup the main webview is wrapped in a
//! GtkOverlay with a click-through GtkFixed on top; embedded webviews are created through Tauri
//! (init scripts, navigation and eval keep working) and then moved into that GtkFixed, where the
//! UI places them over the tab's content area. All GTK work happens on the main thread.

use crate::{connectors, keepass::KeepassState};
use serde::Deserialize;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, WebviewUrl};

#[derive(Deserialize, Clone, Copy)]
pub struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn label(id: &str) -> String {
    format!("emb-{id}")
}

#[cfg(target_os = "linux")]
mod gtk_layer {
    use gtk::prelude::*;
    use std::cell::RefCell;

    thread_local! {
        static LAYER: RefCell<Option<gtk::Fixed>> = const { RefCell::new(None) };
    }

    /// Main window: vbox > [main webview]  →  vbox > overlay > [main webview, fixed (on top)].
    pub fn install(vbox: &gtk::Box) -> Result<(), String> {
        let main = vbox.children().into_iter().last().ok_or("main webview not found")?;
        vbox.remove(&main);
        let overlay = gtk::Overlay::new();
        overlay.add(&main);
        let fixed = gtk::Fixed::new();
        overlay.add_overlay(&fixed);
        // empty parts of the layer let clicks through to the app UI; embedded webviews have
        // their own GdkWindows and still receive input
        overlay.set_overlay_pass_through(&fixed, true);
        vbox.pack_start(&overlay, true, true, 0);
        overlay.show_all();
        LAYER.with(|l| *l.borrow_mut() = Some(fixed));
        Ok(())
    }

    pub fn place(wv: &webkit2gtk::WebView, r: super::Rect) {
        LAYER.with(|l| {
            let Some(fixed) = l.borrow().clone() else { return };
            let (x, y, w, h) = (r.x.round() as i32, r.y.round() as i32, r.w.round().max(1.0) as i32, r.h.round().max(1.0) as i32);
            if wv.parent().as_ref() != Some(fixed.upcast_ref::<gtk::Widget>()) {
                if let Some(parent) = wv.parent().and_then(|p| p.downcast::<gtk::Container>().ok()) {
                    parent.remove(wv);
                }
                fixed.put(wv, x, y);
            } else {
                fixed.move_(wv, x, y);
            }
            wv.set_size_request(w, h);
            wv.show();
        });
    }
}

/// Called from `setup` (main thread).
pub fn install(app: &AppHandle) {
    // escape hatch if the GTK re-layout misbehaves on some system
    if std::env::var_os("OPSDECK_NO_EMBED").is_some() {
        return;
    }
    #[cfg(target_os = "linux")]
    {
        let res = app
            .get_webview_window("main")
            .ok_or_else(|| "no main window".to_string())
            .and_then(|w| w.default_vbox().map_err(|e| e.to_string()))
            .and_then(|vbox| gtk_layer::install(&vbox));
        if let Err(e) = res {
            eprintln!("embedded web panels unavailable: {e}");
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

fn place(wv: &tauri::Webview, r: Rect) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return wv.with_webview(move |pw| gtk_layer::place(&pw.inner(), r)).map_err(|e| e.to_string());
    #[cfg(not(target_os = "linux"))]
    {
        wv.set_position(LogicalPosition::new(r.x, r.y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(r.w, r.h)).map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())
    }
}

/// Creates the panel on first use, then shows it over `rect` (logical px, window-relative).
/// `url` (optional) opens a specific page, e.g. a dashboard from an alert; it must be on the
/// connector's origin so credentials never go to another site.
#[tauri::command]
pub async fn web_embed_show(app: AppHandle, kp: State<'_, KeepassState>, id: String, rect: Rect, url: Option<String>) -> Result<(), String> {
    let (_, base, script) = connectors::prepare(&kp, &id)?;
    let target = match url {
        Some(u) => {
            let u = tauri::Url::parse(&u).map_err(|e| e.to_string())?;
            if u.origin() != base.origin() {
                return Err("адрес не относится к этому коннектору".into());
            }
            Some(u)
        }
        None => None,
    };
    if let Some(wv) = app.get_webview(&label(&id)) {
        if let Some(u) = target {
            wv.navigate(u).map_err(|e| e.to_string())?;
        }
        return place(&wv, rect);
    }
    let url = target.unwrap_or(base);
    let window = app.get_window("main").ok_or("no main window")?;
    let mut builder = tauri::webview::WebviewBuilder::new(label(&id), WebviewUrl::External(url));
    if let Some(js) = script {
        builder = builder.initialization_script(&js);
    }
    let wv = window
        .add_child(builder, LogicalPosition::new(rect.x, rect.y), LogicalSize::new(rect.w, rect.h))
        .map_err(|e| e.to_string())?;
    place(&wv, rect)
}

#[tauri::command]
pub fn web_embed_hide(app: AppHandle, id: Option<String>) -> Result<(), String> {
    for (l, wv) in app.webviews() {
        if l.starts_with("emb-") && id.as_ref().is_none_or(|i| l == label(i)) {
            wv.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn web_embed_close(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label(&id)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// back | forward | reload | home
#[tauri::command]
pub fn web_embed_nav(app: AppHandle, kp: State<KeepassState>, id: String, action: String) -> Result<(), String> {
    let wv = app.get_webview(&label(&id)).ok_or("панель не открыта")?;
    let r = match action.as_str() {
        "back" => wv.eval("history.back()"),
        "forward" => wv.eval("history.forward()"),
        "reload" => wv.reload(),
        "home" => wv.navigate(connectors::prepare(&kp, &id)?.1),
        _ => return Err("unknown action".into()),
    };
    r.map_err(|e| e.to_string())
}

/// Opens an http(s) URL in the system browser.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let u = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err("только http(s)".into());
    }
    crate::store::open_with_system(u.as_str())
}
