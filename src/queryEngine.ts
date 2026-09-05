import { z } from 'zod';
import { getDb } from './db';

// =================================================================
// TIER 1: SCHEMAS
// =================================================================
export const QuerySchemas = {
    GetReservePool: z.object({
        date: z.string().describe("Date in YYYY-MM-DD format (e.g., 2026-09-15)"),
        base: z.string().optional().describe("Station code (e.g., BLR, DEL)")
    }),
    GetDutyHours: z.object({
        crewId: z.string().describe("Crew ID (e.g., C-1042)")
    }),
    GetFlights: z.object({
        date: z.string().describe("Date in YYYY-MM-DD format"),
        depStation: z.string().optional().describe("Departure station code (e.g., DEL)"),
        arrStation: z.string().optional().describe("Arrival station code (e.g., BOM)")
    }),
    GetExpiringCertifications: z.object({
        dateFrom: z.string().describe("Start date in YYYY-MM-DD"),
        dateTo: z.string().describe("End date in YYYY-MM-DD")
    }),
    GetCrew: z.object({
        crewId: z.string().optional(),
        base: z.string().optional(),
        rank: z.string().optional()
    }),
    GetPairing: z.object({
        pairingId: z.string().optional().describe("Pairing ID (e.g., P-2291)"),
        // Questions name the aircraft and date rather than the pairing:
        // "who is the Senior Cabin Crew on VT-DXB's pairing on 16 Sep?"
        aircraft: z.string().optional().describe("Tail number (e.g., VT-DXB). Use with date when the pairing id is unknown."),
        date: z.string().optional().describe("Date in YYYY-MM-DD, used with aircraft")
    }),
    GetRiskSignals: z.object({
        crewId: z.string().optional().describe("Crew ID; omit to list the highest-risk crew"),
        topN: z.number().int().min(1).max(50).optional().describe("How many to return when no crewId is given (default 5)")
    }),
    GetNetworkStats: z.object({
        date: z.string().optional().describe("Restrict to one date, YYYY-MM-DD"),
        fromStation: z.string().optional().describe("Restrict destinations to those served nonstop from this station")
    }),
    GetCrewAboveDutyThreshold: z.object({
        onDate: z.string().describe("Date the 7-day window ends on, YYYY-MM-DD"),
        atLeastHours: z.number().describe("Threshold in duty hours (e.g., 45)"),
        includePlannedThatDay: z.boolean().optional().describe("Add any duty already rostered on that date (default true)")
    }),
    GetEarliestNextReport: z.object({
        releaseUtc: z.string().describe("UTC ISO release time of the duty just finished")
    })
};

// =================================================================
// TIER 1: SQL QUERY ENGINE
// =================================================================
export class QueryEngine {
    
    static getReservePool(input: z.infer<typeof QuerySchemas.GetReservePool>) {
        const { date, base } = input;
        const db = getDb();
        try {
            // reserve_pool was one flat table with a `date` column. It is now
            // reserves (one row per crew) + reserve_dates (the on-call dates),
            // so the date filter moves to the child table.
            let sql = `
                SELECT r.crew_id, c.rank, r.oncall_start, r.oncall_end
                FROM reserves r
                JOIN reserve_dates d ON d.crew_id = r.crew_id
                JOIN crew c          ON c.crew_id = r.crew_id
                WHERE d.date = ?
            `;
            const params: any[] = [date];
            if (base) {
                sql += ` AND r.base = ?`;
                params.push(base);
            }
            sql += ` ORDER BY r.crew_id`;
            return db.prepare(sql).all(params);
        } finally {
            // Deliberately not closing: getDb() returns a shared, memoised
            // read handle now. See src/db.ts.
        }
    }

    static getDutyHours(input: z.infer<typeof QuerySchemas.GetDutyHours>) {
        const db = getDb();
        try {
            return db.prepare("SELECT * FROM duty_clocks WHERE crew_id = ?").get(input.crewId) || { error: "Crew not found" };
        } finally {
            // Shared handle — see getReservePool.
        }
    }

    static getFlights(input: z.infer<typeof QuerySchemas.GetFlights>) {
        const db = getDb();
        try {
            let sql = `SELECT * FROM flights WHERE date = ?`;
            const params: any[] = [input.date];
            if (input.depStation) { sql += ` AND dep_station = ?`; params.push(input.depStation); }
            if (input.arrStation) { sql += ` AND arr_station = ?`; params.push(input.arrStation); }
            return db.prepare(sql).all(params);
        } finally {
            // Shared handle — see getReservePool.
        }
    }

