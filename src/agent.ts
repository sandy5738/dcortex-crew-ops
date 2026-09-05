import { ChatOpenAI } from "@langchain/openai";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { RulesEngine, Schemas as RuleSchemas } from "./rulesEngine";
import { QueryEngine, QuerySchemas } from "./queryEngine";
import { simulateImpact } from "./simulator";
import { z } from "zod";

/**
 * 1. Define the Tools for LangGraph
 *
 * Every tool passes its Zod schema directly. LangChain (>=1.0) understands
 * Zod 4 natively: it derives the OpenAI tool parameters AND validates the
 * model's arguments against the same schema before the engine runs. The
 * hand-written JSON Schema duplicates from the previous version are gone —
 * one schema is the single source of truth for the LLM's contract and the
 * deterministic engine's input check.
 */

const checkFdpLimitTool = tool(
    async (input: z.infer<typeof RuleSchemas.FDP01>) => {
        return JSON.stringify(RulesEngine.checkFdp01(input));
    },
    {
        name: "check_fdp_limit",
        description: "Evaluates RULE-FDP-01: Max flight duty period 13h, reduced 0.5h per sector beyond the 2nd.",
        schema: RuleSchemas.FDP01
    }
);

const checkDutyLimitTool = tool(
    async (input: z.infer<typeof RuleSchemas.DUTY02>) => {
        return JSON.stringify(RulesEngine.checkDuty02(input));
    },
    {
        name: "check_7d_duty_limit",
        description: "Evaluates RULE-DUTY-02: Max 60 duty hours in any 7 consecutive calendar days.",
        schema: RuleSchemas.DUTY02
    }
);

const checkFlightHoursTool = tool(
    async (input: z.infer<typeof RuleSchemas.FLT03>) => {
        return JSON.stringify(RulesEngine.checkFlt03(input));
    },
    {
        name: "check_28d_flight_hours",
        description: "Evaluates RULE-FLT-03: Max 100 flight (block) hours in any 28 consecutive days.",
        schema: RuleSchemas.FLT03
    }
);

const checkRest04Tool = tool(
    async (input: z.infer<typeof RuleSchemas.REST04>) => {
        return JSON.stringify(RulesEngine.checkRest04(input));
    },
    {
        name: "check_rest04",
        description: "Evaluates RULE-REST-04: Min 12h rest between release and next report, checked in both directions, plus double-booking detection.",
        schema: RuleSchemas.REST04
    }
);

const checkQual05Tool = tool(
    async (input: z.infer<typeof RuleSchemas.QUAL05>) => {
        return JSON.stringify(RulesEngine.checkQual05(input));
    },
    {
        name: "check_qual05",
        description: "Evaluates RULE-QUAL-05: Crew must hold a valid rating for the assigned aircraft type.",
        schema: RuleSchemas.QUAL05
    }
);

const checkCert06Tool = tool(
    async (input: z.infer<typeof RuleSchemas.CERT06>) => {
        return JSON.stringify(RulesEngine.checkCert06(input));
    },
    {
        name: "check_cert06",
        description: "Evaluates RULE-CERT-06: All certifications must be valid on the duty date.",
        schema: RuleSchemas.CERT06
    }
);

const checkBase07Tool = tool(
    async (input: z.infer<typeof RuleSchemas.BASE07>) => {
        return JSON.stringify(RulesEngine.checkBase07(input));
    },
    {
        name: "check_base07",
        description: "Evaluates RULE-BASE-07: Reserve callout from own base only; covering from another base requires deadhead positioning.",
        schema: RuleSchemas.BASE07
    }
);

const simulateImpactTool = tool(
    async (input: { crew_id: string; date: string }) => {
        const result = simulateImpact(input.crew_id, input.date);
        return JSON.stringify(result);
    },
    {
        name: "simulate_impact",
        description: "Simulates the ripple effect of a crew member being unavailable (e.g., sick) on a specific date.",
        schema: {
            type: "object",
            properties: {
                crew_id: {
                    type: "string",
                    description: "The ID of the crew member who is disrupted."
                },
                date: {
                    type: "string",
                    description: "The date of the disruption in YYYY-MM-DD format."
                }
            },
            required: ["crew_id", "date"]
        }
    }
);

