import sqlite3
from datetime import datetime, date
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from langchain_core.tools import tool


# ==========================================
# 1. DETERMINISTIC RULES ENGINE & EXCEPTIONS
# ==========================================

class RuleViolation(Exception):
    def __init__(self, rule_id: str, detail: str):
        self.rule_id = rule_id
        self.detail = detail
        super().__init__(f"{rule_id}: {detail}")


class RulesEngine:
    @staticmethod
    def evaluate_all(crew_data: dict, flight_data: dict) -> None:
        # RULE-QUAL-05: Rating check[cite: 2]
        if flight_data["aircraft_type"] not in crew_data["ratings"]:
            raise RuleViolation(
                "RULE-QUAL-05",
                f"Crew member {crew_data['crew_id']} is not rated for {flight_data['aircraft_type']}. Ratings: {crew_data['ratings']}"
            )

        # RULE-DUTY-02: 60h/7d duty limit[cite: 2]
        projected_duty = crew_data["duty_hours_7d"] + (flight_data["block_time_minutes"] / 60.0)
        if projected_duty > 60.0:
            raise RuleViolation(
                "RULE-DUTY-02",
                f"Projected duty {projected_duty:.2f}h exceeds 60h/7d limit by {projected_duty - 60.0:.2f}h."
            )

        # RULE-FLT-03: 100h/28d flight time limit[cite: 2]
        projected_flight = crew_data["flight_hours_28d"] + (flight_data["block_time_minutes"] / 60.0)
        if projected_flight > 100.0:
            raise RuleViolation(
                "RULE-FLT-03",
                f"Projected flight time {projected_flight:.2f}h exceeds 100h/28d limit by {projected_flight - 100.0:.2f}h."
            )

        # RULE-REST-04: 12h rest minimum[cite: 2]
        last_rest = datetime.fromisoformat(crew_data["last_rest_ended"])
        scheduled_dep = datetime.fromisoformat(flight_data["scheduled_departure"])
        rest_hours = (scheduled_dep - last_rest).total_seconds() / 3600.0
        if rest_hours < 12.0:
            raise RuleViolation(
                "RULE-REST-04",
                f"Rest period before departure is only {rest_hours:.2f}h (minimum required is 12.0h)."
            )


# ==========================================
# 2. HELPER DATABASE CONNECTION ROUTE
# ==========================================

DB_PATH = "crew_ops.db"

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


# ==========================================
# 3. LANGGRAPH TOOLS FOR SIMULATION
# ==========================================

@tool
def check_crew_status(crew_id: str) -> Dict[str, Any]:
    """
    Retrieves the complete profile, duty clocks, and ratings for a given crew member[cite: 2].
    Use this tool to inspect a crew member's current workload and qualifications[cite: 2].
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM CrewMember WHERE crew_id = ?", (crew_id,))
    crew = cursor.fetchone()
    if not crew:
        return {"error": f"Crew member {crew_id} not found."}

    cursor.execute("SELECT * FROM DutyClock WHERE crew_id = ?", (crew_id,))
    clock = cursor.fetchone()

    cursor.execute("SELECT aircraft_type FROM CrewAircraftRating WHERE crew_id = ?", (crew_id,))
    ratings = [row["aircraft_type"] for row in cursor.fetchall()]

    conn.close()
    return {
        "crew_id": crew["crew_id"],
        "name": crew["name"],
        "rank": crew["rank"],
        "base": crew["base"],
        "reachability_minutes": crew["reachability_minutes"],
        "duty_hours_7d": clock["duty_hours_7d"] if clock else 0.0,
        "flight_hours_28d": clock["flight_hours_28d"] if clock else 0.0,
        "last_rest_ended": clock["last_rest_ended"] if clock else None,
        "ratings": ratings
    }


@tool
def simulate_crew_disruption(sick_crew_id: str, date_str: str) -> Dict[str, Any]:
    """
    Simulates a crew sick-call or disruption event[cite: 2].
    Identifies uncrewed flights, broken pairings, and downstream flight risks[cite: 2].
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    # Find all assignments for this crew member on the target date
    cursor.execute("""
        SELECT a.assignment_id, a.pairing_id, a.flight_id, f.departure_station, f.arrival_station, f.scheduled_departure
        FROM CrewFlightAssignment a
        JOIN Flight f ON a.flight_id = f.flight_id
        WHERE a.crew_id = ? AND date(f.scheduled_departure) = date(?) AND a.status = 'SCHEDULED'
    """, (sick_crew_id, date_str))
    
    assigned_rows = cursor.fetchall()
    if not assigned_rows:
        conn.close()
        return {"status": "NO_IMPACT", "message": f"No active flights found for {sick_crew_id} on {date_str}."}

    uncrewed_flights = [row["flight_id"] for row in assigned_rows]
    broken_pairings = list(set([row["pairing_id"] for row in assigned_rows]))

    conn.close()
    return {
        "disruption_event": "SICK_CALL",
        "affected_crew_id": sick_crew_id,
        "date": date_str,
        "uncrewed_flights": uncrewed_flights,
        "broken_pairings": broken_pairings,
        "impact_summary": f"Disruption creates {len(uncrewed_flights)} uncrewed flights across pairings {broken_pairings}."
    }


