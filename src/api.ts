import express from 'express';
import cors from 'cors';
import { RulesEngine, Schemas } from './rulesEngine';
import { simulateImpact } from './simulator';

const app = express();
app.use(cors());
app.use(express.json());

// =================================================================
// EXPRESS ROUTES (The Deterministic Boundary)
// =================================================================

app.post('/tools/check_fdp_limit', (req, res) => {
    // Validate request body against Zod Schema defined in rulesEngine
    const parsed = Schemas.FDP01.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);

    const result = RulesEngine.checkFdp01(parsed.data);
    res.json(result);
});

app.post('/tools/check_7d_duty_limit', (req, res) => {
    const parsed = Schemas.DUTY02.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);

    const result = RulesEngine.checkDuty02(parsed.data);
    res.json(result);
});

// Example of how you would expose the new rules:
app.post('/tools/check_certifications', (req, res) => {
    const parsed = Schemas.CERT06.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);

    const result = RulesEngine.checkCert06(parsed.data);
    res.json(result);
});


// =================================================================
// GENERIC TOOL DISPATCH (LLM function-calling entrypoint)
// POST /tools/call  { "name": "checkRuleFdp01", "arguments": { ... } }
// =================================================================
const toolDispatchers = {
    checkRuleFdp01: { schema: Schemas.FDP01, handler: (d: any) => RulesEngine.checkFdp01(d) },
    checkRuleDuty02: { schema: Schemas.DUTY02, handler: (d: any) => RulesEngine.checkDuty02(d) },
    checkRuleFlt03: { schema: Schemas.FLT03, handler: (d: any) => RulesEngine.checkFlt03(d) },
    checkRuleRest04: { schema: Schemas.REST04, handler: (d: any) => RulesEngine.checkRest04(d) },
    checkRuleQual05: { schema: Schemas.QUAL05, handler: (d: any) => RulesEngine.checkQual05(d) },
    checkRuleCert06: { schema: Schemas.CERT06, handler: (d: any) => RulesEngine.checkCert06(d) },
    checkRuleBase07: { schema: Schemas.BASE07, handler: (d: any) => RulesEngine.checkBase07(d) }
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
// MOCK CHAT ENDPOINT (Where the LLM orchestration lives)
// =================================================================
app.post('/chat', (req, res) => {
    const { message } = req.body;
    
    if (message.toLowerCase().includes("sick") && message.includes("C-5837")) {
        const toolResult: any = simulateImpact("C-5837", "2026-09-14");
        
        const answer = `Captain C-5837 is sick. This breaks Pairing ${toolResult.pairing_broken}. ` +
                       `As a result, ${toolResult.uncrewed_flights.length} flights are now uncrewed, ` +
                       `putting ${toolResult.passengers_affected} passengers at risk. ` +
                       `${toolResult.action_required}`;
                 
        return res.json({
            answer,
            reasoning_trail: [
                {
                    tool_called: "simulate_impact",
                    arguments: { crew_id: "C-5837", date: "2026-09-14" },
                    raw_result: toolResult
                }
            ]
        });
    }
    
    res.json({ answer: "I am a Node.js prototype. Ask me about C-5837 getting sick!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Crew Ops Advisor API running on http://localhost:${PORT}`);
});