const lookupReservePool = tool(
    async (input: z.infer<typeof QuerySchemas.GetReservePool>) => {
        const rows = QueryEngine.getReservePool(input);
        return JSON.stringify(rows).length > 0 ? JSON.stringify(rows) : JSON.stringify({ result: [] });
    },
    {
        name: "get_reserve_pool",
        description: "Looks up which crew members are on reserve/standby for a specific date and base.",
        schema: QuerySchemas.GetReservePool
    }
);

const getDutyHours = tool(
    async (input: z.infer<typeof QuerySchemas.GetDutyHours>) => {
        const result = QueryEngine.getDutyHours(input);
        return JSON.stringify(result).length > 0 ? JSON.stringify(result) : JSON.stringify({ result: null });
    },
    {
        name: "get_duty_hours",
        description: "Looks up a crew member's accumulated duty hours and rest times.",
        schema: QuerySchemas.GetDutyHours
    }
);

const getFlights = tool(
    async (input: z.infer<typeof QuerySchemas.GetFlights>) => {
        const rows = QueryEngine.getFlights(input);
        return JSON.stringify(rows).length > 0 ? JSON.stringify(rows) : JSON.stringify({ result: [] });
    },
    {
        name: "get_flights",
        description: "Looks up flight schedules for a given date. Optionally filter by departure or arrival station.",
        schema: QuerySchemas.GetFlights
    }
);

const getExpiringCerts = tool(
    async (input: z.infer<typeof QuerySchemas.GetExpiringCertifications>) => {
        const rows = QueryEngine.getExpiringCertifications(input);
        return JSON.stringify(rows).length > 0 ? JSON.stringify(rows) : JSON.stringify({ result: [] });
    },
    {
        name: "get_expiring_certifications",
        description: "Finds all crew medical/training certifications expiring within a specific date range.",
        schema: QuerySchemas.GetExpiringCertifications
    }
);

const getCrew = tool(
    async (input: z.infer<typeof QuerySchemas.GetCrew>) => {
        const rows = QueryEngine.getCrew(input);
        return JSON.stringify(rows).length > 0 ? JSON.stringify(rows) : JSON.stringify({ result: [] });
    },
    {
        name: "get_crew",
        description: "Looks up crew member details (rank, base, ratings).",
        schema: QuerySchemas.GetCrew
    }
);

const getPairing = tool(
    async (input: z.infer<typeof QuerySchemas.GetPairing>) => {
        const result = QueryEngine.getPairing(input);
        return JSON.stringify(result).length > 0 ? JSON.stringify(result) : JSON.stringify({ error: "Pairing not found" });
    },
    {
        name: "get_pairing",
        description: "Looks up the full details of a pairing (the schedule of flights and assigned crew) by pairing ID.",
        schema: QuerySchemas.GetPairing
    }
);

export const tools = [checkFdpLimitTool, checkDutyLimitTool, checkFlightHoursTool, checkRest04Tool,
    checkQual05Tool, checkCert06Tool, checkBase07Tool, simulateImpactTool,
    lookupReservePool, getDutyHours, getFlights, getExpiringCerts, getCrew, getPairing];
const toolNode = new ToolNode(tools);

/**
 * 2. Define the Graph Nodes
 */

const callModel = async (state: any) => {
    const primaryModel = new ChatOpenAI({
        modelName: "sarvam-105b",
        temperature: 0,
        openAIApiKey: process.env.SARVAM_API_KEY || "missing",
        configuration: {
            baseURL: "https://api.sarvam.ai/v1",
            apiKey: process.env.SARVAM_API_KEY
        }
    }).bindTools(tools);

    const fallbackModel = new ChatOpenAI({
        modelName: "glm-4",
        temperature: 0,
        openAIApiKey: process.env.TOKENROUTER_API_KEY || "missing",
        configuration: {
            baseURL: "https://api.tokenrouter.com/v1",
            apiKey: process.env.TOKENROUTER_API_KEY
        }
    }).bindTools(tools);

    const modelWithFallback = primaryModel.withFallbacks({
        fallbacks: [fallbackModel]
    });

    const response = await modelWithFallback.invoke(state.messages as BaseMessage[]);
    return { messages: [response] };
};

/**
 * 3. Conditional Edge Logic
 */
const shouldContinue = (state: any) => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (typeof lastMessage === "object" && lastMessage !== null && "tool_calls" in lastMessage && (lastMessage as any).tool_calls?.length > 0) {
        return "tools";
    }
    return "__end__";
};

/**
 * 4. Build the Graph
 */
const workflow = new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue)
    .addEdge("tools", "agent");

export const graph = workflow.compile();