@tool
def search_reserve_candidates(station: str, aircraft_type: str) -> Dict[str, Any]:
    """
    Queries the reserve pool for available, qualified crew members at a specific station[cite: 2].
    Evaluates reachability and aircraft rating compatibility[cite: 2].
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT c.crew_id, c.name, c.rank, c.base, c.reachability_minutes, r.standby_status
        FROM ReservePool r
        JOIN CrewMember c ON r.crew_id = c.crew_id
        JOIN CrewAircraftRating ar ON c.crew_id = ar.crew_id
        WHERE r.station = ? AND ar.aircraft_type = ? AND r.standby_status = 'AVAILABLE'
    """, (station, aircraft_type))

    candidates = []
    for row in cursor.fetchall():
        candidates.append({
            "crew_id": row["crew_id"],
            "name": row["name"],
            "rank": row["rank"],
            "base": row["base"],
            "reachability_minutes": row["reachability_minutes"],
            "standby_status": row["standby_status"]
        })

    conn.close()
    return {
        "station": station,
        "aircraft_type": aircraft_type,
        "available_candidates_count": len(candidates),
        "candidates": candidates
    }


@tool
def attempt_reassignment_mutation(crew_id: str, flight_id: str) -> Dict[str, Any]:
    """
    Attempts to mutate the schedule by reassigning a flight to a candidate crew member[cite: 2].
    Executes inside an atomic database transaction and evaluates all deterministic rules[cite: 2].
    Returns success or a structured rule violation error payload[cite: 2].
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute("BEGIN TRANSACTION;")

        # Fetch Flight Details
        cursor.execute("SELECT * FROM Flight WHERE flight_id = ?", (flight_id,))
        flight = cursor.fetchone()
        if not flight:
            cursor.execute("ROLLBACK;")
            return {"status": "ERROR", "detail": f"Flight {flight_id} not found."}

        flight_dict = dict(flight)

        # Fetch Crew Details
        cursor.execute("SELECT * FROM CrewMember WHERE crew_id = ?", (crew_id,))
        crew = cursor.fetchone()
        if not crew:
            cursor.execute("ROLLBACK;")
            return {"status": "ERROR", "detail": f"Crew {crew_id} not found."}

        cursor.execute("SELECT * FROM DutyClock WHERE crew_id = ?", (crew_id,))
        clock = cursor.fetchone()

        cursor.execute("SELECT aircraft_type FROM CrewAircraftRating WHERE crew_id = ?", (crew_id,))
        ratings = [r["aircraft_type"] for r in cursor.fetchall()]

        crew_dict = dict(crew)
        crew_dict["duty_hours_7d"] = clock["duty_hours_7d"] if clock else 0.0
        crew_dict["flight_hours_28d"] = clock["flight_hours_28d"] if clock else 0.0
        crew_dict["last_rest_ended"] = clock["last_rest_ended"] if clock else "2000-01-01T00:00:00"
        crew_dict["ratings"] = ratings

        # RUN DETERMINISTIC RULES ENGINE
        RulesEngine.evaluate_all(crew_dict, flight_dict)

        # Apply Base Location Deadhead Penalty logic (RULE-BASE-07)[cite: 2]
        cost_inr = 15000  # Base callout rate
        deadhead_applied = False
        if crew_dict["base"] != flight_dict["departure_station"]:
            cost_inr += 25000  # Deadhead penalty rate[cite: 2]
            deadhead_applied = True

        # COMMIT MUTATION TO DATABASE
        cursor.execute("""
            INSERT INTO CrewFlightAssignment (assignment_id, pairing_id, crew_id, flight_id, status)
            VALUES (?, ?, ?, ?, ?)
        """, (f"A-{crew_id}-{flight_id}", "RECOVERY-P", crew_id, flight_id, "SCHEDULED"))

        conn.commit()
        conn.close()

        return {
            "status": "SUCCESS",
            "legal": True,
            "reassigned_crew_id": crew_id,
            "flight_id": flight_id,
            "cost_inr": cost_inr,
            "deadhead_applied": deadhead_applied,
            "rules_checked": ["RULE-QUAL-05", "RULE-DUTY-02", "RULE-FLT-03", "RULE-REST-04", "RULE-BASE-07"]
        }

    except RuleViolation as rv:
        cursor.execute("ROLLBACK;")
        conn.close()
        
        # STRUCTURED ERROR PAYLOAD TO DRIVE AGENT SELF-CORRECTION
        return {
            "status": "RULE_VIOLATION",
            "legal": False,
            "violation_code": rv.rule_id,
            "detail": rv.detail,
            "action_required": "Select an alternative reserve crew member who satisfies this rule constraint."
        }
    except Exception as e:
        cursor.execute("ROLLBACK;")
        conn.close()
        return {"status": "SYSTEM_ERROR", "detail": str(e)}


# List of all tools ready to bind to LangGraph Agent Nodes
CREW_OPS_SIMULATION_TOOLS = [
    check_crew_status,
    simulate_crew_disruption,
    search_reserve_candidates,
    attempt_reassignment_mutation
]