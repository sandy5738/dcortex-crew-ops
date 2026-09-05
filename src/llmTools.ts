import { zodToJsonSchema } from 'zod-to-json-schema';
import { Schemas as RuleSchemas } from './rulesEngine';
import { QuerySchemas } from './queryEngine';

/**
 * Dynamically generates the JSON structure for OpenAI Function Calling (Tools).
 * Includes both Tier 1 (Lookups) and Tier 2/3 (Legality Checks).
 */

export const OPENAI_TOOLS = [
    // -------------------------------------------------------------
    // TIER 1: LOOKUPS (Data Retrieval)
    // -------------------------------------------------------------
    {
        type: "function",
        function: {
            name: "getReservePool",
            description: "Looks up which crew members are on reserve/standby for a specific date and base, and returns their on-call windows.",
            parameters: zodToJsonSchema(QuerySchemas.GetReservePool, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "getDutyHours",
            description: "Looks up a crew member's accumulated duty hours and rest times.",
            parameters: zodToJsonSchema(QuerySchemas.GetDutyHours, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "getFlights",
            description: "Looks up flight schedules for a given date. Optionally filter by departure or arrival station.",
            parameters: zodToJsonSchema(QuerySchemas.GetFlights, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "getExpiringCertifications",
            description: "Finds all crew medical/training certifications expiring within a specific date range.",
            parameters: zodToJsonSchema(QuerySchemas.GetExpiringCertifications, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "getCrew",
            description: "Looks up crew member details (rank, base, ratings). You can search by crewId, or find all crew of a certain rank at a certain base.",
            parameters: zodToJsonSchema(QuerySchemas.GetCrew, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "getPairing",
            description: "Looks up the full details of a pairing (the schedule of flights and assigned crew) by pairing ID.",
            parameters: zodToJsonSchema(QuerySchemas.GetPairing, { target: "jsonSchema7" })
        }
    },

    // -------------------------------------------------------------
    // TIER 2 & 3: LEGALITY RULES (Math & Constraints)
    // -------------------------------------------------------------
    {
        type: "function",
        function: {
            name: "checkRuleFdp01",
            description: "Evaluates RULE-FDP-01: Max flight duty period 13h, reduced 0.5h per sector beyond the 2nd.",
            parameters: zodToJsonSchema(RuleSchemas.FDP01, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "checkRuleDuty02",
            description: "Evaluates RULE-DUTY-02: Max 60 duty hours in any 7 consecutive calendar days.",
            parameters: zodToJsonSchema(RuleSchemas.DUTY02, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "checkRuleFlt03",
            description: "Evaluates RULE-FLT-03: Max 100 flight (block) hours in any 28 consecutive days.",
            parameters: zodToJsonSchema(RuleSchemas.FLT03, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "checkRuleRest04",
            description: "Evaluates RULE-REST-04: Min 12h rest between release and next report.",
            parameters: zodToJsonSchema(RuleSchemas.REST04, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "checkRuleQual05",
            description: "Evaluates RULE-QUAL-05: Verifies if a crew member has the valid rating (e.g. A320, ATR72).",
            parameters: zodToJsonSchema(RuleSchemas.QUAL05, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "checkRuleCert06",
            description: "Evaluates RULE-CERT-06: Verifies if a crew member's medical and training certifications are valid on the date of duty.",
            parameters: zodToJsonSchema(RuleSchemas.CERT06, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "checkRuleBase07",
            description: "Evaluates RULE-BASE-07: Checks if a crew member is based at the required departure station.",
            parameters: zodToJsonSchema(RuleSchemas.BASE07, { target: "jsonSchema7" })
        }
    }
];
