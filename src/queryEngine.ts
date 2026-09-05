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
        pairingId: z.string().describe("Pairing ID (e.g., P-2291)")
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
            let sql = `
                SELECT r.crew_id, c.rank, r.oncall_start, r.oncall_end 
                FROM reserve_pool r
                JOIN crew c ON r.crew_id = c.crew_id
                WHERE r.date = ?
            `;
            const params: any[] = [date];
            if (base) {
                sql += ` AND r.base = ?`;
                params.push(base);
            }
            return db.prepare(sql).all(params);
        } finally {
            db.close();
        }
    }

    static getDutyHours(input: z.infer<typeof QuerySchemas.GetDutyHours>) {
        const db = getDb();
        try {
            return db.prepare("SELECT * FROM duty_clocks WHERE crew_id = ?").get(input.crewId) || { error: "Crew not found" };
        } finally {
            db.close();
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
            db.close();
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
            db.close();
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
            db.close();
        }
    }

    static getPairing(input: z.infer<typeof QuerySchemas.GetPairing>) {
        const db = getDb();
        try {
            const row = db.prepare("SELECT json_data FROM pairings WHERE pairing_id = ?").get(input.pairingId) as any;
            return row ? JSON.parse(row.json_data) : { error: "Pairing not found" };
        } finally {
            db.close();
        }
    }
}
