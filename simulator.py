import json
from typing import List, Dict, Any
from pathlib import Path

# Load data directly into memory (Since dataset is small, this is perfectly fine for the Hackathon)
# This avoids complex SQLite queries for deeply nested JSON (like pairings).
DATA_DIR = Path("data")

with open(DATA_DIR / "rosters.json", "r") as f:
    ROSTERS = json.load(f)["pairings"]

with open(DATA_DIR / "flights.json", "r") as f:
    FLIGHTS = json.load(f)

def get_flight_details(flight_id: str) -> Dict[str, Any]:
    """Helper to fetch flight details from flights.json"""
    for flight in FLIGHTS:
        if flight["flight_id"] == flight_id:
            return flight
    return None

def simulate_impact(crew_id: str, date: str) -> Dict[str, Any]:
    """
    Tier 2: Consequence & Simulation
    If a crew member calls in sick on a specific date, what is the ripple effect?
    """
    # 1. Find the pairing this crew member is assigned to
    target_pairing = None
    target_role = None
    
    for pairing in ROSTERS:
        for crew in pairing["crew"]:
            if crew["crew_id"] == crew_id:
                target_pairing = pairing
                target_role = crew["role"]
                break
        if target_pairing:
            break
            
    if not target_pairing:
        return {"error": f"Crew member {crew_id} is not assigned to any pairings."}

    # 2. Find the specific day in the pairing
    affected_flights = []
    report_utc = None
    
    for day in target_pairing["days"]:
        if day["date"] == date:
            affected_flights = day["flights"]
            report_utc = day["report_utc"]
            break
            
    if not affected_flights:
        return {"error": f"Crew member {crew_id} is on pairing {target_pairing['pairing_id']}, but has no flights on {date}."}

    # 3. Gather flight details to calculate passenger impact
    uncrewed_flights_details = []
    total_passengers_at_risk = 0
    
    for f_id in affected_flights:
        details = get_flight_details(f_id)
        if details:
            uncrewed_flights_details.append({
                "flight_no": details["flight_no"],
                "dep_station": details["dep_station"],
                "arr_station": details["arr_station"]
            })
            total_passengers_at_risk += details.get("seats", 0)

    # 4. Return the structured "Ripple Effect"
    return {
        "disruption": f"{target_role} {crew_id} is unavailable on {date}.",
        "pairing_broken": target_pairing["pairing_id"],
        "uncrewed_flights": uncrewed_flights_details,
        "passengers_affected": total_passengers_at_risk,
        "action_required": f"A replacement {target_role} must be found before {report_utc}."
    }

if __name__ == "__main__":
    # Test Scenario: What happens if C-5837 calls in sick on Sept 14th?
    print("Simulating disruption for C-5837 on 2026-09-14...\n")
    impact = simulate_impact(crew_id="C-5837", date="2026-09-14")
    print(json.dumps(impact, indent=2))
