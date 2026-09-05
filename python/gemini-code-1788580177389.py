import json
from datetime import datetime
from typing import Dict, List, Optional, TypedDict
from pydantic import BaseModel, Field
from langgraph.graph import StateGraph, START, END


# ==========================================
# 1. PYDANTIC ENTITY MODELS
# ==========================================

class CrewMember(BaseModel):
    crew_id: str
    name: str
    rank: str
    base: str
    ratings: List[str]
    seniority: int
    reachability_minutes: int


class DutyClock(BaseModel):
    crew_id: str
    duty_hours_7d: float
    flight_hours_28d: float
    last_rest_ended: datetime


class Flight(BaseModel):
    flight_id: str
    departure_station: str
    arrival_station: str
    scheduled_departure: datetime
    scheduled_arrival: datetime
    block_time_minutes: int
    aircraft_type: str


class LegalityRule(BaseModel):
    rule_id: str
    constraint_type: str
    threshold_value: Optional[float] = None
    description: str


# ==========================================
# 2. DATA STORE & JSON CONVERTER
# ==========================================

class DataStore:
    """In-memory strongly typed database loaded directly from JSON."""
    def __init__(self):
        self.crew: Dict[str, CrewMember] = {}
        self.clocks: Dict[str, DutyClock] = {}
        self.flights: Dict[str, Flight] = {}
        self.rules: Dict[str, LegalityRule] = {}

    def load_from_raw_json(
        self,
        crew_raw: list,
        clocks_raw: list,
        flights_raw: list,
        rules_raw: list
    ):
        # Convert JSON objects directly to Pydantic Model instances
        for c in crew_raw:
            obj = CrewMember(**c)
            self.crew[obj.crew_id] = obj

        for cl in clocks_raw:
            obj = DutyClock(**cl)
            self.clocks[obj.crew_id] = obj

        for f in flights_raw:
            obj = Flight(**f)
            self.flights[obj.flight_id] = obj

        for r in rules_raw:
            obj = LegalityRule(**r)
            self.rules[obj.rule_id] = obj


# ==========================================
# 3. LANGGRAPH STATE DEFINITION
# ==========================================

class GraphState(TypedDict):
    query: str
    store: DataStore
    target_crew_id: Optional[str]
    target_flight_id: Optional[str]
    retrieved_crew: Optional[CrewMember]
    retrieved_clock: Optional[DutyClock]
    retrieved_flight: Optional[Flight]
    rule_violations: List[str]
    final_response: str


# ==========================================
# 4. LANGGRAPH NODES
# ==========================================

def retrieve_entities_node(state: GraphState) -> Dict:
    """Parses query entities and fetches Pydantic models from DataStore."""
    store = state["store"]
    query = state["query"]
    
    target_crew_id = None
    target_flight_id = None
    
    # Primitive entity extraction logic (replace with LLM structured output in production)
    for c_id in store.crew.keys():
        if c_id in query:
            target_crew_id = c_id
            break

    for f_id in store.flights.keys():
        if f_id in query:
            target_flight_id = f_id
            break

    return {
        "target_crew_id": target_crew_id,
        "target_flight_id": target_flight_id,
        "retrieved_crew": store.crew.get(target_crew_id) if target_crew_id else None,
        "retrieved_clock": store.clocks.get(target_crew_id) if target_crew_id else None,
        "retrieved_flight": store.flights.get(target_flight_id) if target_flight_id else None,
    }


def deterministic_rule_validator_node(state: GraphState) -> Dict:
    """Evaluates regulatory rules deterministically using Python arithmetic."""
    clock = state["retrieved_clock"]
    flight = state["retrieved_flight"]
    violations = []

    if clock and flight:
        # RULE-DUTY-02: 60 duty hours in 7 days cap
        projected_duty = clock.duty_hours_7d + (flight.block_time_minutes / 60.0)
        if projected_duty > 60.0:
            excess = round(projected_duty - 60.0, 2)
            violations.append(
                f"RULE-DUTY-02: Projecting {projected_duty}h exceeds 60h/7d limit by {excess}h"
            )

        # RULE-FLT-03: 100 flight hours in 28 days cap
        projected_flight = clock.flight_hours_28d + (flight.block_time_minutes / 60.0)
        if projected_flight > 100.0:
            excess = round(projected_flight - 100.0, 2)
            violations.append(
                f"RULE-FLT-03: Projecting {projected_flight}h exceeds 100h/28d limit by {excess}h"
            )

    return {"rule_violations": violations}


