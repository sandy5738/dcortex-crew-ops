// Load .env before anything reads process.env. Node 20.12+ built-in; no dotenv.
try { process.loadEnvFile(); } catch { /* no .env file - fall back to the deterministic path */ }

import express from 'express';
import cors from 'cors';
import { RulesEngine, Schemas as RuleSchemas } from './rulesEngine';
import { QueryEngine, QuerySchemas } from './queryEngine';
import { simulateImpact } from './simulator';
import { ask } from './agent';
import { llmEnabled } from './llm/sarvam';

const app = express();
app.use(cors());
app.use(express.json());

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
// MOCK CHAT ENDPOINT (Where the LLM orchestration lives)
// =================================================================
// =================================================================
// THE CONVERSATIONAL ENDPOINT
// =================================================================

/**
 * POST /ask  { query }  ->  { result, prose, degraded, decision_id }
 *
 * `result` is the Verdict the UI renders (ui/src/types.ts). `degraded` is
 * true when the deterministic parser or template narrator was used, and the
 * UI shows a "structured input mode" badge rather than an error — the system
 * still answers everything, only the phrasing tolerance narrows.
 */
app.post('/ask', async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) return res.status(400).json({ error: 'Body must include a non-empty "query".' });

    try {
        const answer = await ask(query);
        res.json({
            result: answer.result,
            prose: answer.prose,
            degraded: answer.degraded,
            tool: answer.tool,
            elapsed_ms: answer.elapsed_ms,
            decision_id: null,
        });
    } catch (e) {
        // Say what happened and what to do. Never "something went wrong".
        const message = e instanceof Error ? e.message : String(e);
        res.status(500).json({ error: `The engine failed on this question: ${message}` });
    }
});

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        llm: llmEnabled() ? 'sarvam' : 'deterministic',
        model: process.env.SARVAM_MODEL ?? 'sarvam-105b',
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Crew Ops Advisor API running on http://localhost:${PORT}`);
});
