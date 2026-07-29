import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BatteryCharging,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Cpu,
  LockKeyhole,
  LogOut,
  Monitor,
  RefreshCw,
  Search,
  Timer,
  Zap,
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import {
  addDays,
  addMonths,
  addYears,
  formatDuration,
  inclusiveRange,
  localDateString,
  localMonthRange,
  localYearRange,
  monthDays,
} from "../lib/date";
import type { EventPage, FilterOptions, Overview, OverviewPoint, Report, ViewMode } from "../types";
import { AppDurationChart, MetricsChart } from "./Charts";
import { AppActivityTimeline } from "./AppActivityTimeline";
import { DetailsLogin } from "./DetailsLogin";
import { OverviewChart } from "./OverviewChart";
import { RangeSlider } from "./RangeSlider";
import { Timeline } from "./Timeline";

interface DashboardProps {
  authEnabled: boolean;
  detailsAuthEnabled: boolean;
  detailsAuthenticated: boolean;
  onLogout: () => void;
  onUnauthorized: () => void;
}

interface InitialState {
  view: ViewMode;
  day: string;
  month: string;
  year: string;
  device: string;
  app: string;
  query: string;
}

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && localDateString(date) === value;
}

function validMonth(value: string | null): value is string {
  return Boolean(value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value));
}

function validYear(value: string | null): value is string {
  return Boolean(value && /^\d{4}$/.test(value));
}

function initialState(): InitialState {
  const params = new URLSearchParams(window.location.search);
  const today = localDateString();
  const legacyDay = validDate(params.get("from")) ? params.get("from")! : today;
  const viewParam = params.get("view");
  const view: ViewMode = viewParam === "month" || viewParam === "year" || viewParam === "day" ? viewParam : "day";
  const day = validDate(params.get("date")) ? params.get("date")! : legacyDay;
  const month = validMonth(params.get("month")) ? params.get("month")! : day.slice(0, 7);
  const year = validYear(params.get("year")) ? params.get("year")! : day.slice(0, 4);
  return {
    view,
    day,
    month,
    year,
    device: params.get("device") ?? "",
    app: params.get("app") ?? "",
    query: params.get("q") ?? "",
  };
}

function metric(value: number | null, suffix = "%") {
  return value === null ? "--" : `${value}${suffix}`;
}

function periodLabel(view: ViewMode, day: string, month: string, year: string) {
  if (view === "day") return day === localDateString() ? "今天干了什么" : `${day} 的活动记录`;
  if (view === "month") return `${month.slice(0, 4)}年${Number(month.slice(5))}月活动概览`;
  return `${year} 年活动概览`;
}

