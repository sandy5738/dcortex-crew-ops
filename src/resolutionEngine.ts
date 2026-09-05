import { z } from 'zod';
import { getDb } from '../src/db';
import { RulesEngine, Schemas } from '../src/rulesEngine';
import { DateTime } from 'luxon';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = (description: string) =>
    z.string()
        .regex(DATE_RE, 'expected YYYY-MM-DD')
        .refine(s => DateTime.fromISO(s, { zone: 'utc' }).isValid,
                s => ({ message: `${s} is not a real calendar date` }))
        .describe(description);

export const ResolutionSchemas = {
    GenerateRecovery: z.object({
        pairingId: z.string().describe("The broken pairing ID (e.g., P-2291)"),
        missingRole: z.enum(['Captain', 'First Officer', 'Senior Cabin Crew', 'Cabin Crew'])
            .describe("The role that called in sick"),
        disruptedDate: isoDate("The date of the disruption in YYYY-MM-DD")
    })
};

export class ResolutionEngine {
    static generateRecoveryOptions(input: z.infer<typeof ResolutionSchemas.GenerateRecovery>): any {
        const { pairingId, missingRole, disruptedDate } = input;
        const db = getDb();
        const report = {
            broken_pairing_id: pairingId,
            viable_options: [] as any[],
            rejected_audit: [] as any[]
        };

        const pairingRow = db.prepare("SELECT aircraft FROM pairings WHERE pairing_id = ?").get(pairingId) as any;
        if (!pairingRow) throw new Error(`Pairing ${pairingId} not found.`);
        
        const remainingDays = db.prepare("SELECT date, report_utc, release_utc FROM pairing_days WHERE pairing_id = ? AND date >= ? ORDER BY date").all(pairingId, disruptedDate) as any[];
        if (remainingDays.length === 0) throw new Error(`Pairing ${pairingId} has no flights on or after ${disruptedDate}.`);

        const coverReleaseUtc = remainingDays[remainingDays.length - 1].release_utc;

        const firstFlightIdRow = db.prepare("SELECT flight_id FROM pairing_day_flights WHERE pairing_id = ? AND date = ? ORDER BY seq LIMIT 1").get(pairingId, disruptedDate) as any;
        const flightRow = db.prepare("SELECT dep_station, aircraft_type FROM flights WHERE flight_id = ?").get(firstFlightIdRow.flight_id) as any;
        const depStation = flightRow.dep_station;
        const targetAircraftType = flightRow.aircraft_type;

        const rawCandidates = db.prepare(`
            SELECT c.crew_id, c.base 
            FROM crew c
            JOIN crew_ratings cr ON c.crew_id = cr.crew_id
            WHERE c.rank = ? AND cr.rating = ? AND c.status = 'active'
              AND c.crew_id NOT IN (SELECT crew_id FROM pairing_crew WHERE pairing_id = ?)
        `).all(missingRole, targetAircraftType, pairingId) as any[];

        for (const candidate of rawCandidates) {
            const crewId = candidate.crew_id;
            const rulesChecked: string[] = [];
            let isLegal = true;
            let isDeadheading = false;
            let delayHours = 0;
            let adjustedReportUtc = remainingDays[0].report_utc;

            if (candidate.base !== depStation) {
                isDeadheading = true;
                const positionFlight = db.prepare("SELECT arr_utc, dep_utc FROM flights WHERE date = ? AND dep_station = ? AND arr_station = ? ORDER BY arr_utc LIMIT 1").get(disruptedDate, candidate.base, depStation) as any;
                if (!positionFlight) {
                    report.rejected_audit.push({ crew_id: crewId, rule_failed: "ROUTING", reason: "No positioning flight available" });
                    continue;
                }
                const originalReportTime = DateTime.fromISO(adjustedReportUtc, { zone: 'utc' });
                // We assume transit time is 0 for simplicity, report time is when the deadhead arrives
                const deadheadArrivalTime = DateTime.fromISO(positionFlight.arr_utc, { zone: 'utc' });
                if (deadheadArrivalTime > originalReportTime) {
                    delayHours = deadheadArrivalTime.diff(originalReportTime, 'hours').hours;
                    adjustedReportUtc = positionFlight.arr_utc;
                }
            }

            const priorProposed: Record<string, number> = {};
            let maxCost = 0;

            // Rest Check once before the loop (Rule 4)
            const restCheck = RulesEngine.checkRest04({ 
                crewId, 
                newReportUtc: adjustedReportUtc,
                coverReleaseUtc: coverReleaseUtc 
            });
            rulesChecked.push("RULE-REST-04");
            if (!restCheck.legal) {
                report.rejected_audit.push({ crew_id: crewId, rule_failed: restCheck.rule_id, reason: restCheck.reason });
                continue;
            }

            for (const day of remainingDays) {
                const reportTime = DateTime.fromISO(day.date === disruptedDate ? adjustedReportUtc : day.report_utc, { zone: 'utc' });
                const releaseTime = DateTime.fromISO(day.release_utc, { zone: 'utc' });
                // if delay is so large release is before report, it's invalid but let's assume release is adjusted too
                const proposedDutyHours = Math.max(0, releaseTime.plus({ hours: day.date === disruptedDate ? delayHours : 0 }).diff(reportTime, 'hours').hours);

                const blockHoursRow = db.prepare(`
                    SELECT count(*) as cnt, sum(f.block_hours) as total_block 
                    FROM pairing_day_flights pdf
                    JOIN flights f ON pdf.flight_id = f.flight_id
                    WHERE pdf.pairing_id = ? AND pdf.date = ?
                `).get(pairingId, day.date) as any;
                
                const proposedFlightHours = blockHoursRow.total_block || 0;
                const numSectors = blockHoursRow.cnt || 1;

                // FDP
                const fdpCheck = RulesEngine.checkFdp01({ numSectors, proposedFdpHours: proposedDutyHours });
                if (!rulesChecked.includes("RULE-FDP-01")) rulesChecked.push("RULE-FDP-01");
                if (!fdpCheck.legal) {
                    report.rejected_audit.push({ crew_id: crewId, rule_failed: fdpCheck.rule_id, reason: fdpCheck.reason });
                    isLegal = false; break;
                }

                const certCheck = RulesEngine.checkCert06({ crewId, dutyDate: day.date });
                if (!rulesChecked.includes("RULE-CERT-06")) rulesChecked.push("RULE-CERT-06");
                if (!certCheck.legal) {
                    report.rejected_audit.push({ crew_id: crewId, rule_failed: certCheck.rule_id, reason: certCheck.reason });
                    isLegal = false; break;
                }

                const dutyCheck = RulesEngine.checkDuty02({ crewId, newDutyHours: proposedDutyHours, dutyDate: day.date, priorProposed });
                if (!rulesChecked.includes("RULE-DUTY-02")) rulesChecked.push("RULE-DUTY-02");
                if (!dutyCheck.legal) {
                    report.rejected_audit.push({ crew_id: crewId, rule_failed: dutyCheck.rule_id, reason: dutyCheck.reason });
                    isLegal = false; break;
                }
                
                const fltCheck = RulesEngine.checkFlt03({ crewId, newFlightHours: proposedFlightHours, dutyDate: day.date, priorProposed });
                if (!rulesChecked.includes("RULE-FLT-03")) rulesChecked.push("RULE-FLT-03");
                if (!fltCheck.legal) {
                    report.rejected_audit.push({ crew_id: crewId, rule_failed: fltCheck.rule_id, reason: fltCheck.reason });
                    isLegal = false; break;
                }

                priorProposed[day.date] = proposedDutyHours;
            }

            if (!isLegal) continue;

            const isReserve = !!db.prepare(`
                SELECT 1 FROM reserves r
                JOIN reserve_dates rd ON r.crew_id = rd.crew_id
                WHERE r.crew_id = ? AND rd.date = ? 
                AND r.oncall_start <= ? AND r.oncall_end >= ?
            `).get(crewId, disruptedDate, DateTime.fromISO(adjustedReportUtc, { zone: 'utc' }).toFormat('HH:mm'), DateTime.fromISO(adjustedReportUtc, { zone: 'utc' }).toFormat('HH:mm'));

            const getCost = (key: string) => (db.prepare("SELECT value_int FROM costs WHERE key = ?").get(key) as any)?.value_int || 0;
            const isPilot = missingRole === 'Captain' || missingRole === 'First Officer';
            const reserveCost = getCost(isPilot ? 'reserve_callout_pilot' : 'reserve_callout_cabin');
            const dayOffCost = getCost(isPilot ? 'dayoff_callout_pilot' : 'dayoff_callout_cabin');
            const deadheadCost = getCost('deadhead_positioning');
            const delayCostPerHour = getCost('delay_cost_per_duty_hour');

            // "Reserve membership and reserve-window eligibility are collapsed into one boolean, causing out-of-window reserves to be treated as day-off crew. Determine reserve membership independently."
            const isReserveMember = !!db.prepare(`SELECT 1 FROM reserve_dates WHERE crew_id = ? AND date = ?`).get(crewId, disruptedDate);
            if (isReserveMember && !isReserve) {
                report.rejected_audit.push({ crew_id: crewId, rule_failed: "RESERVE_WINDOW", reason: "Out of reserve on-call window" });
                continue;
            }

            let cost = 0;
            let actionText = "";

            if (isDeadheading) {
                cost = (isReserveMember ? reserveCost : dayOffCost) + deadheadCost + (delayHours * delayCostPerHour);
                actionText = `Assign ${missingRole} ${crewId} (${isReserveMember ? 'reserve' : 'day-off'} callout + deadhead from ${candidate.base})`;
            } else if (isReserveMember) {
                cost = reserveCost + (delayHours * delayCostPerHour);
                actionText = `Assign ${missingRole} ${crewId} (reserve callout)`;
            } else {
                cost = dayOffCost + (delayHours * delayCostPerHour);
                actionText = `Assign ${missingRole} ${crewId} (day-off callout)`;
            }

            report.viable_options.push({
                action: actionText,
                crew_id: crewId,
                legal: true,
                rules_checked: rulesChecked,
                cost_inr: cost,
                delay_hours: delayHours
            });
        }

        report.viable_options.sort((a, b) => {
            if (a.cost_inr !== b.cost_inr) return a.cost_inr - b.cost_inr;
            return a.crew_id.localeCompare(b.crew_id);
        });
        
        report.viable_options.forEach((opt, index) => opt.rank = index + 1);

        return report;
    }
}
