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
 * We wrap our deterministic RulesEngine and Simulator into LangChain-compatible tools.
 * Tool schemas are declared as plain JSON Schema objects directly.
 */

const checkFdpLimitTool = tool(
    async (input: { numSectors: number; proposedFdpHours: number }) => {
        return JSON.stringify(RulesEngine.checkFdp01(input));
    },
    {
        name: "check_fdp_limit",
        description: "Evaluates RULE-FDP-01: Max flight duty period 13h, reduced 0.5h per sector beyond the 2nd.",
        schema: {
            type: "object",
            properties: {
                numSectors: {
                    type: "integer",
                    minimum: 1,
                    description: "Number of flight legs"
                },
                proposedFdpHours: {
                    type: "number",
                    minimum: 0,
                    description: "Proposed total flight duty period in hours"
                }
            },
            required: ["numSectors", "proposedFdpHours"]
        }
    }
);

const checkDutyLimitTool = tool(
    async (input: { crewId: string; newDutyHours: number; dutyDate: string; priorProposed?: Record<string, number> }) => {
        return JSON.stringify(RulesEngine.checkDuty02(input));
    },
    {
        name: "check_7d_duty_limit",
        description: "Evaluates RULE-DUTY-02: Max 60 duty hours in any 7 consecutive calendar days.",
        schema: {
            type: "object",
            properties: {
                crewId: {
                    type: "string",
                    description: "Crew ID (e.g., C-1042)"
                },
                newDutyHours: {
                    type: "number",
                    minimum: 0,
                    description: "Length of new duty in hours"
                },
                dutyDate: {
                    type: "string",
                    description: "Date of the new duty, YYYY-MM-DD. The 7-day window ends on this date."
                },
                priorProposed: {
                    type: "object",
                    description: "Earlier days of the SAME multi-day assignment, date -> hours. Needed so day 2 of a pairing counts day 1s proposed duty."
                }
            },
            required: ["crewId", "newDutyHours", "dutyDate"]
        }
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
    async (input: { date: string; base?: string }) => {
        const rows = QueryEngine.getReservePool(input);
        return JSON.stringify(rows).length > 0 ? JSON.stringify(rows) : JSON.stringify({ result: [] });
    },
    {
        name: "get_reserve_pool",
        description: "Looks up which crew members are on reserve/standby for a specific date and base.",
        schema: {
            type: "object",
            properties: {
                date: {
                    type: "string",
                    description: "Date in YYYY-MM-DD format"
                },
                base: {
                    type: "string",
                    description: "Station code (e.g., BLR, DEL)"
                }
            },
            required: ["date"]
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
    async (input: { date: string; depStation?: string; arrStation?: string }) => {
        const rows = QueryEngine.getFlights(input);
        return JSON.stringify(rows).length > 0 ? JSON.stringify(rows) : JSON.stringify({ result: [] });
    },
    {
        name: "get_flights",
        description: "Looks up flight schedules for a given date.",
        schema: {
            type: "object",
            properties: {
                date: {
                    type: "string",
                    description: "Date in YYYY-MM-DD format"
                },
                depStation: {
                    type: "string",
                    description: "Departure station code (e.g., DEL)"
                },
                arrStation: {
                    type: "string",
                    description: "Arrival station code (e.g., BOM)"
                }
            },
            required: ["date"]
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

const tools = [checkFdpLimitTool, checkDutyLimitTool, simulateImpactTool,
    lookupReservePool, getDutyHours, getFlights, getExpiringCerts, getCrew, getPairing];
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
