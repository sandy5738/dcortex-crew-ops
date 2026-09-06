/**
 * OpsSnapshot — the deck behind the chat.
 *
 * Everything here is a deterministic read: SQL out of airline.db, no LLM
 * anywhere. The chat is where reasoning happens; the deck is what the
 * controller wants on the wall before the phone rings. One call returns
 * the whole shift picture so the UI has a single waterfall, not six.
 */
import { DateTime } from 'luxon';
import { getDb } from './db';

/** The dataset's own as_of timestamp, from dataset_meta. */
export function datasetAsOf(): string {
    const row = getDb()
        .prepare("SELECT value FROM dataset_meta WHERE key = 'snapshot_utc' LIMIT 1")
        .get() as { value: string } | undefined;
    return row?.value ?? '2026-09-14T18:00:00Z';
}

/** The dataset's schedule runs as_of date .. +6 days. */
export function scheduleDates(): string[] {
    const start = DateTime.fromISO(datasetAsOf(), { zone: 'utc' }).startOf('day');
    return Array.from({ length: 7 }, (_, i) => start.plus({ days: i }).toISODate()!);
}

export interface OpsSnapshot {
    as_of_utc: string;
    dates: string[];
    flights: {
        flight_id: string;
        flight_no: string;
        date: string;
        dep_station: string;
        arr_station: string;
        dep_utc: string;
        arr_utc: string;
        block_hours: number;
        aircraft: string;
        aircraft_type: string;
        seats: number;
        crew: { crew_id: string; name: string; rank: string; role: string }[];
    }[];
    reserves: {
        crew_id: string;
        name: string;
        rank: string;
        base: string;
        oncall_start: string;
        oncall_end: string;
        dates: string[];
        reachability_minutes: number;
        status: string;
    }[];
    risk: {
        crew_id: string;
        name: string;
        rank: string;
        base: string;
        status: string;
        disruption_risk_score: number;
        drivers: string[];
        on_pairings: string[];
    }[];
    duty: {
        crew_id: string;
        name: string;
        rank: string;
        duty_hours_7d: number;
        duty_limit_7d: number;
        flight_hours_28d: number;
        flight_limit_28d: number;
        last_rest_ended: string;
    }[];
    cert_alerts: {
        crew_id: string;
        name: string;
        rank: string;
        cert_type: string;
        valid_to: string;
        days_left: number;
    }[];
    stations: string[];
}

const dayDiff = (to: string, from: string): number =>
    Math.round(
        (DateTime.fromISO(to, { zone: 'utc' }).startOf('day').toMillis() -
            DateTime.fromISO(from, { zone: 'utc' }).startOf('day').toMillis()) /
        86_400_000,
    );

/** crew members rostered on each flight, via the normalised pairing tables. */
function crewByFlight(): Map<string, { crew_id: string; name: string; rank: string; role: string }[]> {
    const db = getDb();
    const rows = db.prepare(`
        SELECT pdf.flight_id, pc.crew_id, c.name, c.rank, pc.role
        FROM pairing_day_flights pdf
        JOIN pairing_crew pc ON pc.pairing_id = pdf.pairing_id
        JOIN crew c          ON c.crew_id  = pc.crew_id
        ORDER BY pdf.flight_id, pc.seq
    `).all() as { flight_id: string; crew_id: string; name: string; rank: string; role: string }[];

    const map = new Map<string, { crew_id: string; name: string; rank: string; role: string }[]>();
    for (const r of rows) {
        const list = map.get(r.flight_id) ?? [];
        list.push({ crew_id: r.crew_id, name: r.name, rank: r.rank, role: r.role });
        map.set(r.flight_id, list);
    }
    return map;
}

