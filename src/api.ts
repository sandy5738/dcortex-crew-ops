import 'dotenv/config';
import express from 'express';
import cors from 'cors';
// @ts-ignore
import morgan from 'morgan';
import { RulesEngine, Schemas as RuleSchemas } from './rulesEngine';
import { QueryEngine, QuerySchemas } from './queryEngine';
import { simulateImpact } from './simulator';
import { graph } from './agent';
import { getDb, closeDb, openForUpdate } from './db';
import { opsSnapshot } from './opsSnapshot';

const app = express();
app.use(cors());
app.use(express.json());

// =================================================================
// OPS DECK (deterministic, no LLM) — one call powers the whole board
// =================================================================

app.get('/ops/snapshot', (_req, res) => {
    try {
        res.json(opsSnapshot());
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Setup Morgan logger with a custom token for the request body
morgan.token('body', (req: express.Request) => {
    return Object.keys(req.body || {}).length ? JSON.stringify(req.body) : '';
});
app.use(morgan(':method :url :status :res[content-length] bytes - :response-time ms \nPayload: :body\n'));

// =================================================================
// TIER 1: LOOKUP ENDPOINTS (Data Retrieval)
// =================================================================

app.post('/tools/get_reserve_pool', (req, res) => {
    const parsed = QuerySchemas.GetReservePool.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);
    res.json(QueryEngine.getReservePool(parsed.data));
});

app.post('/tools/get_duty_hours', (req, res) => {
    const parsed = QuerySchemas.GetDutyHours.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);
    res.json(QueryEngine.getDutyHours(parsed.data));
});

app.post('/tools/get_flights', (req, res) => {
    const parsed = QuerySchemas.GetFlights.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);
    res.json(QueryEngine.getFlights(parsed.data));
});

app.post('/tools/get_expiring_certifications', (req, res) => {
    const parsed = QuerySchemas.GetExpiringCertifications.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);
    res.json(QueryEngine.getExpiringCertifications(parsed.data));
});

app.post('/tools/get_crew', (req, res) => {
    const parsed = QuerySchemas.GetCrew.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);
    res.json(QueryEngine.getCrew(parsed.data));
});

app.post('/tools/get_pairing', (req, res) => {
    const parsed = QuerySchemas.GetPairing.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);
    res.json(QueryEngine.getPairing(parsed.data));
});


// =================================================================
// TIER 2 & 3: LEGALITY ENDPOINTS (Math & Constraints)
// =================================================================

app.post('/tools/check_fdp_limit', (req, res) => {
    const parsed = RuleSchemas.FDP01.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);
    res.json(RulesEngine.checkFdp01(parsed.data));
});

app.post('/tools/check_7d_duty_limit', (req, res) => {
    const parsed = RuleSchemas.DUTY02.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);
    res.json(RulesEngine.checkDuty02(parsed.data));
});

app.post('/tools/check_certifications', (req, res) => {
    const parsed = RuleSchemas.CERT06.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);
    res.json(RulesEngine.checkCert06(parsed.data));
});

app.post('/tools/simulate_impact', (req, res) => {
    // Basic mock mapping for the UI simulation
    const result = simulateImpact(req.body.crew_id, req.body.date);
    res.json(result);
});


// =================================================================
// GENERIC TOOL DISPATCH (LLM function-calling entrypoint)
// POST /tools/call  { "name": "checkRuleFdp01", "arguments": { ... } }
// =================================================================
const toolDispatchers = {
    checkRuleFdp01: { schema: RuleSchemas.FDP01, handler: (d: any) => RulesEngine.checkFdp01(d) },
    checkRuleDuty02: { schema: RuleSchemas.DUTY02, handler: (d: any) => RulesEngine.checkDuty02(d) },
    checkRuleFlt03: { schema: RuleSchemas.FLT03, handler: (d: any) => RulesEngine.checkFlt03(d) },
    checkRuleRest04: { schema: RuleSchemas.REST04, handler: (d: any) => RulesEngine.checkRest04(d) },
    checkRuleQual05: { schema: RuleSchemas.QUAL05, handler: (d: any) => RulesEngine.checkQual05(d) },
    checkRuleCert06: { schema: RuleSchemas.CERT06, handler: (d: any) => RulesEngine.checkCert06(d) },
    checkRuleBase07: { schema: RuleSchemas.BASE07, handler: (d: any) => RulesEngine.checkBase07(d) }
};

app.post('/tools/call', (req, res) => {
    const { name, arguments: args } = req.body || {};
    const tool = toolDispatchers[name as keyof typeof toolDispatchers];
    if (!tool) return res.status(404).json({ error: `Unknown tool: ${name}` });

    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success) return res.status(400).json(parsed.error);

    res.json(tool.handler(parsed.data));
});


