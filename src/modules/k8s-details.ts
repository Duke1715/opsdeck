import { esc } from "./ui";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any;

export function age(s?: string): string {
  if (!s) return "";
  const sec = Math.max(0, Math.floor((Date.now() - Date.parse(s)) / 1000));
  if (sec < 120) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 120) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 730 ? `${d}d` : `${Math.floor(d / 365)}y`;
}

export function statusClass(s: string): string {
  if (/^(Running|Active|Bound|Ready|Available|Normal|True|Synced|Healthy|deployed)$/.test(s)) return "ok";
  if (/^(Succeeded|Completed|Suspended)$/.test(s)) return "muted";
  if (/(Pending|Creating|Terminating|Init:|Unknown|Released|Progressing|OutOfSync)/.test(s)) return "warn";
  return "bad";
}

/**
 * Subset of kubectl JSONPath used by CRD printer columns:
 * `.a.b`, `[0]`, `[*]`, `[?(@.x=="y")]` / `!=`. Multiple results are joined with ",".
 */
export function jsonPath(obj: Obj, path: string): string {
  let cur: Obj[] = [obj];
  let i = 0;
  const p = path.trim().replace(/^\{|\}$/g, "");
  while (i < p.length && cur.length) {
    if (p[i] === ".") {
      i++;
      let name = "";
      while (i < p.length && p[i] !== "." && p[i] !== "[") name += p[i++];
      if (name) cur = cur.map((v) => v?.[name]).filter((v) => v !== undefined);
    } else if (p[i] === "[") {
      const end = p.indexOf("]", p.indexOf(")", i) > -1 && p[i + 1] === "?" ? p.indexOf(")", i) : i);
      const inner = p.slice(i + 1, end);
      i = end + 1;
      const arrays = cur.filter(Array.isArray) as Obj[][];
      if (inner === "*") cur = arrays.flat();
      else if (/^-?\d+$/.test(inner)) cur = arrays.map((a) => a[Number(inner) < 0 ? a.length + Number(inner) : Number(inner)]).filter((v) => v !== undefined);
      else {
        const m = /^\?\(@\.([\w.-]+)\s*(==|!=)\s*['"]?([^'"]*)['"]?\)$/.exec(inner);
        if (!m) return "";
        const [, field, op, val] = m;
        const get = (e: Obj) => field.split(".").reduce((o, k) => o?.[k], e);
        cur = arrays.flat().filter((e) => (String(get(e)) === val) === (op === "=="));
      }
    } else i++;
  }
  return cur.map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v))).join(",");
}

// ---------- building blocks ----------

const row = (k: string, v: unknown, cls = "") =>
  v === undefined || v === null || v === "" ? "" : `<div class="dk">${esc(k)}</div><div class="dv ${cls}">${esc(v)}</div>`;
const grid = (rows: string) => (rows.trim() ? `<div class="dgrid">${rows}</div>` : "");
const section = (title: string, body: string) => (body.trim() ? `<section class="dsec"><h4>${esc(title)}</h4>${body}</section>` : "");
const table = (head: string[], rows: string[][], clsFor?: (r: number, c: number) => string) =>
  rows.length
    ? `<table class="res dtable"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
      rows.map((r, ri) => `<tr>${r.map((c, ci) => `<td class="${clsFor?.(ri, ci) ?? ""}">${esc(c)}</td>`).join("")}</tr>`).join("")
    }</tbody></table>`
    : "";
const when = (ts?: string) => (ts ? `${new Date(ts).toLocaleString()} (${age(ts)})` : "");
const chips = (m?: Record<string, string>) =>
  m && Object.keys(m).length ? `<div class="chips">${Object.entries(m).map(([k, v]) => `<span class="chip">${esc(k)}=${esc(v)}</span>`).join("")}</div>` : "";
const res = (r?: Obj) => (r ? Object.entries(r).map(([k, v]) => `${k}=${v}`).join(" ") : "");

function containerState(st?: Obj): string {
  if (!st) return "";
  if (st.running) return `running ${age(st.running.startedAt)}`;
  if (st.waiting) return `waiting: ${st.waiting.reason ?? ""}`;
  if (st.terminated) return `terminated: ${st.terminated.reason ?? ""} (${st.terminated.exitCode})`;
  return "";
}

