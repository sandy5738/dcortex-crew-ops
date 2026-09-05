from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import List, Dict, Any
import rules_engine
import simulator

app = FastAPI(title="Crew Ops Advisor API")

# =================================================================
# 1. PYDANTIC SCHEMAS (These become your LLM "Tools")
# =================================================================

class FDPCheckRequest(BaseModel):
    num_sectors: int = Field(..., description="The number of flight legs (sectors) the crew member will fly.")
    proposed_fdp_hours: float = Field(..., description="The total proposed flight duty period in hours.")

class DutyCheckRequest(BaseModel):
    crew_id: str = Field(..., description="The ID of the crew member, e.g., 'C-1042'")
    new_duty_hours: float = Field(..., description="The length of the new duty being assigned in hours.")

class ImpactSimulationRequest(BaseModel):
    crew_id: str = Field(..., description="The ID of the crew member who is disrupted.")
    date: str = Field(..., description="The date of the disruption in YYYY-MM-DD format.")

# =================================================================
# 2. FASTAPI ROUTES (The Deterministic Boundary)
# =================================================================

@app.post("/tools/check_fdp_limit", summary="Rule FDP-01: Check Flight Duty Limits")
async def tool_check_fdp(req: FDPCheckRequest):
    """LLM calls this tool to do exact math for Duty Period limits."""
    result = rules_engine.check_rule_fdp_01(req.num_sectors, req.proposed_fdp_hours)
    return result

@app.post("/tools/check_7d_duty_limit", summary="Rule DUTY-02: Check 7-Day limits")
async def tool_check_duty(req: DutyCheckRequest):
    """LLM calls this tool to check if adding a flight breaches the 60h/7d limit."""
    result = rules_engine.check_rule_duty_02(req.crew_id, req.new_duty_hours)
    return result

@app.post("/tools/simulate_impact", summary="Tier 2: Simulate Disruption Impact")
async def tool_simulate_impact(req: ImpactSimulationRequest):
    """LLM calls this tool when a crew member is sick to find the 'Ripple Effect'."""
    result = simulator.simulate_impact(req.crew_id, req.date)
    return result


# =================================================================
# 3. MOCK CHAT ENDPOINT (Where the LLM orchestration lives)
# =================================================================
class ChatRequest(BaseModel):
    message: str

@app.post("/chat")
async def chat(req: ChatRequest):
    """
    In a real implementation, you would pass `req.message` to OpenAI here,
    along with the JSON schemas of the /tools endpoints above.
    OpenAI would decide which tool to call, and you would execute it.
    """
    
    # Mocking a response for the Hackathon Demo
    if "sick" in req.message.lower() and "C-5837" in req.message:
        
        # 1. The LLM decided to call the simulator tool behind the scenes:
        tool_result = simulator.simulate_impact("C-5837", "2026-09-14")
        
        # 2. The LLM synthesized the tool result into this answer:
        answer = f"Captain C-5837 is sick. This breaks Pairing {tool_result['pairing_broken']}. " \
                 f"As a result, {len(tool_result['uncrewed_flights'])} flights are now uncrewed, " \
                 f"putting {tool_result['passengers_affected']} passengers at risk. " \
                 f"{tool_result['action_required']}"
                 
        return {
            "answer": answer,
            "reasoning_trail": [
                {
                    "tool_called": "simulate_impact",
                    "arguments": {"crew_id": "C-5837", "date": "2026-09-14"},
                    "raw_result": tool_result
                }
            ]
        }
    
    return {"answer": "I am a prototype. Ask me about C-5837 getting sick!"}