// =================================================================
// UPDATE ENDPOINTS (DB modifications)
// =================================================================
app.post('/tools/update_crew_status', (req, res) => {
    const { crewId, status } = req.body;
    if (!crewId || !status) return res.status(400).json({ error: 'crewId and status required' });
    try {
        const db = openForUpdate();
        db.prepare("UPDATE crew SET status = ? WHERE crew_id = ?").run(status, crewId);
        db.close();
        closeDb();
        res.json({ success: true, crew_id: crewId, new_status: status });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tools/assign_pairing_crew', (req, res) => {
    const { pairingId, crewId, role } = req.body;
    if (!pairingId || !crewId || !role) return res.status(400).json({ error: 'pairingId, crewId, and role required' });
    try {
        const db = openForUpdate();
        const seq = db.prepare("SELECT MAX(seq) as max_seq FROM pairing_crew WHERE pairing_id = ?").get(pairingId) as any;
        const newSeq = (seq?.max_seq ?? 0) + 1;
        db.prepare("INSERT INTO pairing_crew (pairing_id, crew_id, role, seq) VALUES (?, ?, ?, ?)").run(pairingId, crewId, role, newSeq);
        db.close();
        closeDb();
        res.json({ success: true, pairing_id: pairingId, crew_id: crewId, role: role });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tools/rollback_db', (req, res) => {
    try {
        closeDb();
        const { build } = require('./ingest');
        build();
        res.json({ success: true, message: 'Database rolled back to original state' });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});
app.post('/chat', async (req, res) => {
    const { message, history } = req.body;
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message field required (string)' });
    }

    const safeHistory = Array.isArray(history)
        ? history
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .slice(-20)
        : [];

    function parseMaybeJson(value: unknown): unknown {
        if (typeof value !== 'string') return value;
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }

    try {
        const systemPrompt = `You are the Crew Ops Advisor for dCortex Air.
Current operational context:
- Today's date is current date (UTC snapshot).
- Operational schedule window is current date through current date + 6 days.
- When the user refers to "today", "this afternoon", "tonight", or does not specify a date, use current date.
- When the user refers to "tomorrow", use the day after current date.
You have access to tools to query flights, crew, reserve pools, duty hours, certifications, pairings, check legality rules (FDP limits, 7-day duty, 28-day flight hours, minimum rest, aircraft ratings, certifications, base/deadhead), and disruption simulations.
Always call the appropriate tool to query the database or evaluate rules when answering user questions. Reason step-by-step using deterministic tool results.
When providing crew replacement options, format as JSON with options array containing: rank, action, legal, rules_checked, cost_inr, coverage, reasoning.`;

        // Some providers occasionally end a long tool loop with an empty
        // final message. One immediate retry with the same inputs fixes it
        // far more often than it re-fails, and the UI gets an answer
        // instead of a shrug.
        let result: Awaited<ReturnType<typeof graph.invoke>>;
        try {
            result = await graph.invoke({
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...safeHistory,
                    { role: 'user', content: message }
                ]
            });
            const finalMsg = result.messages[result.messages.length - 1] as any;
            const finalContent = finalMsg?.content ?? finalMsg?.response ?? '';
            if (typeof finalContent !== 'string' || finalContent.trim() === '') {
                throw new Error('empty final message');
            }
        } catch (first: any) {
            console.warn(`Agent first pass failed (${first.message ?? 'unknown'}), retrying once…`);
            result = await graph.invoke({
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...safeHistory,
                    { role: 'user', content: message }
                ]
            });
        }

        // Extract tool calls and pair them with tool outputs for transparency.
        const toolCalls: any[] = [];
        const byToolCallId = new Map<string, { tool_called: string; arguments: unknown; raw_result: unknown }>();

        for (const msg of result.messages) {
            const m = msg as any;
            if (m.tool_calls && Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                    const row = {
                        tool_called: tc.name,
                        arguments: tc.args,
                        raw_result: null
                    };
                    toolCalls.push(row);
                    if (tc.id) byToolCallId.set(tc.id, row);
                }
            }

            if (m.type === 'tool') {
                const parsedContent = parseMaybeJson(m.content);
                const matched = m.tool_call_id ? byToolCallId.get(m.tool_call_id) : undefined;
                if (matched) {
                    matched.raw_result = parsedContent;
                } else {
                    toolCalls.push({
                        tool_called: m.name || 'tool',
                        arguments: {},
                        raw_result: parsedContent
                    });
                }
            }
        }

        const reasoning_trail = toolCalls;
        const last = result.messages[result.messages.length - 1];
        let answer = String((last as any).content || (last as any).response || '');

        // Models often preface the answer with "I now have all the
        // information…". A controller wants the answer, not the soliloquy.
        answer = answer.replace(
            /^\s*(?:I (?:now )?have (?:all|enough|the) (?:information|data)(?: needed|necessary)?[^.\n]*\.|Based on (?:the|my) (?:tool results|data|information)[^.\n]*\.)\s*/i,
            '',
        );

        // Try to parse answer as JSON if it looks like JSON
        try {
            const jsonMatch = answer.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.options && Array.isArray(parsed.options)) {
                    return res.json({ ...parsed, reasoning_trail });
                }
            }
        } catch {}

        return res.json({ answer, reasoning_trail });
    } catch (err: any) {
        console.error('Agent error:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Crew Ops Advisor API running on http://localhost:${PORT}`);
});