    static getExpiringCertifications(input: z.infer<typeof QuerySchemas.GetExpiringCertifications>) {
        const db = getDb();
        try {
            return db.prepare(`
                SELECT * FROM certifications 
                WHERE valid_to >= ? AND valid_to <= ?
                ORDER BY valid_to ASC
            `).all(input.dateFrom, input.dateTo);
        } finally {
            // Shared handle — see getReservePool.
        }
    }

    static getCrew(input: z.infer<typeof QuerySchemas.GetCrew>) {
        const db = getDb();
        try {
            let sql = `SELECT * FROM crew WHERE 1=1`;
            const params: any[] = [];
            if (input.crewId) { sql += ` AND crew_id = ?`; params.push(input.crewId); }
            if (input.base) { sql += ` AND base = ?`; params.push(input.base); }
            if (input.rank) { sql += ` AND rank = ?`; params.push(input.rank); }
            return db.prepare(sql).all(params);
        } finally {
            // Shared handle — see getReservePool.
        }
    }

    static getPairing(input: z.infer<typeof QuerySchemas.GetPairing>) {
        const db = getDb();
        try {
            // Resolve by aircraft + date when the pairing id is unknown, which
            // is how the questions actually phrase it.
            let pairingId = input.pairingId;
            if (!pairingId) {
                if (!input.aircraft || !input.date) {
                    return { error: "Supply either pairingId, or aircraft and date." };
                }
                const found = db.prepare(
                    `SELECT DISTINCT pdf.pairing_id FROM pairing_day_flights pdf
                     JOIN flights f ON f.flight_id = pdf.flight_id
                     WHERE f.aircraft = ? AND pdf.date = ?`
                ).all(input.aircraft, input.date) as { pairing_id: string }[];
                if (found.length === 0) {
                    return { error: `No pairing for ${input.aircraft} on ${input.date}` };
                }
                pairingId = found[0].pairing_id;
            }

            // pairings.json_data is gone: the roster is normalised across
            // pairings / pairing_days / pairing_day_flights / pairing_crew.
            // Rebuild the same object shape the JSON blob used to return, so
            // callers of this endpoint are unaffected.
            const pairing = db.prepare(
                `SELECT pairing_id, aircraft FROM pairings WHERE pairing_id = ?`
            ).get(pairingId) as any;
            if (!pairing) return { error: "Pairing not found" };
            input = { ...input, pairingId };

            const days = db.prepare(
                `SELECT date, report_utc, release_utc FROM pairing_days
                 WHERE pairing_id = ? ORDER BY seq`
            ).all(input.pairingId) as any[];

            const legs = db.prepare(
                `SELECT flight_id FROM pairing_day_flights
                 WHERE pairing_id = ? AND date = ? ORDER BY seq`
            );

            return {
                ...pairing,
                days: days.map(d => ({
                    ...d,
                    flights: (legs.all(input.pairingId, d.date) as any[])
                        .map(f => f.flight_id),
                })),
                crew: db.prepare(
                    `SELECT crew_id, role FROM pairing_crew
                     WHERE pairing_id = ? ORDER BY seq`
                ).all(input.pairingId),
            };
        } finally {
            // Shared handle — see getReservePool.
        }
    }

    /**
     * Pre-computed disruption risk. A GIVEN input, like a weather forecast —
     * the brief is explicit that we do not build a prediction model, so this
     * only ever reads the table.
     */
    static getRiskSignals(input: z.infer<typeof QuerySchemas.GetRiskSignals>) {
        const db = getDb();
        const drivers = db.prepare(
            `SELECT driver FROM risk_drivers WHERE crew_id = ? ORDER BY seq`);

        if (input.crewId) {
            const row = db.prepare(
                `SELECT crew_id, disruption_risk_score FROM risk_signals WHERE crew_id = ?`
            ).get(input.crewId) as any;
            if (!row) return { error: `No risk signal for ${input.crewId}` };
            return { ...row, drivers: (drivers.all(input.crewId) as any[]).map(d => d.driver) };
        }

        return (db.prepare(
            `SELECT r.crew_id, r.disruption_risk_score, c.name, c.rank, c.base
             FROM risk_signals r JOIN crew c USING (crew_id)
             ORDER BY r.disruption_risk_score DESC, r.crew_id LIMIT ?`
        ).all(input.topN ?? 5) as any[])
            .map(r => ({ ...r, drivers: (drivers.all(r.crew_id) as any[]).map(d => d.driver) }));
    }

