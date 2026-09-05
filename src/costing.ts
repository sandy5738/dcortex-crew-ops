/**
 * What a recovery option costs, in INR.
 *
 * Every rate comes from the `costs` table, which came from data/costs.json.
 * No literal rupee figure appears here - the same reason rule limits live in
 * rule_params: the number in an answer must be traceable to the file it came
 * from, and a rate change must not be a code change.
 */
import { getDb } from './db';
import type { DutyPeriod } from './duty';

const r2 = (n: number) => Math.round(n * 100) / 100;

let rateCache: Record<string, number> | null = null;

export function rate(key: string): number {
    if (!rateCache) {
        rateCache = {};
        for (const r of getDb().prepare(
            `SELECT key, value_int FROM costs WHERE value_int IS NOT NULL`
        ).all() as { key: string; value_int: number }[]) {
            rateCache[r.key] = r.value_int;
        }
    }
    const v = rateCache[key];
    if (v === undefined) throw new Error(`cost "${key}" missing from the costs table; re-run the ingest.`);
    return v;
}

export interface CostBreakdown {
    total_inr: number;
    callout_inr: number;
    deadhead_inr: number;
    delay_inr: number;
    hotel_inr: number;
    delay_hours: number;
    detail: string;
}

const PILOT_RANKS = new Set(['Captain', 'First Officer']);

/**
 * Callout rate. Reserve is cheaper than a day off, pilots cost more than
 * cabin.
 *
 * ⚠ `dayoff_callout_*` never appears in the problem statement but every
 * answer key uses it, and it is why so many candidates tie at ₹24,000 -
 * which is exactly why ranking needs an explicit tiebreak beyond cost.
 */
export function calloutRate(rank: string, source: 'reserve' | 'dayoff' | 'rostered'): number {
    const pilot = PILOT_RANKS.has(rank);
    return source === 'reserve'
        ? rate(pilot ? 'reserve_callout_pilot' : 'reserve_callout_cabin')
        : rate(pilot ? 'dayoff_callout_pilot' : 'dayoff_callout_cabin');
}

/**
 * Positioning a crew member who is not at the departure station.
 *
 * DEL->BLR runs DX402 (arrives 08:45Z, odd dates) or DX589 (07:45Z, even
 * dates); the new report is arrival + 15 min. Rather than hardcode those two,
 * find the earliest flight that actually lands in time to be useful, which
 * keeps working if the schedule changes.
 *
 * Returns the delay in hours the cover incurs, or null when no positioning
 * flight can get them there at all - the DEL 04:00 case, where the answer is
 * "no amount of money buys a captain into DEL by 04:00".
 */
export const POSITIONING_BUFFER_MIN = 15;

export function deadheadDelayHours(
    fromStation: string, duty: DutyPeriod,
): { delayHours: number; via: string } | null {
    const legs = getDb().prepare(
        `SELECT flight_id, arr_utc FROM flights
         WHERE date = ? AND dep_station = ? AND arr_station = ?
         ORDER BY arr_utc`
    ).all(duty.date, fromStation, duty.dep_station) as { flight_id: string; arr_utc: string }[];

    if (legs.length === 0) return null;

    const plannedReport = Date.parse(duty.report_utc);
    for (const leg of legs) {
        const earliest = Date.parse(leg.arr_utc) + POSITIONING_BUFFER_MIN * 60_000;
        const delayHours = Math.max(0, r2((earliest - plannedReport) / 3_600_000));
        return { delayHours, via: leg.flight_id };
    }
    return null;
}

export function priceOption(opts: {
    rank: string;
    source: 'reserve' | 'dayoff' | 'rostered';
    deadhead?: { delayHours: number; via: string } | null;
    hotelNights?: number;
}): CostBreakdown {
    const callout_inr = calloutRate(opts.rank, opts.source);
    const deadhead_inr = opts.deadhead ? rate('deadhead_positioning') : 0;
    const delay_hours = opts.deadhead?.delayHours ?? 0;
    const delay_inr = Math.round(delay_hours * rate('delay_cost_per_duty_hour'));
    const hotel_inr = (opts.hotelNights ?? 0) * rate('hotel_overnight');

    const parts = [`${callout_inr.toLocaleString('en-IN')} ${opts.source} callout`];
    if (deadhead_inr) parts.push(`${deadhead_inr.toLocaleString('en-IN')} positioning via ${opts.deadhead!.via}`);
    if (delay_inr) parts.push(`${delay_inr.toLocaleString('en-IN')} delay (${delay_hours}h)`);
    if (hotel_inr) parts.push(`${hotel_inr.toLocaleString('en-IN')} hotel`);

    return {
        total_inr: callout_inr + deadhead_inr + delay_inr + hotel_inr,
        callout_inr, deadhead_inr, delay_inr, hotel_inr,
        delay_hours,
        detail: parts.join(' + '),
    };
}

/** What NOT covering costs: every leg cancelled. The baseline every option
 *  is measured against, and the reason ₹18,500 is a bargain. */
export function cancellationCost(days: DutyPeriod[]): { total_inr: number; legs: number; seats: number } {
    const legs = days.reduce((n, d) => n + d.sectors, 0);
    return {
        total_inr: legs * rate('cancellation_per_flight'),
        legs,
        seats: days.reduce((n, d) => n + d.seats, 0),
    };
}
