import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { getDb } from './db';

// =================================================================
// TYPES & SCHEMAS
// =================================================================

export interface RuleResult {
    rule_id: string;
    legal: boolean;
    reason: string;
    cost_incurred?: boolean;
}

export const Schemas = {
    FDP01: z.object({
        numSectors: z.number().int().min(1).describe("Number of flight legs"),
        proposedFdpHours: z.number().positive().describe("Proposed total flight duty period in hours")
    }),
    DUTY02: z.object({
        crewId: z.string().describe("Crew ID (e.g., C-1042)"),
        newDutyHours: z.number().positive().describe("Length of new duty in hours")
    }),
    FLT03: z.object({
        crewId: z.string(),
        newFlightHours: z.number().positive()
    }),
    REST04: z.object({
        crewId: z.string(),
        newReportUtc: z.string().datetime().describe("UTC ISO string of next report time")
    }),
    QUAL05: z.object({
        crewId: z.string(),
        targetAircraftType: z.string().describe("Aircraft type (e.g., A320, ATR72)")
    }),
    CERT06: z.object({
        crewId: z.string(),
        dutyDate: z.string().describe("Date of duty in YYYY-MM-DD")
    }),
    BASE07: z.object({
        crewId: z.string(),
        requiredDepartureStation: z.string().describe("Station code (e.g., BLR)")
    })
};

// =================================================================
// CACHE
// =================================================================
const DATA_DIR = path.resolve(__dirname, '../data');
let certsCache: any[] | null = null;

function getCertifications() {
    if (!certsCache) {
        certsCache = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'certifications.json'), 'utf-8'));
    }
    return certsCache!;
}

// =================================================================
// RULES ENGINE (The Deterministic Core)
// =================================================================

export class RulesEngine {
    
    static checkFdp01(input: z.infer<typeof Schemas.FDP01>): RuleResult {
        const { numSectors, proposedFdpHours } = input;
        const baseFdp = 13.0;
        const reduction = 0.5;
        const freeSectors = 2;
        
        const penaltySectors = Math.max(0, numSectors - freeSectors);
        const maxAllowed = baseFdp - (penaltySectors * reduction);
        const legal = proposedFdpHours <= maxAllowed;
        
        return {
            rule_id: "RULE-FDP-01",
            legal,
            reason: legal ? `Legal. ${proposedFdpHours}h <= ${maxAllowed}h` 
                          : `Violation. ${proposedFdpHours}h > ${maxAllowed}h limit for ${numSectors} sectors.`
        };
    }

    static checkDuty02(input: z.infer<typeof Schemas.DUTY02>): RuleResult {
        const { crewId, newDutyHours } = input;
        const db = getDb();
        try {
            const row = db.prepare("SELECT duty_hours_7d FROM duty_clocks WHERE crew_id = ?").get(crewId) as any;
            if (!row) return { rule_id: "RULE-DUTY-02", legal: false, reason: "Crew member not found." };

            const projected = row.duty_hours_7d + newDutyHours;
            const legal = projected <= 60.0;
            return {
                rule_id: "RULE-DUTY-02", 
                legal,
                reason: legal ? `Legal. ${row.duty_hours_7d}h + ${newDutyHours}h = ${projected}h (Limit: 60h)` 
                              : `Violation. Projected ${projected}h exceeds 60h/7d limit.`
            };
        } finally {
            db.close();
        }
    }

    static checkFlt03(input: z.infer<typeof Schemas.FLT03>): RuleResult {
        const { crewId, newFlightHours } = input;
        const db = getDb();
        try {
            const row = db.prepare("SELECT flight_hours_28d FROM duty_clocks WHERE crew_id = ?").get(crewId) as any;
            if (!row) return { rule_id: "RULE-FLT-03", legal: false, reason: "Crew member not found." };

            const projected = row.flight_hours_28d + newFlightHours;
            const legal = projected <= 100.0;
            return {
                rule_id: "RULE-FLT-03", 
                legal,
                reason: legal ? `Legal. ${row.flight_hours_28d}h + ${newFlightHours}h = ${projected}h (Limit: 100h)` 
                              : `Violation. Projected ${projected}h exceeds 100h/28d limit.`
            };
        } finally {
            db.close();
        }
    }

    static checkRest04(input: z.infer<typeof Schemas.REST04>): RuleResult {
        const { crewId, newReportUtc } = input;
        const db = getDb();
        try {
            const row = db.prepare("SELECT last_rest_ended FROM duty_clocks WHERE crew_id = ?").get(crewId) as any;
            if (!row || !row.last_rest_ended) {
                return { rule_id: "RULE-REST-04", legal: true, reason: "No previous rest constraint found." };
            }

            // Using Luxon for precise UTC timezone matching
            const lastRest = DateTime.fromISO(row.last_rest_ended, { zone: 'utc' });
            const newReport = DateTime.fromISO(newReportUtc, { zone: 'utc' });
            const legal = newReport >= lastRest;
            
            return {
                rule_id: "RULE-REST-04", 
                legal,
                reason: legal ? "Legal. Adequate rest achieved." : `Violation. Crew cannot report before ${row.last_rest_ended}.`
            };
        } finally {
            db.close();
        }
    }

    static checkQual05(input: z.infer<typeof Schemas.QUAL05>): RuleResult {
        const { crewId, targetAircraftType } = input;
        const db = getDb();
        try {
            const row = db.prepare("SELECT ratings FROM crew WHERE crew_id = ?").get(crewId) as any;
            if (!row) return { rule_id: "RULE-QUAL-05", legal: false, reason: "Crew member not found." };

            const ratingsList: string[] = JSON.parse(row.ratings);
            const legal = ratingsList.includes(targetAircraftType);
            return {
                rule_id: "RULE-QUAL-05", 
                legal,
                reason: legal ? `Legal. Rated for ${targetAircraftType}.` : `Violation. Crew is not rated for ${targetAircraftType}.`
            };
        } finally {
            db.close();
        }
    }

    static checkCert06(input: z.infer<typeof Schemas.CERT06>): RuleResult {
        const { crewId, dutyDate } = input;
        const certs = getCertifications();
            
        for (const cert of certs) {
            if (cert.crew_id === crewId) {
                // Using Luxon to parse the calendar dates securely
                const certValidTo = DateTime.fromISO(cert.valid_to, { zone: 'utc' });
                const proposedDutyDate = DateTime.fromISO(dutyDate, { zone: 'utc' });

                if (proposedDutyDate > certValidTo) {
                    return {
                        rule_id: "RULE-CERT-06",
                        legal: false,
                        reason: `Violation. ${cert.cert_type} expired on ${cert.valid_to}.`
                    };
                }
            }
        }
        return { rule_id: "RULE-CERT-06", legal: true, reason: "Legal. All certifications valid." };
    }

    static checkBase07(input: z.infer<typeof Schemas.BASE07>): RuleResult {
        const { crewId, requiredDepartureStation } = input;
        const db = getDb();
        try {
            const row = db.prepare("SELECT base FROM crew WHERE crew_id = ?").get(crewId) as any;
            if (!row) return { rule_id: "RULE-BASE-07", legal: false, reason: "Crew member not found." };

            if (row.base === requiredDepartureStation) {
                return { rule_id: "RULE-BASE-07", legal: true, cost_incurred: false, reason: `Legal. Crew is at base ${row.base}.` };
            } else {
                return {
                    rule_id: "RULE-BASE-07", 
                    legal: true,
                    cost_incurred: true, 
                    reason: `Legal but expensive. Deadhead positioning from ${row.base} to ${requiredDepartureStation} required.`
                };
            }
        } finally {
            db.close();
        }
    }
}