def synthesize_response_node(state: GraphState) -> Dict:
    """Generates human-readable, explainable response grounded in model data."""
    crew = state["retrieved_crew"]
    clock = state["retrieved_clock"]
    flight = state["retrieved_flight"]
    violations = state["rule_violations"]
    query = state["query"]

    # Handlers for specific query intents
    if "duty hours" in query.lower() and clock:
        remaining_7d = round(60.0 - clock.duty_hours_7d, 2)
        ans = (
            f"Crew Member {clock.crew_id} ({crew.name if crew else 'Unknown'}) "
            f"has logged {clock.duty_hours_7d} duty hours in the last 7 days. "
            f"Remaining duty capacity: {remaining_7d} hours."
        )
    elif flight and clock:
        if violations:
            ans = (
                f"Assignment REJECTED for {clock.crew_id} on Flight {flight.flight_id}.\n"
                f"Violations Detected:\n - " + "\n - ".join(violations)
            )
        else:
            ans = f"Assignment VALID for {clock.crew_id} on Flight {flight.flight_id}. All regulatory checks passed."
    else:
        ans = "Query processed. No actionable entities or rule breaches found."

    return {"final_response": ans}


# ==========================================
# 5. GRAPH COMPOSITION & EXECUTION
# ==========================================

def build_crew_ops_graph():
    builder = StateGraph(GraphState)

    # Add Nodes
    builder.add_node("retrieve", retrieve_entities_node)
    builder.add_node("validate", deterministic_rule_validator_node)
    builder.add_node("synthesize", synthesize_response_node)

    # Wire Edges
    builder.add_edge(START, "retrieve")
    builder.add_edge("retrieve", "validate")
    builder.add_edge("validate", "synthesize")
    builder.add_edge("synthesize", END)

    return builder.compile()


# ==========================================
# 6. TEST SUITE & DATA DEMO
# ==========================================

if __name__ == "__main__":
    # Sample Mock JSON Datasets matching standard formats
    sample_crew_json = [
        {"crew_id": "C-1042", "name": "A. Nair", "rank": "Captain", "base": "BLR", "ratings": ["A320"], "seniority": 14, "reachability_minutes": 90}
    ]
    sample_clocks_json = [
        {"crew_id": "C-1042", "duty_hours_7d": 58.5, "flight_hours_28d": 82.0, "last_rest_ended": "2026-09-14T22:00:00Z"}
    ]
    sample_flights_json = [
        {"flight_id": "DX412", "departure_station": "BLR", "arrival_station": "DEL", "scheduled_departure": "2026-09-15T06:00:00Z", "scheduled_arrival": "2026-09-15T08:30:00Z", "block_time_minutes": 150, "aircraft_type": "A320"}
    ]
    sample_rules_json = [
        {"rule_id": "RULE-DUTY-02", "constraint_type": "HARD", "threshold_value": 60.0, "description": "Max 60 duty hours in 7 days"}
    ]

    # Convert JSON to Pydantic models within DataStore
    db = DataStore()
    db.load_from_raw_json(sample_crew_json, sample_clocks_json, sample_flights_json, sample_rules_json)

    app = build_crew_ops_graph()

    print("--- Test Case 1: Tier 1 Lookup ---")
    result_1 = app.invoke({
        "query": "How many duty hours does C-1042 have left this week?",
        "store": db,
        "target_crew_id": None,
        "target_flight_id": None,
        "retrieved_crew": None,
        "retrieved_clock": None,
        "retrieved_flight": None,
        "rule_violations": [],
        "final_response": ""
    })
    print("Response:", result_1["final_response"])

    print("\n--- Test Case 2: Tier 2 Simulation Check (Rule Breach) ---")
    result_2 = app.invoke({
        "query": "If I assign C-1042 to flight DX412, does anyone breach a duty limit?",
        "store": db,
        "target_crew_id": None,
        "target_flight_id": None,
        "retrieved_crew": None,
        "retrieved_clock": None,
        "retrieved_flight": None,
        "rule_violations": [],
        "final_response": ""
    })
    print("Response:", result_2["final_response"])