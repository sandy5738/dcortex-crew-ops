def reassign_crew_to_flight(conn, crew_id: str, flight_id: str) -> dict:
    """
    Tool called by the LLM. Simulates assigning a crew member to a flight.
    Evaluates hard rules. Returns success payload or formatted error payload.
    """
    cursor = conn.cursor()
    
    try:
        # Start Atomic Transaction
        cursor.execute("BEGIN TRANSACTION;")

        # 1. Fetch Flight Details
        cursor.execute("SELECT block_time_minutes, aircraft_type FROM Flight WHERE flight_id = ?", (flight_id,))
        flight = cursor.fetchone()
        if not flight:
            raise ValueError(f"Flight {flight_id} not found.")
        block_time_minutes, aircraft_type = flight

        # 2. Fetch Crew State & Clocks
        cursor.execute("""
            SELECT c.crew_id, d.duty_hours_7d, d.flight_hours_28d 
            FROM CrewMember c
            JOIN DutyClock d ON c.crew_id = d.crew_id
            WHERE c.crew_id = ?
        """, (crew_id,))
        crew_state = cursor.fetchone()
        if not crew_state:
            raise ValueError(f"Crew {crew_id} not found.")
        _, current_duty_7d, current_flight_28d = crew_state

        # ==========================================
        # DETERMINISTIC RULE EVALUATION
        # ==========================================

        # RULE-QUAL-05: Must hold valid rating for aircraft[cite: 2]
        cursor.execute("SELECT 1 FROM CrewAircraftRating WHERE crew_id = ? AND aircraft_type = ?", (crew_id, aircraft_type))
        if not cursor.fetchone():
            cursor.execute("ROLLBACK;")
            return {
                "status": "error",
                "violation": "RULE-QUAL-05",
                "detail": f"Crew {crew_id} is not rated for {aircraft_type}."
            }

        # RULE-DUTY-02: Max 60 duty hours in 7 days[cite: 2]
        projected_duty = current_duty_7d + (block_time_minutes / 60.0)
        if projected_duty > 60.0:
            cursor.execute("ROLLBACK;")
            # To aid the LLM, fetch a valid alternative crew member at the same base
            cursor.execute("SELECT crew_id FROM CrewMember LIMIT 1") # simplified hint logic
            alt_crew = cursor.fetchone()[0]
            
            return {
                "status": "error",
                "violation": "RULE-DUTY-02",
                "detail": f"Projected duty {projected_duty:.2f}h exceeds 60h limit.",
                "hint": f"Try available reserve: {alt_crew}"
            }

        # ==========================================
        # COMMIT MUTATION IF VALID
        # ==========================================
        
        # In a full implementation, this generates UUIDs and calculates pairing start/end times
        cursor.execute("""
            INSERT INTO CrewFlightAssignment (assignment_id, pairing_id, crew_id, flight_id, status)
            VALUES (?, ?, ?, ?, ?)
        """, (f"A-{crew_id}-{flight_id}", f"P-RECOV", crew_id, flight_id, "SCHEDULED"))

        conn.commit()
        return {
            "status": "success",
            "legal": True,
            "rules_checked": ["RULE-QUAL-05", "RULE-DUTY-02"],
            "cost_inr": 18500, # Mock cost logic based on rules.json/costs.json[cite: 2]
            "message": f"Successfully assigned {crew_id} to {flight_id}."
        }

    except Exception as e:
        cursor.execute("ROLLBACK;")
        return {"status": "system_error", "detail": str(e)}