function pointDate(point: OverviewPoint, granularity: "day" | "month") {
  if (granularity === "day") return new Date(`${point.key}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
  return new Date(`${point.key}-01T12:00:00`).toLocaleDateString([], { month: "short" });
}

function emptyPoint(key: string, granularity: "day" | "month"): OverviewPoint {
  const start = granularity === "day"
    ? Date.parse(new Date(`${key}T00:00:00`).toISOString())
    : Date.parse(new Date(`${key}-01T00:00:00`).toISOString());
  const end = granularity === "day"
    ? Date.parse(new Date(`${addDays(key, 1)}T00:00:00`).toISOString())
    : Date.parse(localMonthRange(key).toIso);
  return { key, start, end, events: 0, totalMs: 0, switches: 0, averageCpu: null, maximumCpu: null, batteryDelta: null };
}

function summaryCards(summary: Report["summary"]) {
  return (
    <section className="summary-grid" aria-label="活动摘要">
      <article className="summary-card"><span className="summary-icon green"><Timer size={18} /></span><div><small>记录时长</small><strong>{formatDuration(summary.totalMs)}</strong></div></article>
      <article className="summary-card"><span className="summary-icon red"><Zap size={18} /></span><div><small>窗口切换</small><strong>{summary.switches}</strong></div></article>
      <article className="summary-card"><span className="summary-icon blue"><CalendarDays size={18} /></span><div><small>采样事件</small><strong>{summary.events}</strong></div></article>
      <article className="summary-card"><span className="summary-icon gold"><Cpu size={18} /></span><div><small>平均 / 最高 CPU</small><strong>{metric(summary.averageCpu)} <em>/ {metric(summary.maximumCpu)}</em></strong></div></article>
      <article className="summary-card"><span className="summary-icon violet"><BatteryCharging size={18} /></span><div><small>电量变化</small><strong>{summary.batteryDelta === null ? "--" : `${summary.batteryDelta > 0 ? "+" : ""}${summary.batteryDelta}%`}</strong></div></article>
    </section>
  );
}

export function Dashboard({
  authEnabled,
  detailsAuthEnabled,
  detailsAuthenticated,
  onLogout,
  onUnauthorized,
}: DashboardProps) {
  const initial = useMemo(initialState, []);
  const [view, setView] = useState<ViewMode>(initial.view);
  const [day, setDay] = useState(initial.day);
  const [month, setMonth] = useState(initial.month);
  const [year, setYear] = useState(initial.year);
  const [device, setDevice] = useState(initial.device);
  const [app, setApp] = useState(initial.app);
  const [query, setQuery] = useState(initial.query);
  const [queryDraft, setQueryDraft] = useState(initial.query);
  const [options, setOptions] = useState<FilterOptions>({ devices: [], apps: [] });
  const [report, setReport] = useState<Report | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [events, setEvents] = useState<EventPage>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [detailsError, setDetailsError] = useState("");
  const [metricFrom, setMetricFrom] = useState(0);
  const [metricTo, setMetricTo] = useState(0);
  const [overviewFrom, setOverviewFrom] = useState(0);
  const [overviewTo, setOverviewTo] = useState(0);

  const range = useMemo(() => {
    if (view === "day") return inclusiveRange(day, day);
    if (view === "month") return localMonthRange(month);
    return localYearRange(year);
  }, [day, month, view, year]);

  const params = useMemo(() => {
    const value = new URLSearchParams({ from: range.fromIso, to: range.toIso });
    if (device) value.set("device", device);
    if (app) value.set("app", app);
    if (query) value.set("q", query);
    return value;
  }, [app, device, query, range]);

  const overviewPoints = useMemo(() => {
    if (!overview) return [];
    const keys: string[] = [];
    if (view === "month") {
      for (let index = 1; index <= monthDays(month); index += 1) keys.push(`${month}-${String(index).padStart(2, "0")}`);
    } else {
      for (let index = 1; index <= 12; index += 1) keys.push(`${year}-${String(index).padStart(2, "0")}`);
    }
    const byKey = new Map(overview.points.map((point) => [point.key, point]));
    return keys.map((key) => byKey.get(key) ?? emptyPoint(key, view === "month" ? "day" : "month"));
  }, [month, overview, view, year]);

  const visibleMetrics = useMemo(() => {
    if (!report?.metrics.length) return [];
    const start = Math.min(metricFrom, report.metrics.length - 1);
    const end = Math.min(Math.max(metricTo, start), report.metrics.length - 1);
    return report.metrics.slice(start, end + 1);
  }, [metricFrom, metricTo, report]);

  useEffect(() => {
    api<FilterOptions>("/api/v1/filters")
      .then(setOptions)
      .catch((requestError) => {
        if (requestError instanceof ApiError && requestError.status === 401) onUnauthorized();
      });
  }, [onUnauthorized]);

  useEffect(() => {
    const urlParams = new URLSearchParams({ view });
    if (view === "day") {
      if (day !== localDateString()) urlParams.set("date", day);
    } else if (view === "month") {
      urlParams.set("month", month);
    } else {
      urlParams.set("year", year);
    }
    if (device) urlParams.set("device", device);
    if (app) urlParams.set("app", app);
    if (query) urlParams.set("q", query);
    history.replaceState(null, "", `${location.pathname}?${urlParams}`);

    const controller = new AbortController();
    setLoading(true);
    setError("");
    setReport(null);
    setOverview(null);
    const path = view === "day"
      ? `/api/v1/report?${params}`
      : `/api/v1/overview?${new URLSearchParams({
        ...Object.fromEntries(params.entries()),
        granularity: view === "month" ? "day" : "month",
        tzOffset: String(new Date().getTimezoneOffset()),
      })}`;
    api<Report | Overview>(path, { signal: controller.signal })
      .then((result) => view === "day" ? setReport(result as Report) : setOverview(result as Overview))
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        if (requestError instanceof ApiError && requestError.status === 401) {
          onUnauthorized();
          return;
        }
        setError(requestError instanceof Error ? requestError.message : "加载失败");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [app, device, day, month, onUnauthorized, params, query, view, year]);

  useEffect(() => {
    if (view !== "day" || (detailsAuthEnabled && !detailsAuthenticated)) {
      setEvents({ items: [], nextCursor: null });
      setEventsLoading(false);
      setDetailsError("");
      return;
    }
    const controller = new AbortController();
    setEventsLoading(true);
    setDetailsError("");
    api<EventPage>(`/api/v1/events?${params}&limit=50`, { signal: controller.signal })
      .then(setEvents)
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        if (requestError instanceof ApiError && requestError.status === 401) {
          onUnauthorized();
          return;
        }
        setDetailsError(requestError instanceof Error ? requestError.message : "采样明细加载失败");
      })
      .finally(() => { if (!controller.signal.aborted) setEventsLoading(false); });
    return () => controller.abort();
  }, [detailsAuthEnabled, detailsAuthenticated, onUnauthorized, params, view]);

  useEffect(() => {
    const length = report?.metrics.length ?? 0;
    setMetricFrom(0);
    setMetricTo(Math.max(0, length - 1));
  }, [report]);

  useEffect(() => {
    setOverviewFrom(0);
    setOverviewTo(Math.max(0, overviewPoints.length - 1));
  }, [overviewPoints]);

  function shift(direction: number) {
    if (view === "day") setDay((current) => addDays(current, direction));
    else if (view === "month") setMonth((current) => addMonths(current, direction));
    else setYear((current) => addYears(current, direction));
  }

  function setCurrentPeriod() {
    const today = localDateString();
    setDay(today);
    setMonth(today.slice(0, 7));
    setYear(today.slice(0, 4));
  }

  function changeView(next: ViewMode) {
    if (next === "day") {
      if (view === "month") setDay(`${month}-01`);
      else if (view === "year") setDay(`${year}-01-01`);
    } else if (next === "month") {
      setMonth(view === "year" ? `${year}-01` : day.slice(0, 7));
    } else {
      setYear(view === "month" ? month.slice(0, 4) : day.slice(0, 4));
    }
    setView(next);
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
      if (requestError instanceof ApiError && requestError.status === 401) onUnauthorized();
      else setDetailsError(requestError instanceof Error ? requestError.message : "加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
  }

  async function lockDetails() {
    await api("/api/auth/details/logout", { method: "POST" }).catch(() => undefined);
    onUnauthorized();
  }

  function selectOverviewPoint(point: OverviewPoint) {
    if (view === "month") {
      setDay(point.key);
      setView("day");
    } else {
      setMonth(point.key);
      setView("month");
    }
  }

  const title = periodLabel(view, day, month, year);
  const data = view === "day" ? report : overview;
  const summary = data?.summary;
  const overviewHasData = Boolean(overview?.hasData ?? overview?.points.some((point) => point.events > 0 || point.totalMs > 0));

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark small"><Activity size={19} /></span>
          <div><strong>活动记录</strong><span>工作台</span></div>
        </div>
        <div className="topbar-actions">
          <span className="timezone"><Monitor size={15} />{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
          {authEnabled && <button className="icon-button" onClick={logout} title="退出登录" aria-label="退出登录"><LogOut size={18} /></button>}
        </div>
      </header>

      <main className="dashboard">
        <section className="page-heading">
          <div><p className="eyebrow">ACTIVITY RECORDER</p><h1>{title}</h1></div>
          <div className="heading-actions">
            <div className="view-switcher" role="radiogroup" aria-label="视图模式">
              {([["day", "日视图"], ["month", "月视图"], ["year", "年视图"]] as Array<[ViewMode, string]>).map(([value, label]) => (
                <label key={value} className={view === value ? "selected" : ""}><input type="radio" name="view-mode" value={value} checked={view === value} onChange={() => changeView(value)} />{label}</label>
              ))}
            </div>
            <button className="secondary-button" onClick={() => location.reload()}><RefreshCw size={16} />刷新</button>
          </div>
        </section>

        <section className="filter-band" aria-label="筛选条件">
          <div className="date-controls">
            <button className="icon-button previous-period" onClick={() => shift(-1)} title="上一时段" aria-label="上一时段"><ChevronLeft size={18} /></button>
            {view === "day" && <label><span>日期</span><input type="date" value={day} onChange={(event) => { if (validDate(event.target.value)) setDay(event.target.value); }} /></label>}
            {view === "month" && <label><span>月份</span><input type="month" value={month} onChange={(event) => { if (validMonth(event.target.value)) setMonth(event.target.value); }} /></label>}
            {view === "year" && <label><span>年份</span><input className="year-input" type="number" min="2000" max="2100" value={year} onChange={(event) => { if (validYear(event.target.value)) setYear(event.target.value); }} /></label>}
            <button className="icon-button next-period" onClick={() => shift(1)} title="下一时段" aria-label="下一时段"><ChevronRight size={18} /></button>
            <button className="text-button" onClick={setCurrentPeriod}>{view === "day" ? "今天" : view === "month" ? "本月" : "今年"}</button>
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

        {!loading && summary && (
          <>
            {view === "day" && report?.truncated && <div className="notice-banner">此范围超过 20,000 条采样，图表仅显示最早的 20,000 条；请缩小日期范围。</div>}
            {summaryCards(summary)}

            {view === "day" && report ? (
              <>
                <section className="panel full-panel">
                  <div className="panel-heading"><div><h2>活动时间线</h2><p>连续相同窗口已合并，单次采样最多计入 5 分钟</p></div></div>
                  <Timeline timeline={report.timeline} from={Date.parse(range.fromIso)} to={Date.parse(range.toIso)} />
                </section>

                <section className="chart-grid">
                  <article className="panel"><div className="panel-heading"><div><h2>应用使用排行</h2><p>按推算使用时长排序，点击应用可筛选</p></div></div><div className="chart-body app-chart"><AppDurationChart apps={report.apps} onSelectApp={setApp} /></div></article>
                  <article className="panel"><div className="panel-heading"><div><h2>系统状态</h2><p>CPU、内存和电量；三角点表示正在充电</p></div></div><div className="chart-body metrics-chart-body"><MetricsChart metrics={visibleMetrics} /></div>
                    {report.metrics.length > 0 && <RangeSlider
                      min={0}
                      max={report.metrics.length - 1}
                      from={metricFrom}
                      to={metricTo}
                      onChange={(from, to) => { setMetricFrom(from); setMetricTo(to); }}
                      startLabel="系统状态显示开始时间"
                      endLabel="系统状态显示结束时间"
                      formatValue={(index) => new Date(report.metrics[index]?.at ?? 0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    />}
                  </article>
                </section>

                <section className="panel full-panel">
                  <div className="panel-heading"><div><h2>应用活动分布</h2><p>移动鼠标查看时间点，拖动底部手柄缩放范围</p></div></div>
                  <AppActivityTimeline timeline={report.timeline} from={Date.parse(range.fromIso)} to={Date.parse(range.toIso)} />
                </section>

                <section className="panel full-panel table-panel">
                  <div className="panel-heading">
                    <div><h2>采样明细</h2><p>{detailsAuthEnabled && !detailsAuthenticated ? "需要单独验证" : `共显示 ${events.items.length} 条`}</p></div>
                    {detailsAuthEnabled && detailsAuthenticated && (
                      <button className="icon-button" onClick={lockDetails} title="锁定采样明细" aria-label="锁定采样明细"><LockKeyhole size={17} /></button>
                    )}
                  </div>
                  {detailsAuthEnabled && !detailsAuthenticated ? (
                    <DetailsLogin onSuccess={onUnauthorized} />
                  ) : eventsLoading ? <div className="details-loading"><RefreshCw className="spin" size={17} />正在读取采样明细...</div> : detailsError ? <div className="details-error" role="alert">{detailsError}</div> : events.items.length ? (
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
            ) : overview ? (
              <section className="panel full-panel overview-panel">
                <div className="panel-heading"><div><h2>{view === "month" ? "按天活动统计" : "按月活动统计"}</h2><p>点击某个{view === "month" ? "日期" : "月份"}可进入下一层视图</p></div></div>
                {overviewHasData ? <OverviewChart
                    points={overviewPoints}
                    fromIndex={overviewFrom}
                    toIndex={overviewTo}
                    granularity={view === "month" ? "day" : "month"}
                    onSelect={selectOverviewPoint}
                  /> : <div className="empty-chart overview-empty">当前范围没有记录</div>}
                {overviewPoints.length > 0 && <RangeSlider
                  min={0}
                  max={overviewPoints.length - 1}
                  from={overviewFrom}
                  to={overviewTo}
                  onChange={(from, to) => { setOverviewFrom(from); setOverviewTo(to); }}
                  startLabel={`${view === "month" ? "日期" : "月份"}显示开始`}
                  endLabel={`${view === "month" ? "日期" : "月份"}显示结束`}
                  formatValue={(index) => overviewPoints[index] ? pointDate(overviewPoints[index], view === "month" ? "day" : "month") : "--"}
                />}
                {overviewHasData ? <div className="overview-table-wrap"><table className="overview-table"><thead><tr><th>{view === "month" ? "日期" : "月份"}</th><th>记录时长</th><th>事件</th><th>切换</th><th>平均 CPU</th></tr></thead><tbody>
                    {overviewPoints.slice(overviewFrom, overviewTo + 1).map((point) => <tr key={point.key} onClick={() => selectOverviewPoint(point)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") selectOverviewPoint(point); }}>
                      <td>{point.key}</td><td>{formatDuration(point.totalMs)}</td><td>{point.events}</td><td>{point.switches}</td><td>{metric(point.averageCpu)}</td>
                    </tr>)}
                  </tbody></table></div> : null}
              </section>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
