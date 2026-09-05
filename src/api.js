"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const rulesEngine_1 = require("./rulesEngine");
const simulator_1 = require("./simulator");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// =================================================================
// EXPRESS ROUTES (The Deterministic Boundary)
// =================================================================
app.post('/tools/check_fdp_limit', (req, res) => {
    // Validate request body against Zod Schema defined in rulesEngine
    const parsed = rulesEngine_1.Schemas.FDP01.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error);
    const result = rulesEngine_1.RulesEngine.checkFdp01(parsed.data);
    res.json(result);
});
app.post('/tools/check_7d_duty_limit', (req, res) => {
    const parsed = rulesEngine_1.Schemas.DUTY02.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error);
    const result = rulesEngine_1.RulesEngine.checkDuty02(parsed.data);
    res.json(result);
});
// Example of how you would expose the new rules:
app.post('/tools/check_certifications', (req, res) => {
    const parsed = rulesEngine_1.Schemas.CERT06.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error);
    const result = rulesEngine_1.RulesEngine.checkCert06(parsed.data);
    res.json(result);
});
// =================================================================
// MOCK CHAT ENDPOINT (Where the LLM orchestration lives)
// =================================================================
app.post('/chat', (req, res) => {
    const { message } = req.body;
    if (message.toLowerCase().includes("sick") && message.includes("C-5837")) {
        const toolResult = (0, simulator_1.simulateImpact)("C-5837", "2026-09-14");
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
