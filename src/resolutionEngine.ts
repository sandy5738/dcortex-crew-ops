import { z } from 'zod';
import { getDb } from './db';
import { RulesEngine, Schemas } from './rulesEngine';
import { DateTime } from 'luxon';

// =================================================================
// SCHEMAS & INTERFACES
// =================================================================

export const ResolutionSchemas = {
    GenerateRecovery: z.object({
        pairingId: z.string().describe("The broken pairing ID (e.g., P-2291)"),
        missingRole: z.string().describe("The role that called in sick (e.g., Captain)"),
        disruptedDate: z.string().describe("The date of the disruption in YYYY-MM-DD")
    })
};

export interface CandidateResult {
    action: string;
    crew_id: string;
    legal: boolean;
    rules_checked: string[];
    cost_inr: number;
    delay_hours: number;
    rank?: number;
}

export interface RejectedAudit {
    crew_id: string;
    rule_failed: string;
    reason: string;
}

export interface RecoveryReport {
    broken_pairing_id: string;
    viable_options: CandidateResult[];
    rejected_audit: RejectedAudit[];
}

// =================================================================
// RESOLUTION ENGINE
// =================================================================

export class ResolutionEngine {

    static generateRecoveryOptions(input: z.infer<typeof ResolutionSchemas.GenerateRecovery>): RecoveryReport {
        const { pairingId, missingRole, disruptedDate } = input;
        const db = getDb();
        const report: RecoveryReport = {
            broken_pairing_id: pairingId,
            viable_options: [],
            rejected_audit: []
        };

        // 1. Fetch Pairing Details
        const pairingRow = db.prepare("SELECT aircraft FROM pairings WHERE pairing_id = ?").get(pairingId) as any;
        if (!pairingRow) throw new Error(`Pairing ${pairingId} not found.`);
        
        // Find the specific day in the pairing
        const dayPlan = db.prepare("SELECT report_utc, release_utc FROM pairing_days WHERE pairing_id = ? AND date = ?").get(pairingId, disruptedDate) as any;
        if (!dayPlan) throw new Error(`Pairing ${pairingId} has no flights on ${disruptedDate}.`);

        const reportUtc = dayPlan.report_utc;
        const releaseUtc = dayPlan.release_utc;
        
        // Calculate proposed duty hours for the day
        const reportTime = DateTime.fromISO(reportUtc, { zone: 'utc' });
        const releaseTime = DateTime.fromISO(releaseUtc, { zone: 'utc' });
        const proposedDutyHours = releaseTime.diff(reportTime, 'hours').hours;

        // Get the first flight's departure station to check Base
        const firstFlightIdRow = db.prepare("SELECT flight_id FROM pairing_day_flights WHERE pairing_id = ? AND date = ? ORDER BY seq LIMIT 1").get(pairingId, disruptedDate) as any;
        const flightRow = db.prepare("SELECT dep_station, aircraft_type FROM flights WHERE flight_id = ?").get(firstFlightIdRow.flight_id) as any;
        
        const depStation = flightRow.dep_station;
        const targetAircraftType = flightRow.aircraft_type;

        // 2. SQL Funnel: Prune to candidates with the right Rank and Ratings
        const rawCandidates = db.prepare(`
            SELECT c.crew_id, c.base 
            FROM crew c
            JOIN crew_ratings cr ON c.crew_id = cr.crew_id
            WHERE c.rank = ? AND cr.rating = ?
        `).all(missingRole, targetAircraftType) as any[];

        // 3. Deterministic Rules Sieve
        for (const candidate of rawCandidates) {
            const crewId = candidate.crew_id;
            const rulesChecked: string[] = [];

            // A. Base Check (RULE-BASE-07)
            const baseCheck = RulesEngine.checkBase07({ crewId, requiredDepartureStation: depStation });
            rulesChecked.push("RULE-BASE-07");
            
            // We allow deadheading (cost_incurred = true), but if it's completely illegal, drop them.
            if (!baseCheck.legal) {
                report.rejected_audit.push({ crew_id: crewId, rule_failed: baseCheck.rule_id, reason: baseCheck.reason });
                continue;
            }
            
            const isDeadheading = baseCheck.cost_incurred;
            const delayHours = isDeadheading ? 3.0 : 0.0; 

            // B. Rest Check (RULE-REST-04)
            const restCheck = RulesEngine.checkRest04({ crewId, newReportUtc: reportUtc });
            rulesChecked.push("RULE-REST-04");
            if (!restCheck.legal) {
                report.rejected_audit.push({ crew_id: crewId, rule_failed: restCheck.rule_id, reason: restCheck.reason });
                continue;
            }

            // C. Certifications Check (RULE-CERT-06)
            const certCheck = RulesEngine.checkCert06({ crewId, dutyDate: disruptedDate });
            rulesChecked.push("RULE-CERT-06");
            if (!certCheck.legal) {
                report.rejected_audit.push({ crew_id: crewId, rule_failed: certCheck.rule_id, reason: certCheck.reason });
                continue;
            }

            // D. 7-Day Duty Limit (RULE-DUTY-02)
            const dutyCheck = RulesEngine.checkDuty02({ 
                crewId, 
                newDutyHours: proposedDutyHours, 
                dutyDate: disruptedDate 
            });
            rulesChecked.push("RULE-DUTY-02");
            if (!dutyCheck.legal) {
                report.rejected_audit.push({ crew_id: crewId, rule_failed: dutyCheck.rule_id, reason: dutyCheck.reason });
                continue;
            }
            
            // E. 28-Day Flight Limit (RULE-FLT-03)
            const fltCheck = RulesEngine.checkFlt03({ 
                crewId, 
                newFlightHours: proposedDutyHours * 0.75, // approximate block time
                dutyDate: disruptedDate 
            });
            rulesChecked.push("RULE-FLT-03");
            if (!fltCheck.legal) {
                report.rejected_audit.push({ crew_id: crewId, rule_failed: fltCheck.rule_id, reason: fltCheck.reason });
                continue;
            }

            // 4. Cost Engine
            const isReserve = !!db.prepare(`
                SELECT 1 FROM reserves r
                JOIN reserve_dates rd ON r.crew_id = rd.crew_id
                WHERE r.crew_id = ? AND rd.date = ? 
                AND r.oncall_start <= ? AND r.oncall_end >= ?
            `).get(crewId, disruptedDate, reportTime.toFormat('HH:mm'), reportTime.toFormat('HH:mm'));

            // Fetch dynamic costs from the database
            const getCost = (key: string) => (db.prepare("SELECT value_int FROM costs WHERE key = ?").get(key) as any)?.value_int || 0;
            
            const isPilot = missingRole === 'Captain' || missingRole === 'First Officer';
            const reserveCost = getCost(isPilot ? 'reserve_callout_pilot' : 'reserve_callout_cabin');
            const dayOffCost = getCost(isPilot ? 'dayoff_callout_pilot' : 'dayoff_callout_cabin');
            const deadheadCost = getCost('deadhead_positioning');
            const delayCostPerHour = getCost('delay_cost_per_duty_hour');

            let cost = 0;
            let actionText = "";

            if (isDeadheading) {
                // Reserve callout + Deadhead flight + Delay penalty (e.g., 3 hours * delay cost)
                cost = reserveCost + deadheadCost + (delayHours * delayCostPerHour);
                actionText = `Assign ${missingRole} ${crewId} (reserve callout + deadhead from ${candidate.base})`;
            } else if (isReserve) {
                cost = reserveCost;
                actionText = `Assign ${missingRole} ${crewId} (reserve callout)`;
            } else {
                cost = dayOffCost;
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

        // 5. Ranking
        report.viable_options.sort((a, b) => a.cost_inr - b.cost_inr);
        
        report.viable_options.forEach((opt, index) => {
            opt.rank = index + 1;
        });

        return report;
    }
}
