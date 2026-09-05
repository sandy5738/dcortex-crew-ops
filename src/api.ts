import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { RulesEngine, Schemas as RuleSchemas } from './rulesEngine';
import { QueryEngine, QuerySchemas } from './queryEngine';
import { simulateImpact } from './simulator';
import { graph } from './agent';

const app = express();
app.use(cors());
app.use(express.json());

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
// LANGGRAPH CHAT ENDPOINT (LLM orchestration via graph)
// =================================================================
app.post('/chat', async (req, res) => {
    const { message } = req.body;
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message field required (string)' });
    }

    try {
        const result = await graph.invoke({
            messages: [
                { role: 'system', content: 'You are the Crew Ops Advisor for dCortex Air. You have access to tools to judge crew pairings, duty limits, reserve pools, and disruption impacts. Always reason step by step using tools when the user asks for a legality check, lookup, or simulation.' },
                { role: 'user', content: message }
            ]
        });

        // Extract tool calls from the reasoning trail
        const toolCalls: any[] = [];
        for (const msg of result.messages) {
            const m = msg as any;
            if (m.tool_calls) {
                for (const tc of m.tool_calls) {
                    toolCalls.push({
                        tool_called: tc.name,
                        arguments: tc.args,
                        raw_result: undefined
                    });
                }
            }
            if (m.type === 'tool') {
                // Match tool results to tool calls
                for (const tc of toolCalls) {
                    if (!tc.raw_result && m.tool_call_id === tc.tool_called) {
                        tc.raw_result = m.content;
                    }
                }
            }
        }

        const last = result.messages[result.messages.length - 1];
        const answer = (last as any).content || (last as any).response || '';
        return res.json({ answer, reasoning_trail: toolCalls });
    } catch (err: any) {
        console.error('Agent error:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Crew Ops Advisor API running on http://localhost:${PORT}`);
});