function containers(spec: Obj, statuses: Obj[] = [], init = false) {
  const list: Obj[] = (init ? spec?.initContainers : spec?.containers) ?? [];
  if (!list.length) return "";
  const byName = new Map(statuses.map((s: Obj) => [s.name, s]));
  const rows = list.map((c) => {
    const s = byName.get(c.name);
    return [
      c.name, c.image,
      s ? containerState(s.state) : "",
      s ? (s.ready ? "да" : "нет") : "",
      s ? String(s.restartCount ?? 0) : "",
      res(c.resources?.requests), res(c.resources?.limits),
      (c.ports ?? []).map((p: Obj) => `${p.containerPort}/${p.protocol ?? "TCP"}`).join(", "),
    ];
  });
  const hasStatus = statuses.length > 0;
  const head = ["Контейнер", "Образ", ...(hasStatus ? ["Состояние", "Ready", "Рестарты"] : []), "Requests", "Limits", "Порты"];
  const trimmed = hasStatus ? rows : rows.map((r) => [r[0], r[1], r[5], r[6], r[7]]);
  return table(head, trimmed, (ri, ci) => {
    if (!hasStatus) return "";
    if (ci === 2) return trimmed[ri][2].startsWith("running") ? "ok" : trimmed[ri][2] ? "warn" : "";
    if (ci === 4) return Number(trimmed[ri][4]) > 0 ? "warn" : "";
    return ci === 1 ? "wrap" : "";
  });
}

function conditions(list?: Obj[]) {
  if (!list?.length) return "";
  return table(["Тип", "Статус", "Причина", "Сообщение", "Изменено"],
    list.map((c) => [c.type, c.status, c.reason ?? "", c.message ?? "", age(c.lastTransitionTime ?? c.lastUpdateTime)]),
    (ri, ci) => (ci === 1 ? (list[ri].status === "True" ? (/(Pressure|Unavailable|Failed)/.test(list[ri].type) ? "bad" : "ok") : "warn") : ci === 3 ? "wrap" : ""));
}

// ---------- per kind ----------

