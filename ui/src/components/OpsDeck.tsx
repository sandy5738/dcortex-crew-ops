/**
 * OpsDeck — the situation wall behind the chat.
 *
 * All deterministic data from GET /ops/snapshot. Colour is a verdict:
 * green/amber/red follow the aviation convention, and every state also
 * carries a glyph and a word so nothing depends on distinguishing them.
 */
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BedDouble,
  Clock4,
  GraduationCap,
  Plane,
  RefreshCw,
  ShieldAlert,
  Timer,
  Users,
} from "lucide-react";
import type { OpsSnapshot } from "../opsTypes";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function dayLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return DAY_LABELS[d.getUTCDay()];
}

function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

/** Duty-hours colour: red over 90% of limit, amber over 75%. */
function dutyTone(ratio: number): { cls: string; glyph: string; word: string } {
  if (ratio >= 0.9) return { cls: "v-breach", glyph: "✕", word: "critical" };
  if (ratio >= 0.75) return { cls: "v-caution", glyph: "!", word: "watch" };
  return { cls: "v-legal", glyph: "✓", word: "ok" };
}

function riskTone(score: number): { cls: string; label: string } {
  if (score >= 0.7) return { cls: "v-breach", label: "high" };
  if (score >= 0.4) return { cls: "v-caution", label: "elevated" };
  return { cls: "v-legal", label: "low" };
}

function Panel({
  title,
  icon,
  count,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count?: string | number;
  children: React.ReactNode;
}) {
  return (
    <section className="deck-panel">
      <header className="panel-head">
        <div className="panel-title">
          {icon} {title}
        </div>
        {count !== undefined && (
          <span className="panel-count num mono">{count}</span>
        )}
      </header>
      {children}
    </section>
  );
}

