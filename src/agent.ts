import { ChatOpenAI } from "@langchain/openai";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { RulesEngine, Schemas as RuleSchemas } from "./rulesEngine";
import { QueryEngine, QuerySchemas } from "./queryEngine";
import { simulateImpact } from "./simulator";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getDb, closeDb } from "./db";

/**
 * 1. Define the Tools for LangGraph
 * We wrap our deterministic RulesEngine and Simulator into LangChain-compatible tools.
 * Tool schemas are declared as plain JSON Schema objects directly.
 */

const checkFdpLimitTool = tool(
    async (input: z.infer<typeof RuleSchemas.FDP01>) => {
        return JSON.stringify(RulesEngine.checkFdp01(input));
    },
    {
        name: "check_fdp_limit",
        description: "Evaluates RULE-FDP-01: Max flight duty period 13h, reduced 0.5h per sector beyond the 2nd.",
        schema: zodToJsonSchema(RuleSchemas.FDP01)
    }
);

const checkDutyLimitTool = tool(
    async (input: z.infer<typeof RuleSchemas.DUTY02>) => {
        return JSON.stringify(RulesEngine.checkDuty02(input));
    },
    {
        name: "check_7d_duty_limit",
        description: "Evaluates RULE-DUTY-02: Max 60 duty hours in any 7 consecutive calendar days.",
        schema: zodToJsonSchema(RuleSchemas.DUTY02)
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
    async (input: { date?: string; base?: string }) => {
        const date = input.date || new Date().toISOString().split('T')[0];
        const rows = QueryEngine.getReservePool({ ...input, date });
        return JSON.stringify(rows).length > 0 ? JSON.stringify(rows) : JSON.stringify({ result: [] });
    },
    {
        name: "get_reserve_pool",
        description: "Looks up which crew members are on reserve/standby for a specific date and base, and returns their on-call windows.",
        schema: {
            type: "object",
            properties: {
                date: {
                    type: "string",
                    description: "Date in YYYY-MM-DD format (defaults to current date)"
                },
                base: {
                    type: "string",
                    description: "Station code (e.g., BLR, DEL)"
                }
            }
        }
    }
);

const getDutyHours = tool(
    async (input: { crewId: string }) => {
        const result = QueryEngine.getDutyHours(input);
        return JSON.stringify(result).length > 0 ? JSON.stringify(result) : JSON.stringify({ result: null });
    },
    {
        name: "get_duty_hours",
        description: "Looks up a crew member's accumulated duty hours and rest times.",
        schema: {
            type: "object",
            properties: {
                crewId: {
                    type: "string",
                    description: "Crew ID (e.g., C-1042)"
                }
            },
            required: ["crewId"]
        }
    }
);

const getFlights = tool(
    async (input: { date?: string; depStation?: string; arrStation?: string }) => {
        const date = input.date || new Date().toISOString().split('T')[0];
        const rows = QueryEngine.getFlights({ ...input, date });
        return JSON.stringify(rows).length > 0 ? JSON.stringify(rows) : JSON.stringify({ result: [] });
    },
    {
        name: "get_flights",
        description: "Looks up flight schedules. If date is not provided, defaults to current date. Filter by departure or arrival station (e.g. DEL, BLR, BOM).",
        schema: {
            type: "object",
            properties: {
                date: {
                    type: "string",
                    description: "Date in YYYY-MM-DD format (defaults to current date if not provided or for 'today')"
                },
                depStation: {
                    type: "string",
                    description: "Departure station code (e.g., DEL)"
                },
                arrStation: {
                    type: "string",
                    description: "Arrival station code (e.g., BOM)"
                }
            }
        }
    }
);

const getExpiringCerts = tool(
    async (input: { dateFrom: string; dateTo: string }) => {
        const rows = QueryEngine.getExpiringCertifications(input);
        return JSON.stringify(rows).length > 0 ? JSON.stringify(rows) : JSON.stringify({ result: [] });
    },
    {
        name: "get_expiring_certifications",
        description: "Finds all crew medical/training certifications expiring within a specific date range.",
        schema: {
            type: "object",
            properties: {
                dateFrom: {
                    type: "string",
                    description: "Start date in YYYY-MM-DD"
                },
                dateTo: {
                    type: "string",
                    description: "End date in YYYY-MM-DD"
                }
            },
            required: ["dateFrom", "dateTo"]
        }
    }
);

const getCrew = tool(
    async (input: { crewId?: string; base?: string; rank?: string }) => {
        const rows = QueryEngine.getCrew(input);
        return JSON.stringify(rows).length > 0 ? JSON.stringify(rows) : JSON.stringify({ result: [] });
    },
    {
        name: "get_crew",
        description: "Looks up crew member details (rank, base, ratings).",
        schema: {
            type: "object",
            properties: {
                crewId: {
                    type: "string",
                    description: "Crew ID (e.g., C-1042)"
                },
                base: {
                    type: "string",
                    description: "Station code (e.g., BLR)"
                },
                rank: {
                    type: "string",
                    description: "Rank (e.g., Captain, First Officer, Cabin Crew)"
                }
            },
            required: []
        }
    }
);

const getPairing = tool(
    async (input: { pairingId: string }) => {
        const result = QueryEngine.getPairing(input);
        return JSON.stringify(result).length > 0 ? JSON.stringify(result) : JSON.stringify({ error: "Pairing not found" });
    },
    {
        name: "get_pairing",
        description: "Looks up the full details of a pairing by pairing ID.",
        schema: {
            type: "object",
            properties: {
                pairingId: {
                    type: "string",
                    description: "Pairing ID (e.g., P-2291)"
                }
            },
            required: ["pairingId"]
        }
    }
);

const checkFlightLimitTool = tool(
    async (input: z.infer<typeof RuleSchemas.FLT03>) => {
        return JSON.stringify(RulesEngine.checkFlt03(input));
    },
    {
        name: "check_flt03",
        description: "Evaluates RULE-FLT-03: Max 100 flight hours in any 28 consecutive calendar days.",
        schema: zodToJsonSchema(RuleSchemas.FLT03)
    }
);

const checkRest04Tool = tool(
    async (input: z.infer<typeof RuleSchemas.REST04>) => {
        return JSON.stringify(RulesEngine.checkRest04(input));
    },
    {
        name: "check_rest04",
        description: "Evaluates RULE-REST-04: Min 12h rest between release and next report.",
        schema: zodToJsonSchema(RuleSchemas.REST04)
    }
);

const checkQual05Tool = tool(
    async (input: z.infer<typeof RuleSchemas.QUAL05>) => {
        return JSON.stringify(RulesEngine.checkQual05(input));
    },
    {
        name: "check_qual05",
        description: "Evaluates RULE-QUAL-05: Crew must hold a valid rating for the assigned aircraft type.",
        schema: zodToJsonSchema(RuleSchemas.QUAL05)
    }
);

const checkCert06Tool = tool(
    async (input: z.infer<typeof RuleSchemas.CERT06>) => {
        return JSON.stringify(RulesEngine.checkCert06(input));
    },
    {
        name: "check_cert06",
        description: "Evaluates RULE-CERT-06: All certifications must be valid on the duty date.",
        schema: zodToJsonSchema(RuleSchemas.CERT06)
    }
);

const checkBase07Tool = tool(
    async (input: z.infer<typeof RuleSchemas.BASE07>) => {
        return JSON.stringify(RulesEngine.checkBase07(input));
    },
    {
        name: "check_base07",
        description: "Evaluates RULE-BASE-07: Reserve callout from own base only; covering from another base requires deadhead positioning.",
        schema: zodToJsonSchema(RuleSchemas.BASE07)
    }
);


const updateCrewStatusTool = tool(
    async (input: { crewId: string; status: string }) => {
        const db = getDb();
        db.prepare("UPDATE crew SET status = ? WHERE crew_id = ?").run(input.status, input.crewId);
        db.close();
        closeDb();
        return { success: true, crew_id: input.crewId, new_status: input.status };
    },
    {
        name: "update_crew_status",
        description: "Updates a crew member's status (e.g., 'sick', 'leave', 'training') in the database.",
        schema: zodToJsonSchema(z.object({
            crewId: z.string().describe("Crew ID (e.g., C-1042)"),
            status: z.string().describe("New status: 'active', 'sick', 'leave', 'training'")
        }))
    }
);

const assignPairingCrewTool = tool(
    async (input: { pairingId: string; crewId: string; role: string }) => {
        const db = getDb();
        const seq = db.prepare("SELECT MAX(seq) as max_seq FROM pairing_crew WHERE pairing_id = ?").get(input.pairingId) as any;
        const newSeq = (seq?.max_seq ?? 0) + 1;
        db.prepare("INSERT INTO pairing_crew (pairing_id, crew_id, role, seq) VALUES (?, ?, ?, ?)").run(input.pairingId, input.crewId, input.role, newSeq);
        db.close();
        closeDb();
        return { success: true, pairing_id: input.pairingId, crew_id: input.crewId, role: input.role };
    },
    {
        name: "assign_pairing_crew",
        description: "Assigns a crew member to a pairing with a specific role.",
        schema: zodToJsonSchema(z.object({
            pairingId: z.string().describe("Pairing ID (e.g., P-2201)"),
            crewId: z.string().describe("Crew ID (e.g., C-3315)"),
            role: z.string().describe("Role: 'Captain', 'First Officer', 'Senior Cabin Crew', 'Cabin Crew'")
        }))
    }
);

const rollbackDbTool = tool(
    async () => {
        closeDb();
        const { build } = await import('./ingest');
        build();
        return { success: true, message: "Database rolled back to original state" };
    },
    {
        name: "rollback_db",
        description: "Rolls back the database to its original state by rebuilding from JSON source.",
        schema: zodToJsonSchema(z.object({}))
    }
);

const tools = [checkFdpLimitTool, checkDutyLimitTool, simulateImpactTool,
    checkFlightLimitTool,
    lookupReservePool, getDutyHours, getFlights, getExpiringCerts, getCrew, getPairing,
    updateCrewStatusTool, assignPairingCrewTool, rollbackDbTool];
const toolNode = new ToolNode(tools);

/**
 * 2. Define the Graph Nodes
 */

const callModel = async (state: any) => {
    const openai = new ChatOpenAI({
        modelName: "sarvam-105b",
        temperature: 0,
        configuration: {
            baseURL: "https://api.sarvam.ai/v1",
            apiKey: process.env.SARVAM_API_KEY
        }
    }).bindTools(tools);
    
    const response = await openai.invoke(state.messages as BaseMessage[]);
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
