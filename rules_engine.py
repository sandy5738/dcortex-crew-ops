import sqlite3
import json
from typing import Dict, Any
from datetime import datetime, timedelta

# Connect to the SQLite DB
DB_PATH = "airline.db"

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# ---------------------------------------------------------
# RULE-FDP-01: Flight Duty Period limits
# ---------------------------------------------------------
def check_rule_fdp_01(num_sectors: int, proposed_fdp_hours: float) -> Dict[str, Any]:
    base_fdp = 13.0
    reduction = 0.5
    free_sectors = 2
    penalty_sectors = max(0, num_sectors - free_sectors)
    max_allowed_fdp = base_fdp - (penalty_sectors * reduction)
    is_legal = proposed_fdp_hours <= max_allowed_fdp
    
    return {
        "rule_id": "RULE-FDP-01",
        "legal": is_legal,
        "reason": f"Legal. {proposed_fdp_hours}h <= {max_allowed_fdp}h" if is_legal else f"Violation. {proposed_fdp_hours}h > {max_allowed_fdp}h limit for {num_sectors} sectors."
    }

# ---------------------------------------------------------
# RULE-DUTY-02: 7-Day Cumulative Duty Limits
# ---------------------------------------------------------
def check_rule_duty_02(crew_id: str, new_duty_hours: float) -> Dict[str, Any]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT duty_hours_7d FROM duty_clocks WHERE crew_id = ?", (crew_id,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        return {"rule_id": "RULE-DUTY-02", "legal": False, "reason": "Crew member not found."}

    current = row["duty_hours_7d"]
    projected = current + new_duty_hours
    is_legal = projected <= 60.0
    
    return {
        "rule_id": "RULE-DUTY-02", "legal": is_legal,
        "reason": f"Legal. {current}h + {new_duty_hours}h = {projected}h (Limit: 60h)" if is_legal else f"Violation. Projected {projected}h exceeds 60h/7d limit."
    }

# ---------------------------------------------------------
# RULE-FLT-03: 28-Day Cumulative Flight Hours Limit
# ---------------------------------------------------------
def check_rule_flt_03(crew_id: str, new_flight_hours: float) -> Dict[str, Any]:
    """Max 100 flight (block) hours in any 28 consecutive calendar days."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT flight_hours_28d FROM duty_clocks WHERE crew_id = ?", (crew_id,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        return {"rule_id": "RULE-FLT-03", "legal": False, "reason": "Crew member not found."}

    current = row["flight_hours_28d"]
    projected = current + new_flight_hours
    is_legal = projected <= 100.0
    
    return {
        "rule_id": "RULE-FLT-03", "legal": is_legal,
        "reason": f"Legal. {current}h + {new_flight_hours}h = {projected}h (Limit: 100h)" if is_legal else f"Violation. Projected {projected}h exceeds 100h/28d limit."
    }

# ---------------------------------------------------------
# RULE-REST-04: Min 12h rest between release and report
# ---------------------------------------------------------
def check_rule_rest_04(crew_id: str, new_report_utc: str) -> Dict[str, Any]:
    """Min 12h rest between release and next report."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT last_rest_ended FROM duty_clocks WHERE crew_id = ?", (crew_id,))
    row = cursor.fetchone()
    conn.close()

    if not row or not row["last_rest_ended"]:
        return {"rule_id": "RULE-REST-04", "legal": True, "reason": "No previous rest constraint found, legal by default."}

    # last_rest_ended is already (release_time + 12 hours) from the dataset generator.
    # So the new report must be AFTER last_rest_ended.
    last_rest = datetime.strptime(row["last_rest_ended"], "%Y-%m-%dT%H:%M:%SZ")
    new_report = datetime.strptime(new_report_utc, "%Y-%m-%dT%H:%M:%SZ")
    
    is_legal = new_report >= last_rest
    return {
        "rule_id": "RULE-REST-04", "legal": is_legal,
        "reason": "Legal. Adequate rest achieved." if is_legal else f"Violation. Crew cannot report before {last_rest}Z."
    }

# ---------------------------------------------------------
# RULE-QUAL-05: Aircraft Rating Validation
# ---------------------------------------------------------
def check_rule_qual_05(crew_id: str, target_aircraft_type: str) -> Dict[str, Any]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT ratings FROM crew WHERE crew_id = ?", (crew_id,))
    row = cursor.fetchone()
    conn.close()

    if not row:
         return {"rule_id": "RULE-QUAL-05", "legal": False, "reason": "Crew member not found."}

    ratings_list = json.loads(row["ratings"])
    is_legal = target_aircraft_type in ratings_list
    
    return {
        "rule_id": "RULE-QUAL-05", "legal": is_legal,
        "reason": f"Legal. Rated for {target_aircraft_type}." if is_legal else f"Violation. Crew is not rated for {target_aircraft_type}."
    }

# ---------------------------------------------------------
# RULE-CERT-06: Certification Validity
# ---------------------------------------------------------
def check_rule_cert_06(crew_id: str, duty_date: str) -> Dict[str, Any]:
    """All certifications must be valid on the duty date."""
    # Since we didn't put certs in SQLite, we will read the JSON directly
    with open("data/certifications.json", "r") as f:
        certs = json.load(f)
        
    for cert in certs:
        if cert["crew_id"] == crew_id:
            # Check if duty_date is past the valid_to date
            if duty_date > cert["valid_to"]:
                return {
                    "rule_id": "RULE-CERT-06",
                    "legal": False,
                    "reason": f"Violation. {cert['cert_type']} expired on {cert['valid_to']}."
                }
                
    return {"rule_id": "RULE-CERT-06", "legal": True, "reason": "Legal. All certifications valid."}

# ---------------------------------------------------------
# RULE-BASE-07: Reserve callout from base
# ---------------------------------------------------------
def check_rule_base_07(crew_id: str, required_departure_station: str) -> Dict[str, Any]:
    """Covering from another base requires deadhead positioning (cost applies)."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT base FROM crew WHERE crew_id = ?", (crew_id,))
    row = cursor.fetchone()
    conn.close()
    
    base = row["base"]
    if base == required_departure_station:
        return {"rule_id": "RULE-BASE-07", "legal": True, "cost_incurred": False, "reason": f"Legal. Crew is at base {base}."}
    else:
        return {
            "rule_id": "RULE-BASE-07", 
            "legal": True, # It is technically legal, but costs money
            "cost_incurred": True, 
            "reason": f"Legal but expensive. Crew is based at {base}. Deadhead positioning to {required_departure_station} required."
        }
