"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RulesEngine = exports.Schemas = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const zod_1 = require("zod");
const luxon_1 = require("luxon");
const db_1 = require("./db");
exports.Schemas = {
    FDP01: zod_1.z.object({
        numSectors: zod_1.z.number().int().min(1).describe("Number of flight legs"),
        proposedFdpHours: zod_1.z.number().positive().describe("Proposed total flight duty period in hours")
    }),
    DUTY02: zod_1.z.object({
        crewId: zod_1.z.string().describe("Crew ID (e.g., C-1042)"),
        newDutyHours: zod_1.z.number().positive().describe("Length of new duty in hours")
    }),
    FLT03: zod_1.z.object({
        crewId: zod_1.z.string(),
        newFlightHours: zod_1.z.number().positive()
    }),
    REST04: zod_1.z.object({
        crewId: zod_1.z.string(),
        newReportUtc: zod_1.z.string().datetime().describe("UTC ISO string of next report time")
    }),
    QUAL05: zod_1.z.object({
        crewId: zod_1.z.string(),
        targetAircraftType: zod_1.z.string().describe("Aircraft type (e.g., A320, ATR72)")
    }),
    CERT06: zod_1.z.object({
        crewId: zod_1.z.string(),
        dutyDate: zod_1.z.string().describe("Date of duty in YYYY-MM-DD")
    }),
    BASE07: zod_1.z.object({
        crewId: zod_1.z.string(),
        requiredDepartureStation: zod_1.z.string().describe("Station code (e.g., BLR)")
    })
};
// =================================================================
// CACHE
// =================================================================
const DATA_DIR = path_1.default.resolve(__dirname, '../data');
let certsCache = null;
function getCertifications() {
    if (!certsCache) {
        certsCache = JSON.parse(fs_1.default.readFileSync(path_1.default.join(DATA_DIR, 'certifications.json'), 'utf-8'));
    }
    return certsCache;
}
// =================================================================
// RULES ENGINE (The Deterministic Core)
// =================================================================
class RulesEngine {
    static checkFdp01(input) {
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
    static checkDuty02(input) {
        const { crewId, newDutyHours } = input;
        const db = (0, db_1.getDb)();
        try {
            const row = db.prepare("SELECT duty_hours_7d FROM duty_clocks WHERE crew_id = ?").get(crewId);
            if (!row)
                return { rule_id: "RULE-DUTY-02", legal: false, reason: "Crew member not found." };
            const projected = row.duty_hours_7d + newDutyHours;
            const legal = projected <= 60.0;
            return {
                rule_id: "RULE-DUTY-02",
                legal,
                reason: legal ? `Legal. ${row.duty_hours_7d}h + ${newDutyHours}h = ${projected}h (Limit: 60h)`
                    : `Violation. Projected ${projected}h exceeds 60h/7d limit.`
            };
        }
        finally {
            db.close();
        }
    }
    static checkFlt03(input) {
        const { crewId, newFlightHours } = input;
        const db = (0, db_1.getDb)();
        try {
            const row = db.prepare("SELECT flight_hours_28d FROM duty_clocks WHERE crew_id = ?").get(crewId);
            if (!row)
                return { rule_id: "RULE-FLT-03", legal: false, reason: "Crew member not found." };
            const projected = row.flight_hours_28d + newFlightHours;
            const legal = projected <= 100.0;
            return {
                rule_id: "RULE-FLT-03",
                legal,
                reason: legal ? `Legal. ${row.flight_hours_28d}h + ${newFlightHours}h = ${projected}h (Limit: 100h)`
                    : `Violation. Projected ${projected}h exceeds 100h/28d limit.`
            };
        }
        finally {
            db.close();
        }
    }
    static checkRest04(input) {
        const { crewId, newReportUtc } = input;
        const db = (0, db_1.getDb)();
        try {
            const row = db.prepare("SELECT last_rest_ended FROM duty_clocks WHERE crew_id = ?").get(crewId);
            if (!row || !row.last_rest_ended) {
                return { rule_id: "RULE-REST-04", legal: true, reason: "No previous rest constraint found." };
            }
            // Using Luxon for precise UTC timezone matching
            const lastRest = luxon_1.DateTime.fromISO(row.last_rest_ended, { zone: 'utc' });
            const newReport = luxon_1.DateTime.fromISO(newReportUtc, { zone: 'utc' });
            const legal = newReport >= lastRest;
            return {
                rule_id: "RULE-REST-04",
                legal,
                reason: legal ? "Legal. Adequate rest achieved." : `Violation. Crew cannot report before ${row.last_rest_ended}.`
            };
        }
        finally {
            db.close();
        }
    }
    static checkQual05(input) {
        const { crewId, targetAircraftType } = input;
        const db = (0, db_1.getDb)();
        try {
            const row = db.prepare("SELECT ratings FROM crew WHERE crew_id = ?").get(crewId);
            if (!row)
                return { rule_id: "RULE-QUAL-05", legal: false, reason: "Crew member not found." };
            const ratingsList = JSON.parse(row.ratings);
            const legal = ratingsList.includes(targetAircraftType);
            return {
                rule_id: "RULE-QUAL-05",
                legal,
                reason: legal ? `Legal. Rated for ${targetAircraftType}.` : `Violation. Crew is not rated for ${targetAircraftType}.`
            };
        }
        finally {
            db.close();
        }
    }
    static checkCert06(input) {
        const { crewId, dutyDate } = input;
        const certs = getCertifications();
        for (const cert of certs) {
            if (cert.crew_id === crewId) {
                // Using Luxon to parse the calendar dates securely
                const certValidTo = luxon_1.DateTime.fromISO(cert.valid_to, { zone: 'utc' });
                const proposedDutyDate = luxon_1.DateTime.fromISO(dutyDate, { zone: 'utc' });
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
    static checkBase07(input) {
        const { crewId, requiredDepartureStation } = input;
        const db = (0, db_1.getDb)();
        try {
            const row = db.prepare("SELECT base FROM crew WHERE crew_id = ?").get(crewId);
            if (!row)
                return { rule_id: "RULE-BASE-07", legal: false, reason: "Crew member not found." };
            if (row.base === requiredDepartureStation) {
                return { rule_id: "RULE-BASE-07", legal: true, cost_incurred: false, reason: `Legal. Crew is at base ${row.base}.` };
            }
            else {
                return {
                    rule_id: "RULE-BASE-07",
                    legal: true,
                    cost_incurred: true,
                    reason: `Legal but expensive. Deadhead positioning from ${row.base} to ${requiredDepartureStation} required.`
                };
            }
        }
        finally {
            db.close();
        }
    }
}
exports.RulesEngine = RulesEngine;
