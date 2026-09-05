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
