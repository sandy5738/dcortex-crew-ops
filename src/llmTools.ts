import { zodToJsonSchema } from 'zod-to-json-schema';
import { Schemas } from './rulesEngine';

/**
 * This file dynamically generates the exact JSON structure that OpenAI (or Gemini)
 * requires for "Function Calling" (Tools) directly from your Zod schemas.
 * 
 * Tomorrow, when you initialize the OpenAI SDK, you can literally just pass 
 * `OPENAI_TOOLS` directly into the `tools` array of the chat completions request!
 */

export const OPENAI_TOOLS = [
    {
        type: "function",
        function: {
            name: "checkRuleFdp01",
            description: "Evaluates RULE-FDP-01: Max flight duty period 13h, reduced 0.5h per sector beyond the 2nd. Use this when the controller asks if a specific duty length is legal for a certain number of flights.",
            parameters: zodToJsonSchema(Schemas.FDP01, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "checkRuleDuty02",
            description: "Evaluates RULE-DUTY-02: Max 60 duty hours in any 7 consecutive calendar days. Use this to check if adding new duty hours to a specific crew member will breach their weekly limit.",
            parameters: zodToJsonSchema(Schemas.DUTY02, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "checkRuleFlt03",
            description: "Evaluates RULE-FLT-03: Max 100 flight (block) hours in any 28 consecutive days.",
            parameters: zodToJsonSchema(Schemas.FLT03, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "checkRuleRest04",
            description: "Evaluates RULE-REST-04: Min 12h rest between release and next report. Check if a crew member has had enough rest before their next report time.",
            parameters: zodToJsonSchema(Schemas.REST04, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "checkRuleQual05",
            description: "Evaluates RULE-QUAL-05: Verifies if a crew member has the valid rating (e.g. A320, ATR72) for the assigned aircraft type.",
            parameters: zodToJsonSchema(Schemas.QUAL05, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "checkRuleCert06",
            description: "Evaluates RULE-CERT-06: Verifies if a crew member's medical and training certifications are valid on the date of duty.",
            parameters: zodToJsonSchema(Schemas.CERT06, { target: "jsonSchema7" })
        }
    },
    {
        type: "function",
        function: {
            name: "checkRuleBase07",
            description: "Evaluates RULE-BASE-07: Checks if a crew member is based at the required departure station. Identifies if deadhead positioning is required.",
            parameters: zodToJsonSchema(Schemas.BASE07, { target: "jsonSchema7" })
        }
    }
];

// If you want to run this file directly to see what the OpenAI schema looks like:
if (require.main === module) {
    console.log(JSON.stringify(OPENAI_TOOLS[0], null, 2));
}