export function opsSnapshot(): OpsSnapshot {
    const db = getDb();
    const dates = scheduleDates();
    const asOf = datasetAsOf();
    const asOfDate = asOf.slice(0, 10);

    const byFlight = crewByFlight();

    const flights = (db.prepare(`
        SELECT * FROM flights WHERE date BETWEEN ? AND ?
        ORDER BY date, dep_utc
    `).all(dates[0], dates[dates.length - 1]) as any[]).map((f) => ({
        flight_id: f.flight_id,
        flight_no: f.flight_no,
        date: f.date,
        dep_station: f.dep_station,
        arr_station: f.arr_station,
        dep_utc: f.dep_utc,
        arr_utc: f.arr_utc,
        block_hours: f.block_hours,
        aircraft: f.aircraft,
        aircraft_type: f.aircraft_type,
        seats: f.seats,
        crew: byFlight.get(f.flight_id) ?? [],
    }));

    const reserveRows = db.prepare(`
        SELECT r.crew_id, c.name, c.rank, r.base, r.oncall_start, r.oncall_end,
               c.reachability_minutes, c.status
        FROM reserves r
        JOIN crew c ON c.crew_id = r.crew_id
        ORDER BY r.base, c.rank, r.crew_id
    `).all() as any[];

    const reserveDates = db.prepare(
        'SELECT crew_id, date FROM reserve_dates ORDER BY date'
    ).all() as { crew_id: string; date: string }[];
    const datesByReserve = new Map<string, string[]>();
    for (const d of reserveDates) {
        const list = datesByReserve.get(d.crew_id) ?? [];
        list.push(d.date);
        datesByReserve.set(d.crew_id, list);
    }

    const reserves = reserveRows.map((r) => ({
        crew_id: r.crew_id,
        name: r.name,
        rank: r.rank,
        base: r.base,
        oncall_start: r.oncall_start,
        oncall_end: r.oncall_end,
        dates: datesByReserve.get(r.crew_id) ?? [],
        reachability_minutes: r.reachability_minutes,
        status: r.status,
    }));

    const pairingsByCrew = new Map<string, string[]>();
    for (const row of db.prepare(
        'SELECT crew_id, pairing_id FROM pairing_crew'
    ).all() as { crew_id: string; pairing_id: string }[]) {
        const list = pairingsByCrew.get(row.crew_id) ?? [];
        list.push(row.pairing_id);
        pairingsByCrew.set(row.crew_id, list);
    }

    const risk = (db.prepare(`
        SELECT rs.crew_id, c.name, c.rank, c.base, c.status,
               rs.disruption_risk_score
        FROM risk_signals rs
        JOIN crew c ON c.crew_id = rs.crew_id
        ORDER BY rs.disruption_risk_score DESC
    `).all() as any[]).map((r) => ({
        crew_id: r.crew_id,
        name: r.name,
        rank: r.rank,
        base: r.base,
        status: r.status,
        disruption_risk_score: r.disruption_risk_score,
        drivers: (db.prepare(
            'SELECT driver FROM risk_drivers WHERE crew_id = ? ORDER BY seq'
        ).all(r.crew_id) as { driver: string }[]).map((d) => d.driver),
        on_pairings: pairingsByCrew.get(r.crew_id) ?? [],
    }));

    const dutyLimit = (db.prepare(
        "SELECT value_num FROM rule_params WHERE rule_id = 'RULE-DUTY-02' AND param_key = 'max_duty_hours'"
    ).get() as { value_num: number }).value_num;
    const fltLimit = (db.prepare(
        "SELECT value_num FROM rule_params WHERE rule_id = 'RULE-FLT-03' AND param_key = 'max_flight_hours'"
    ).get() as { value_num: number }).value_num;

    const duty = (db.prepare(`
        SELECT dc.crew_id, c.name, c.rank, dc.duty_hours_7d, dc.flight_hours_28d, dc.last_rest_ended
        FROM duty_clocks dc
        JOIN crew c ON c.crew_id = dc.crew_id
        ORDER BY dc.duty_hours_7d DESC
    `).all() as any[]).map((r) => ({
        crew_id: r.crew_id,
        name: r.name,
        rank: r.rank,
        duty_hours_7d: r.duty_hours_7d,
        duty_limit_7d: dutyLimit,
        flight_hours_28d: r.flight_hours_28d,
        flight_limit_28d: fltLimit,
        last_rest_ended: r.last_rest_ended,
    }));

    // Certs lapsing inside the schedule window get a red chip on the deck.
    const certAlerts = (db.prepare(`
        SELECT ct.crew_id, c.name, c.rank, ct.cert_type, ct.valid_to
        FROM certifications ct
        JOIN crew c ON c.crew_id = ct.crew_id
        WHERE ct.valid_to >= ? AND ct.valid_to <= ?
        ORDER BY ct.valid_to ASC
    `).all(asOfDate, dates[dates.length - 1]) as any[]).map((r) => ({
        crew_id: r.crew_id,
        name: r.name,
        rank: r.rank,
        cert_type: r.cert_type,
        valid_to: r.valid_to,
        days_left: dayDiff(r.valid_to, asOfDate),
    }));

    const stations = (db.prepare(
        'SELECT DISTINCT dep_station FROM flights ORDER BY dep_station'
    ).all() as { dep_station: string }[]).map((r) => r.dep_station);

    return { as_of_utc: asOf, dates, flights, reserves, risk, duty, cert_alerts: certAlerts, stations };
}