    /**
     * Network-level aggregates. These are one-line SQL, but without them the
     * only way to answer "how many flights on the 16th" is to return all 147
     * rows and have the caller count — and if the caller is a language model,
     * that is arithmetic in the token stream.
     */
    static getNetworkStats(input: z.infer<typeof QuerySchemas.GetNetworkStats>) {
        const db = getDb();
        const where = input.date ? 'WHERE date = ?' : '';
        const args = input.date ? [input.date] : [];

        const totals = db.prepare(
            `SELECT count(*) AS flights, count(DISTINCT aircraft) AS aircraft,
                    round(sum(block_hours), 2) AS block_hours, sum(seats) AS seats
             FROM flights ${where}`).get(...args) as any;

        const longest = db.prepare(
            `SELECT flight_id, flight_no, date, dep_station, arr_station, block_hours
             FROM flights ${where}
             ORDER BY block_hours DESC, flight_id`).all(...args) as any[];
        const maxBlock = longest.length ? longest[0].block_hours : null;

        const destinations = input.fromStation
            ? (db.prepare(
                `SELECT DISTINCT arr_station FROM flights WHERE dep_station = ? ORDER BY arr_station`
              ).all(input.fromStation) as any[]).map(r => r.arr_station)
            : (db.prepare(
                `SELECT DISTINCT dep_station s FROM flights
                 UNION SELECT DISTINCT arr_station FROM flights ORDER BY s`
              ).all() as any[]).map(r => r.s);

        return {
            ...totals,
            longest_block_hours: maxBlock,
            // Ties are real: report every flight holding the maximum.
            longest_flights: longest.filter(f => f.block_hours === maxBlock),
            [input.fromStation ? 'nonstop_destinations' : 'stations']: destinations,
        };
    }

    /**
     * Which crew are at or above a duty-hours threshold for the 7 days ending
     * on a date — "who is close to the limit?", asked across all 150 rather
     * than one at a time.
     *
     * Sums duty_daily_history, never duty_clocks.duty_hours_7d, which is only
     * valid for the snapshot date.
     */
    static getCrewAboveDutyThreshold(
        input: z.infer<typeof QuerySchemas.GetCrewAboveDutyThreshold>) {
        const db = getDb();
        const days = (db.prepare(
            `SELECT value_num v FROM rule_params
             WHERE rule_id='RULE-DUTY-02' AND param_key='window_days'`).get() as any).v;
        const limit = (db.prepare(
            `SELECT value_num v FROM rule_params
             WHERE rule_id='RULE-DUTY-02' AND param_key='max_duty_hours'`).get() as any).v;

        const end = new Date(input.onDate + 'T00:00:00Z');
        const start = new Date(end.getTime() - (days - 1) * 86_400_000)
            .toISOString().slice(0, 10);

        const accrued = db.prepare(
            `SELECT c.crew_id, c.name, c.rank, c.base,
                    round(COALESCE(sum(h.duty_hours), 0), 2) AS duty_hours_window
             FROM crew c
             LEFT JOIN duty_daily_history h
               ON h.crew_id = c.crew_id AND h.date BETWEEN ? AND ?
             GROUP BY c.crew_id ORDER BY duty_hours_window DESC, c.crew_id`
        ).all(start, input.onDate) as any[];

        const planned = new Map<string, number>();
        if (input.includePlannedThatDay !== false) {
            for (const r of db.prepare(
                `SELECT pc.crew_id, pd.report_utc, pd.release_utc
                 FROM pairing_crew pc
                 JOIN pairing_days pd ON pd.pairing_id = pc.pairing_id
                 WHERE pd.date = ?`).all(input.onDate) as any[]) {
                planned.set(r.crew_id,
                    Math.round(((Date.parse(r.release_utc) - Date.parse(r.report_utc)) / 3_600_000) * 100) / 100);
            }
        }

        return accrued
            .map(r => {
                const plannedHours = planned.get(r.crew_id) ?? 0;
                const total = Math.round((r.duty_hours_window + plannedHours) * 100) / 100;
                return {
                    ...r, planned_that_day: plannedHours, total_hours: total,
                    headroom: Math.round((limit - total) * 100) / 100,
                };
            })
            .filter(r => r.total_hours >= input.atLeastHours)
            .sort((a, b) => b.total_hours - a.total_hours || a.crew_id.localeCompare(b.crew_id));
    }

    /**
     * Earliest legal next report after a release. This is arithmetic, not a
     * legality check — which is why it is here rather than in RULE-REST-04,
     * whose three-way check needs a whole proposed cover to evaluate.
     */
    static getEarliestNextReport(
        input: z.infer<typeof QuerySchemas.GetEarliestNextReport>) {
        const min = (getDb().prepare(
            `SELECT value_num v FROM rule_params
             WHERE rule_id='RULE-REST-04' AND param_key='min_rest_hours'`).get() as any).v;
        const earliest = new Date(Date.parse(input.releaseUtc) + min * 3_600_000)
            .toISOString().replace('.000Z', 'Z');
        return {
            release_utc: input.releaseUtc,
            min_rest_hours: min,
            earliest_report_utc: earliest,
            detail: `${input.releaseUtc} + ${min}h rest = ${earliest}`,
        };
    }
}