function kindSpecific(kind: string, o: Obj): string {
  const s = o.spec ?? {}, st = o.status ?? {};
  switch (kind) {
    case "pods":
      return section("Под", grid(
        row("Фаза", st.phase, statusClass(st.phase ?? "")) + row("Нода", s.nodeName) + row("Pod IP", st.podIP) + row("Host IP", st.hostIP) +
        row("QoS", st.qosClass) + row("ServiceAccount", s.serviceAccountName) + row("Restart policy", s.restartPolicy) +
        row("Запущен", when(st.startTime)) + row("Priority class", s.priorityClassName)))
        + section("Init-контейнеры", containers(s, st.initContainerStatuses, true))
        + section("Контейнеры", containers(s, st.containerStatuses))
        + section("Тома", table(["Имя", "Источник"], (s.volumes ?? []).map((v: Obj) => {
          const [src, cfg] = Object.entries(v).find(([k]) => k !== "name") ?? ["", {}];
          const ref = (cfg as Obj)?.claimName ?? (cfg as Obj)?.secretName ?? (cfg as Obj)?.name ?? (cfg as Obj)?.path ?? "";
          return [v.name, `${src}${ref ? `: ${ref}` : ""}`];
        })));
    case "deployments": case "statefulsets": case "daemonsets": case "replicasets": {
      const want = kind === "daemonsets" ? st.desiredNumberScheduled : s.replicas;
      const ready = kind === "daemonsets" ? st.numberReady : st.readyReplicas;
      return section("Реплики", grid(
        row("Нужно", want ?? 0) + row("Готово", ready ?? 0, (ready ?? 0) >= (want ?? 0) ? "ok" : "warn") +
        row("Обновлено", st.updatedReplicas ?? st.updatedNumberScheduled) + row("Доступно", st.availableReplicas ?? st.numberAvailable) +
        row("Стратегия", s.strategy?.type ?? s.updateStrategy?.type) + row("Селектор", res(s.selector?.matchLabels)) +
        row("Service", s.serviceName) + row("Revision history", s.revisionHistoryLimit)))
        + section("Контейнеры (шаблон)", containers(s.template?.spec));
    }
    case "jobs":
      return section("Job", grid(row("Completions", `${st.succeeded ?? 0}/${s.completions ?? 1}`) + row("Parallelism", s.parallelism) +
        row("Активно", st.active) + row("Ошибок", st.failed, st.failed ? "bad" : "") + row("Старт", when(st.startTime)) +
        row("Завершён", when(st.completionTime)) + row("Backoff limit", s.backoffLimit)))
        + section("Контейнеры", containers(s.template?.spec));
    case "cronjobs":
      return section("CronJob", grid(row("Расписание", s.schedule) + row("Часовой пояс", s.timeZone) + row("Suspend", s.suspend ? "да" : "нет", s.suspend ? "warn" : "") +
        row("Последний запуск", when(st.lastScheduleTime)) + row("Последний успех", when(st.lastSuccessfulTime)) +
        row("Активные jobs", (st.active ?? []).map((a: Obj) => a.name).join(", ")) + row("Concurrency", s.concurrencyPolicy)))
        + section("Контейнеры", containers(s.jobTemplate?.spec?.template?.spec));
    case "services":
      return section("Сервис", grid(row("Тип", s.type) + row("Cluster IP", (s.clusterIPs ?? [s.clusterIP]).join(", ")) +
        row("External", [...(s.externalIPs ?? []), ...(st.loadBalancer?.ingress ?? []).map((i: Obj) => i.ip ?? i.hostname)].join(", ")) +
        row("Селектор", res(s.selector)) + row("Session affinity", s.sessionAffinity) + row("External traffic", s.externalTrafficPolicy)))
        + section("Порты", table(["Имя", "Порт", "Target", "NodePort", "Протокол"],
          (s.ports ?? []).map((p: Obj) => [p.name ?? "", String(p.port), String(p.targetPort ?? ""), p.nodePort ? String(p.nodePort) : "", p.protocol ?? "TCP"])));
    case "ingresses":
      return section("Ingress", grid(row("Class", s.ingressClassName) +
        row("Адрес", (st.loadBalancer?.ingress ?? []).map((i: Obj) => i.ip ?? i.hostname).join(", ")) +
        row("TLS", (s.tls ?? []).map((t: Obj) => `${(t.hosts ?? []).join(", ")} → ${t.secretName ?? ""}`).join("; "))))
        + section("Правила", table(["Хост", "Путь", "Тип", "Backend"], (s.rules ?? []).flatMap((r: Obj) =>
          (r.http?.paths ?? []).map((p: Obj) => [r.host ?? "*", p.path ?? "/", p.pathType ?? "",
            p.backend?.service ? `${p.backend.service.name}:${p.backend.service.port?.number ?? p.backend.service.port?.name}` : JSON.stringify(p.backend)]))));
    case "nodes": {
      const ni = st.nodeInfo ?? {};
      const keys = ["cpu", "memory", "pods", "ephemeral-storage"];
      return section("Нода", grid(row("ОС", ni.osImage) + row("Ядро", ni.kernelVersion) + row("Runtime", ni.containerRuntimeVersion) +
        row("Kubelet", ni.kubeletVersion) + row("Архитектура", ni.architecture) +
        row("Адреса", (st.addresses ?? []).map((a: Obj) => `${a.type}: ${a.address}`).join(", ")) +
        row("Scheduling", s.unschedulable ? "отключён (cordon)" : "включён", s.unschedulable ? "warn" : "ok") + row("Pod CIDR", s.podCIDR)))
        + section("Ресурсы", table(["Ресурс", "Capacity", "Allocatable"], keys.map((k) => [k, st.capacity?.[k] ?? "", st.allocatable?.[k] ?? ""])))
        + section("Taints", table(["Ключ", "Значение", "Эффект"], (s.taints ?? []).map((t: Obj) => [t.key, t.value ?? "", t.effect])));
    }
    case "configmaps":
      return section("Ключи", table(["Ключ", "Размер"], Object.entries({ ...(o.data ?? {}), ...(o.binaryData ?? {}) })
        .map(([k, v]) => [k, `${String(v).length} байт`])));
    case "secrets":
      return section("Секрет", grid(row("Тип", o.type)))
        + section("Ключи", Object.keys(o.data ?? {}).length
          ? `<table class="res dtable"><thead><tr><th>Ключ</th><th>Размер</th><th></th></tr></thead><tbody>${
            Object.entries(o.data ?? {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${Math.floor(String(v).length * 3 / 4)} байт</td>
              <td><button class="ghost" data-secret="${esc(k)}">показать</button></td></tr>`).join("")}</tbody></table>` : "");
    case "persistentvolumeclaims":
      return section("PVC", grid(row("Статус", st.phase, statusClass(st.phase ?? "")) + row("Запрошено", s.resources?.requests?.storage) +
        row("Выделено", st.capacity?.storage) + row("Доступ", (s.accessModes ?? []).join(", ")) + row("StorageClass", s.storageClassName) +
        row("Volume", s.volumeName) + row("Volume mode", s.volumeMode)));
    case "persistentvolumes":
      return section("PV", grid(row("Статус", st.phase, statusClass(st.phase ?? "")) + row("Размер", s.capacity?.storage) +
        row("Доступ", (s.accessModes ?? []).join(", ")) + row("Reclaim", s.persistentVolumeReclaimPolicy) + row("StorageClass", s.storageClassName) +
        row("Claim", s.claimRef ? `${s.claimRef.namespace}/${s.claimRef.name}` : "")));
    case "applications": {
      const src = s.source ?? s.sources?.[0] ?? {};
      return section("Argo CD", grid(row("Sync", st.sync?.status, statusClass(st.sync?.status ?? "")) +
        row("Health", st.health?.status, statusClass(st.health?.status ?? "")) + row("Репозиторий", src.repoURL) +
        row("Путь / чарт", src.path ?? src.chart) + row("Ревизия", src.targetRevision) + row("Синхронизирована ревизия", st.sync?.revision) +
        row("Назначение", `${s.destination?.namespace ?? ""} @ ${s.destination?.name ?? s.destination?.server ?? ""}`) +
        row("Проект", s.project) + row("Автосинк", s.syncPolicy?.automated ? `да${s.syncPolicy.automated.prune ? ", prune" : ""}${s.syncPolicy.automated.selfHeal ? ", self-heal" : ""}` : "нет") +
        row("Операция", st.operationState ? `${st.operationState.phase}: ${st.operationState.message ?? ""}` : "",
          statusClass(st.operationState?.phase === "Succeeded" ? "Synced" : st.operationState?.phase ?? ""))));
    }
    default:
      return "";
  }
}

/** Details panel HTML for any object (built-in or custom resource). */
export function detailsHtml(kind: string, o: Obj, events: Obj[] | null): string {
  const m = o.metadata ?? {};
  const owners = (m.ownerReferences ?? []).map((r: Obj) => `${r.kind}/${r.name}`).join(", ");
  const ann = Object.entries((m.annotations ?? {}) as Record<string, string>);
  return `<div class="details">
    ${section("Общее", grid(row("Имя", m.name) + row("Namespace", m.namespace) + row("Создан", when(m.creationTimestamp)) +
      row("Владелец", owners) + row("UID", m.uid) + row("Finalizers", (m.finalizers ?? []).join(", ")) +
      row("Удаляется", m.deletionTimestamp ? when(m.deletionTimestamp) : "", "warn")))}
    ${kindSpecific(kind, o)}
    ${section("Условия", conditions(o.status?.conditions))}
    ${section("Метки", chips(m.labels))}
    ${ann.length ? section("Аннотации", `<details><summary class="muted">${ann.length} шт.</summary>${grid(ann.map(([k, v]) =>
      row(k, v.length > 400 ? v.slice(0, 400) + "…" : v)).join(""))}</details>`) : ""}
    ${section("События", events === null ? `<p class="muted">загрузка…</p>` : events.length
      ? table(["Когда", "Тип", "Причина", "Сообщение", "×"], events.map((e) => [age(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp),
        e.type ?? "", e.reason ?? "", e.message ?? "", String(e.count ?? 1)]), (ri, ci) => (ci === 1 ? (events[ri].type === "Warning" ? "warn" : "muted") : ci === 3 ? "wrap" : ""))
      : `<p class="muted">Событий нет (Kubernetes хранит их около часа)</p>`)}
  </div>`;
}
