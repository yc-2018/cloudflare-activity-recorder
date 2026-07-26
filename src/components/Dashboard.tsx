import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BatteryCharging,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Cpu,
  LogOut,
  Monitor,
  RefreshCw,
  Search,
  Timer,
  Zap,
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import { addDays, formatDuration, inclusiveRange, localDateString, rangeDays } from "../lib/date";
import type { EventPage, FilterOptions, Report } from "../types";
import { AppDurationChart, MetricsChart } from "./Charts";
import { AppActivityTimeline } from "./AppActivityTimeline";
import { Timeline } from "./Timeline";

interface DashboardProps {
  authEnabled: boolean;
  onLogout: () => void;
  onUnauthorized: () => void;
}

function validDate(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00`)));
}

function initialFilters() {
  const params = new URLSearchParams(window.location.search);
  const today = localDateString();
  const from = validDate(params.get("from")) ? params.get("from")! : today;
  const candidateTo = validDate(params.get("to")) ? params.get("to")! : from;
  return {
    from,
    to: candidateTo >= from ? candidateTo : from,
    device: params.get("device") ?? "",
    app: params.get("app") ?? "",
    query: params.get("q") ?? "",
  };
}

function metric(value: number | null, suffix = "%") {
  return value === null ? "--" : `${value}${suffix}`;
}

export function Dashboard({ authEnabled, onLogout, onUnauthorized }: DashboardProps) {
  const initial = useMemo(initialFilters, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [device, setDevice] = useState(initial.device);
  const [app, setApp] = useState(initial.app);
  const [query, setQuery] = useState(initial.query);
  const [queryDraft, setQueryDraft] = useState(initial.query);
  const [options, setOptions] = useState<FilterOptions>({ devices: [], apps: [] });
  const [report, setReport] = useState<Report | null>(null);
  const [events, setEvents] = useState<EventPage>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const range = useMemo(() => inclusiveRange(from, to), [from, to]);

  const params = useMemo(() => {
    const value = new URLSearchParams({ from: range.fromIso, to: range.toIso });
    if (device) value.set("device", device);
    if (app) value.set("app", app);
    if (query) value.set("q", query);
    return value;
  }, [range, device, app, query]);

  useEffect(() => {
    api<FilterOptions>("/api/v1/filters")
      .then(setOptions)
      .catch((requestError) => {
        if (requestError instanceof ApiError && requestError.status === 401) onUnauthorized();
      });
  }, [onUnauthorized]);

  useEffect(() => {
    const urlParams = new URLSearchParams();
    if (from !== localDateString() || to !== from) urlParams.set("from", from);
    if (to !== from) urlParams.set("to", to);
    if (device) urlParams.set("device", device);
    if (app) urlParams.set("app", app);
    if (query) urlParams.set("q", query);
    history.replaceState(null, "", `${location.pathname}${urlParams.size ? `?${urlParams}` : ""}`);

    const controller = new AbortController();
    setLoading(true);
    setError("");
    Promise.all([
      api<Report>(`/api/v1/report?${params}`, { signal: controller.signal }),
      api<EventPage>(`/api/v1/events?${params}&limit=50`, { signal: controller.signal }),
    ])
      .then(([nextReport, eventPage]) => {
        setReport(nextReport);
        setEvents(eventPage);
      })
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        if (requestError instanceof ApiError && requestError.status === 401) {
          onUnauthorized();
          return;
        }
        setError(requestError instanceof Error ? requestError.message : "加载失败");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [app, device, from, onUnauthorized, params, query, to]);

  function shift(direction: number) {
    const days = rangeDays(from, to);
    setFrom(addDays(from, direction * days));
    setTo(addDays(to, direction * days));
  }

  function setToday() {
    const today = localDateString();
    setFrom(today);
    setTo(today);
  }

  function search(event: FormEvent) {
    event.preventDefault();
    setQuery(queryDraft.trim());
  }

  async function loadMore() {
    if (!events.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<EventPage>(`/api/v1/events?${params}&limit=50&cursor=${encodeURIComponent(events.nextCursor)}`);
      setEvents((current) => ({ items: [...current.items, ...page.items], nextCursor: page.nextCursor }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark small"><Activity size={19} /></span>
          <div><strong>活动记录</strong><span>工作台</span></div>
        </div>
        <div className="topbar-actions">
          <span className="timezone"><Monitor size={15} />{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
          {authEnabled && (
            <button className="icon-button" onClick={logout} title="退出登录" aria-label="退出登录"><LogOut size={18} /></button>
          )}
        </div>
      </header>

      <main className="dashboard">
        <section className="page-heading">
          <div><p className="eyebrow">DAILY ACTIVITY</p><h1>今天干了什么</h1></div>
          <button className="secondary-button" onClick={() => location.reload()}><RefreshCw size={16} />刷新</button>
        </section>

        <section className="filter-band" aria-label="筛选条件">
          <div className="date-controls">
            <button className="icon-button previous-period" onClick={() => shift(-1)} title="上一时段" aria-label="上一时段"><ChevronLeft size={18} /></button>
            <label><span>开始日期</span><input type="date" value={from} onChange={(event) => {
              const value = event.target.value; setFrom(value); if (value > to) setTo(value);
            }} /></label>
            <span className="date-separator">至</span>
            <label><span>结束日期</span><input type="date" min={from} value={to} onChange={(event) => setTo(event.target.value)} /></label>
            <button className="icon-button next-period" onClick={() => shift(1)} title="下一时段" aria-label="下一时段"><ChevronRight size={18} /></button>
            <button className="text-button" onClick={setToday}>今天</button>
          </div>
          <div className="filter-controls">
            <label><span>设备</span><select value={device} onChange={(event) => setDevice(event.target.value)}>
              <option value="">全部设备</option>
              {options.devices.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
            </select></label>
            <label><span>应用</span><select value={app} onChange={(event) => setApp(event.target.value)}>
              <option value="">全部应用</option>
              {options.apps.map((item) => <option value={item} key={item}>{item}</option>)}
            </select></label>
            <form className="search-control" onSubmit={search}>
              <label htmlFor="title-search">窗口标题</label>
              <div><Search size={16} /><input id="title-search" value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} placeholder="搜索标题" /><button aria-label="搜索">查询</button></div>
            </form>
          </div>
        </section>

        {error && <div className="error-banner" role="alert">{error}</div>}
        {loading && <div className="loading-state"><RefreshCw className="spin" size={20} />正在读取活动记录...</div>}

        {!loading && report && (
          <>
            {report.truncated && <div className="notice-banner">此范围超过 20,000 条采样，图表仅展示最早的 20,000 条；请缩小日期范围。</div>}
            <section className="summary-grid" aria-label="活动摘要">
              <article className="summary-card"><span className="summary-icon green"><Timer size={18} /></span><div><small>记录时长</small><strong>{formatDuration(report.summary.totalMs)}</strong></div></article>
              <article className="summary-card"><span className="summary-icon red"><Zap size={18} /></span><div><small>窗口切换</small><strong>{report.summary.switches}</strong></div></article>
              <article className="summary-card"><span className="summary-icon blue"><CalendarDays size={18} /></span><div><small>采样事件</small><strong>{report.summary.events}</strong></div></article>
              <article className="summary-card"><span className="summary-icon gold"><Cpu size={18} /></span><div><small>平均 / 最高 CPU</small><strong>{metric(report.summary.averageCpu)} <em>/ {metric(report.summary.maximumCpu)}</em></strong></div></article>
              <article className="summary-card"><span className="summary-icon violet"><BatteryCharging size={18} /></span><div><small>电量变化</small><strong>{report.summary.batteryDelta === null ? "--" : `${report.summary.batteryDelta > 0 ? "+" : ""}${report.summary.batteryDelta}%`}</strong></div></article>
            </section>

            <section className="panel full-panel">
              <div className="panel-heading"><div><h2>活动时间线</h2><p>连续相同窗口已合并，单次采样最多计入 5 分钟</p></div></div>
              <Timeline timeline={report.timeline} from={Date.parse(range.fromIso)} to={Date.parse(range.toIso)} />
            </section>

            <section className="chart-grid">
              <article className="panel"><div className="panel-heading"><div><h2>应用使用排行</h2><p>按推算使用时长排序，点击应用可筛选</p></div></div><div className="chart-body app-chart"><AppDurationChart apps={report.apps} onSelectApp={setApp} /></div></article>
              <article className="panel"><div className="panel-heading"><div><h2>系统状态</h2><p>CPU、内存和电量；三角点表示正在充电</p></div></div><div className="chart-body"><MetricsChart metrics={report.metrics} /></div></article>
            </section>

            <section className="panel full-panel">
              <div className="panel-heading"><div><h2>应用活动分布</h2><p>每行一个应用，色块表示连续使用区间</p></div></div>
              <AppActivityTimeline
                timeline={report.timeline}
                from={Date.parse(range.fromIso)}
                to={Date.parse(range.toIso)}
                onSelectApp={setApp}
              />
            </section>

            <section className="panel full-panel table-panel">
              <div className="panel-heading"><div><h2>采样明细</h2><p>共显示 {events.items.length} 条</p></div></div>
              {events.items.length ? (
                <div className="table-scroll"><table><thead><tr><th>时间</th><th>设备</th><th>应用</th><th>窗口标题</th><th>CPU</th><th>内存</th><th>电量</th><th>原因</th></tr></thead>
                  <tbody>{events.items.map((item) => <tr key={item.id}>
                    <td className="nowrap">{new Date(item.observedAt).toLocaleString()}</td><td>{item.deviceName}</td><td><span className="app-label">{item.processName}</span></td>
                    <td className="title-cell" title={item.windowTitle}>{item.windowTitle || "（无标题）"}</td><td>{item.cpuPercent}%</td><td>{item.memoryPercent}%</td>
                    <td>{item.batteryPercent === null ? "--" : `${item.batteryPercent}%${item.powerPlugged ? " 充电" : ""}`}</td><td>{item.trigger === "window_change" ? "切换" : "心跳"}</td>
                  </tr>)}</tbody></table></div>
              ) : <div className="empty-chart">当前筛选条件下没有记录</div>}
              {events.nextCursor && <div className="load-more"><button className="secondary-button" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "加载中..." : "加载更多"}</button></div>}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