export function OpsDeck({
  snapshot,
  onRefresh,
  loading,
}: {
  snapshot: OpsSnapshot | null;
  onRefresh: () => void;
  loading: boolean;
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [stationFilter, setStationFilter] = useState<string>("all");

  const dates = snapshot?.dates ?? [];
  const activeDate = selectedDate ?? dates[1] ?? "";

  const dayFlights = useMemo(
    () =>
      (snapshot?.flights ?? []).filter(
        (f) =>
          f.date === activeDate &&
          (stationFilter === "all" ||
            f.dep_station === stationFilter ||
            f.arr_station === stationFilter),
      ),
    [snapshot, activeDate, stationFilter],
  );

  const reservesToday = useMemo(
    () =>
      (snapshot?.reserves ?? []).filter((r) => r.dates.includes(activeDate)),
    [snapshot, activeDate],
  );

  const dutyWatch = useMemo(() => {
    const rows = (snapshot?.duty ?? []).filter(
      (d) => d.duty_hours_7d / d.duty_limit_7d >= 0.75,
    );
    return rows.slice(0, 12);
  }, [snapshot]);

  const riskTop = useMemo(
    () => (snapshot?.risk ?? []).filter((r) => r.disruption_risk_score >= 0.4).slice(0, 8),
    [snapshot],
  );

  const onDeckClick = (q: string) => {
    window.dispatchEvent(new CustomEvent("ops:ask", { detail: q }));
  };

  if (loading && !snapshot) {
    return (
      <div className="deck-loading">
        <RefreshCw className="spin" size={16} aria-hidden /> Loading ops snapshot…
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="deck-error">
        Ops snapshot unavailable. Is the API running? <code>npm start</code> from
        the repo root.
      </div>
    );
  }

  return (
    <div className="deck">
      {/* ------------------------------------------------ top situation bar */}
      <div className="situation-bar">
        <div className="situation-dates">
          {dates.map((d) => (
            <button
              key={d}
              className={`date-chip ${d === activeDate ? "on" : ""}`}
              onClick={() => setSelectedDate(d)}
            >
              <span className="date-dow">{dayLabel(d)}</span>
              <span className="date-day num">{d.slice(8)}</span>
              <span className="date-mon">{d.slice(5, 7) === "09" ? "SEP" : d.slice(5, 7)}</span>
            </button>
          ))}
        </div>
        <div className="situation-meta">
          <span className="num mono">
            {snapshot.flights.length} flights · {snapshot.reserves.length} reserves ·{" "}
            {snapshot.stations.length} stations
          </span>
          <span className="mono">as of {snapshot.as_of_utc.slice(11, 16)}Z</span>
          <button className="refresh-btn" onClick={onRefresh} aria-label="Refresh">
            <RefreshCw size={13} className={loading ? "spin" : ""} aria-hidden />
          </button>
        </div>
      </div>

      <div className="deck-grid">
        {/* ------------------------------------------------------- flights */}
        <Panel
          title={`Flights · ${activeDate}`}
          icon={<Plane size={14} aria-hidden />}
          count={dayFlights.length}
        >
          <div className="flight-toolbar">
            <select
              value={stationFilter}
              onChange={(e) => setStationFilter(e.target.value)}
              className="station-select"
              aria-label="Filter by station"
            >
              <option value="all">All stations</option>
              {snapshot.stations.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="flight-list">
            {dayFlights.map((f) => (
              <div
                key={f.flight_id}
                className="flight-strip"
                role="button"
                tabIndex={0}
                onClick={() =>
                  onDeckClick(
                    `Tell me about flight ${f.flight_no} on ${f.date}: which crew operate it, and who could cover ${f.aircraft_type} ${f.dep_station}-${f.arr_station} if one of them drops out?`,
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    onDeckClick(
                      `Tell me about flight ${f.flight_no} on ${f.date}: which crew operate it, and who could cover ${f.aircraft_type} ${f.dep_station}-${f.arr_station} if one of them drops out?`,
                    );
                  }
                }}
              >
                <div className="fs-line">
                  <span className="fs-no mono">{f.flight_no}</span>
                  <span className="fs-route mono">
                    {f.dep_station} <span aria-hidden>→</span> {f.arr_station}
                  </span>
                  <span className="fs-time num mono">
                    {hhmm(f.dep_utc)}–{hhmm(f.arr_utc)}
                  </span>
                  <span className="fs-ac mono">
                    {f.aircraft} · {f.aircraft_type}
                  </span>
                  <span className={`fs-crew ${f.crew.length > 0 ? "" : "v-breach"}`}>
                    {f.crew.length > 0 ? (
                      <>
                        <Users size={11} aria-hidden />{" "}
                        <span className="num">{f.crew.length}</span>
                      </>
                    ) : (
                      "no crew"
                    )}
                  </span>
                </div>
                <div
                  className="fs-names"
                  title={f.crew.map((c) => `${c.name} (${c.crew_id}, ${c.role})`).join(" · ")}
                >
                  {f.crew.length > 0
                    ? f.crew.map((c) => `${c.name} · ${c.role}`).join("  |  ")
                    : "no crew assigned"}
                </div>
              </div>
            ))}
            {dayFlights.length === 0 && (
              <div className="deck-empty">No flights for this filter.</div>
            )}
          </div>
        </Panel>

        {/* ----------------------------------------------- reserve pool */}
        <Panel
          title={`Reserve pool · ${activeDate}`}
          icon={<BedDouble size={14} aria-hidden />}
          count={reservesToday.length}
        >
          <div className="reserve-list">
            {reservesToday.map((r) => (
              <div
                key={r.crew_id}
                className="reserve-row"
                role="button"
                tabIndex={0}
                onClick={() =>
                  onDeckClick(
                    `${r.rank} ${r.crew_id} (${r.name}) is on reserve at ${r.base} ${r.oncall_start}-${r.oncall_end}Z on ${activeDate}. Are their duty clocks and certifications clear for a callout today?`,
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    onDeckClick(
                      `${r.rank} ${r.crew_id} (${r.name}) is on reserve at ${r.base} ${r.oncall_start}-${r.oncall_end}Z on ${activeDate}. Are their duty clocks and certifications clear for a callout today?`,
                    );
                  }
                }}
              >
                <div className="rr-line">
                  <span className="rr-id mono">{r.crew_id}</span>
                  <span className="rr-rank">{r.rank}</span>
                  <span className="rr-base mono">{r.base}</span>
                  <span className="rr-window num mono">
                    {r.oncall_start}–{r.oncall_end}Z
                  </span>
                  <span className="rr-reach num">
                    <Timer size={10} aria-hidden /> {r.reachability_minutes}m
                  </span>
                </div>
                <div className="rr-name">{r.name}</div>
              </div>
            ))}
            {reservesToday.length === 0 && (
              <div className="deck-empty">No reserves on call this date.</div>
            )}
          </div>
        </Panel>

        {/* ------------------------------------------------- duty watchlist */}
        <Panel
          title="Duty clock watchlist"
          icon={<Clock4 size={14} aria-hidden />}
          count={dutyWatch.length}
        >
          <div className="duty-list">
            {dutyWatch.map((d) => {
              const ratio = d.duty_hours_7d / d.duty_limit_7d;
              const t = dutyTone(ratio);
              const pct = Math.min(100, Math.round(ratio * 100));
              return (
                <button
                  key={d.crew_id}
                  className="duty-row"
                  onClick={() =>
                    onDeckClick(
                      `How many duty hours does ${d.crew_id} have left this week, and what happens if I add another duty on ${activeDate}?`,
                    )
                  }
                >
                  <span className="dr-id mono">{d.crew_id}</span>
                  <span className="dr-name">{d.name}</span>
                  <span className="dr-hours num mono">
                    {d.duty_hours_7d.toFixed(1)}h / {d.duty_limit_7d}h
                  </span>
                  <span className="dr-bar">
                    <span className={`dr-fill fill-${t.word === "ok" ? "legal" : t.word === "watch" ? "caution" : "breach"}`} style={{ width: `${pct}%` }} />
                  </span>
                  <span className={`dr-state ${t.cls}`}>
                    <span aria-hidden>{t.glyph}</span> {t.word}
                  </span>
                </button>
              );
            })}
            {dutyWatch.length === 0 && (
              <div className="deck-empty">
                Nobody above 75% of the 7-day duty limit.
              </div>
            )}
          </div>
        </Panel>

        {/* ----------------------------------------------------- risk board */}
        <Panel
          title="Disruption risk board"
          icon={<ShieldAlert size={14} aria-hidden />}
          count={riskTop.length}
        >
          <div className="risk-list">
            {riskTop.map((r) => {
              const t = riskTone(r.disruption_risk_score);
              return (
                <button
                  key={r.crew_id}
                  className="risk-row"
                  onClick={() =>
                    onDeckClick(
                      `${r.rank} ${r.crew_id} (${r.name}) has a disruption risk score of ${r.disruption_risk_score}. What are they rostered on, and who could cover them if they call in sick?`,
                    )
                  }
                >
                  <span className="rk-id mono">{r.crew_id}</span>
                  <span className="rk-name">{r.name}</span>
                  <span className="rk-rank">{r.rank}</span>
                  <span className="rk-score num mono">{r.disruption_risk_score.toFixed(2)}</span>
                  <span className={`rk-label ${t.cls}`} aria-label={`risk ${t.label}`}>
                    <span aria-hidden>{t.cls === "v-breach" ? "✕" : t.cls === "v-caution" ? "!" : "✓"}</span>{" "}
                    {t.label}
                  </span>
                  <span className="rk-drivers">{r.drivers[0]}</span>
                </button>
              );
            })}
            {riskTop.length === 0 && (
              <div className="deck-empty">No elevated risk scores.</div>
            )}
          </div>
        </Panel>

        {/* --------------------------------------------------- cert alerts */}
        <Panel
          title="Certification alerts"
          icon={<GraduationCap size={14} aria-hidden />}
          count={snapshot.cert_alerts.length}
        >
          <div className="cert-list">
            {snapshot.cert_alerts.map((c) => (
              <button
                key={`${c.crew_id}-${c.cert_type}`}
                className="cert-row"
                onClick={() =>
                  onDeckClick(
                    `${c.crew_id}'s ${c.cert_type.replace(/_/g, " ")} expires on ${c.valid_to}. What duties are they rostered for after that, and who can cover?`,
                  )
                }
              >
                <span className="ct-id mono">{c.crew_id}</span>
                <span className="ct-name">{c.name}</span>
                <span className="ct-type">{c.cert_type.replace(/_/g, " ")}</span>
                <span className="ct-date num mono">{c.valid_to}</span>
                <span
                  className={`ct-days num mono ${c.days_left <= 3 ? "v-breach" : "v-caution"}`}
                >
                  {c.days_left}d
                </span>
              </button>
            ))}
            {snapshot.cert_alerts.length === 0 && (
              <div className="deck-empty">
                No certifications lapse inside the schedule window.
              </div>
            )}
          </div>
          {snapshot.cert_alerts.length > 0 && (
            <div className="cert-foot">
              <AlertTriangle size={11} aria-hidden /> Certificates invalid on the
              duty date fail RULE-CERT-06.
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
