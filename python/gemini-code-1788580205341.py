from datetime import datetime, timedelta
from typing import List, Optional

class RuleViolation(Exception):
    """Custom exception raised when a legality rule fails."""
    def __init__(self, rule_id: str, detail: str):
        self.rule_id = rule_id
        self.detail = detail
        super().__init__(f"{rule_id}: {detail}")


class RulesEngine:
    """
    Evaluates proposed operational changes against strict regulatory limits.
    """

    @staticmethod
    def evaluate_rule_fdp_01(
        scheduled_duty_start: datetime, 
        scheduled_duty_end: datetime, 
        sectors_flown: int
    ) -> None:
        """
        RULE-FDP-01: Maximum flight duty period of 13 hours, reduced by sectors flown[cite: 2].
        Assume standard reduction: 30 minutes (0.5 hours) reduction for every sector beyond 1.
        """
        base_fdp_limit_hours = 13.0
        sector_reduction = max(0, (sectors_flown - 1)) * 0.5
        adjusted_limit = base_fdp_limit_hours - sector_reduction
        
        projected_fdp = (scheduled_duty_end - scheduled_duty_start).total_seconds() / 3600.0

        if projected_fdp > adjusted_limit:
            raise RuleViolation(
                rule_id="RULE-FDP-01",
                detail=f"Projected FDP {projected_fdp:.2f}h exceeds limit of {adjusted_limit:.2f}h (adjusted for {sectors_flown} sectors)."
            )

    @staticmethod
    def evaluate_rule_duty_02(
        current_duty_hours_7d: float, 
        projected_duty_hours: float
    ) -> None:
        """
        RULE-DUTY-02: Maximum 60 duty hours in any 7 consecutive days[cite: 2].
        """
        total_duty = current_duty_hours_7d + projected_duty_hours
        if total_duty > 60.0:
            excess = total_duty - 60.0
            raise RuleViolation(
                rule_id="RULE-DUTY-02",
                detail=f"Would exceed 60h/7d limit by {excess:.2f} hours. Total projected: {total_duty:.2f}h."
            )

    @staticmethod
    def evaluate_rule_flt_03(
        current_flight_hours_28d: float, 
        projected_flight_hours: float
    ) -> None:
        """
        RULE-FLT-03: Maximum 100 flight hours in any 28 consecutive days[cite: 2].
        """
        total_flight = current_flight_hours_28d + projected_flight_hours
        if total_flight > 100.0:
            excess = total_flight - 100.0
            raise RuleViolation(
                rule_id="RULE-FLT-03",
                detail=f"Would exceed 100h/28d limit by {excess:.2f} hours. Total projected: {total_flight:.2f}h."
            )

    @staticmethod
    def evaluate_rule_rest_04(
        last_rest_ended: datetime, 
        next_duty_start: datetime
    ) -> None:
        """
        RULE-REST-04: Minimum 12 hours rest before commencing duty[cite: 2].
        """
        rest_duration = (next_duty_start - last_rest_ended).total_seconds() / 3600.0
        if rest_duration < 12.0:
            raise RuleViolation(
                rule_id="RULE-REST-04",
                detail=f"Rest period is {rest_duration:.2f}h; minimum required is 12.0h."
            )

    @staticmethod
    def evaluate_rule_qual_05(
        crew_ratings: List[str], 
        aircraft_type: str
    ) -> None:
        """
        RULE-QUAL-05: Crew must hold a valid rating for the assigned aircraft type[cite: 2].
        """
        if aircraft_type not in crew_ratings:
            raise RuleViolation(
                rule_id="RULE-QUAL-05",
                detail=f"Crew lacks required rating. Needs '{aircraft_type}', holds {crew_ratings}."
            )

    @staticmethod
    def evaluate_rule_cert_06(
        duty_date: datetime.date, 
        licence_expiry: datetime.date, 
        medical_expiry: datetime.date, 
        training_expiry: datetime.date
    ) -> None:
        """
        RULE-CERT-06: All certifications must be valid on the duty date[cite: 2].
        """
        earliest_expiry = min(licence_expiry, medical_expiry, training_expiry)
        if duty_date >= earliest_expiry:
            raise RuleViolation(
                rule_id="RULE-CERT-06",
                detail=f"Certification expiration conflict. Earliest expiry is {earliest_expiry}, duty date is {duty_date}."
            )

    @staticmethod
    def evaluate_rule_base_07(
        crew_base: str, 
        flight_departure_station: str, 
        is_reserve_callout: bool
    ) -> Optional[dict]:
        """
        RULE-BASE-07: Reserve callout from base only, unless deadhead cost is applied[cite: 2].
        
        Returns:
            A dictionary containing penalty details if valid but incurs cost, else None.
        """
        if is_reserve_callout and crew_base != flight_departure_station:
            # Note: Do not raise a violation, but flag for deadhead cost calculation
            return {
                "rule_flag": "RULE-BASE-07",
                "status": "legal_with_cost",
                "detail": f"Deadhead required from {crew_base} to {flight_departure_station}."
            }
        return None

# ==========================================
# USAGE EXAMPLE (Middleware Validator Wrapper)
# ==========================================

def validate_assignment(crew_data: dict, flight_data: dict) -> dict:
    """
    Executes all hard rules. Returns success or traps the RuleViolation
    to return a structured error payload back to the LLM agent.
    """
    try:
        engine = RulesEngine()
        
        engine.evaluate_rule_qual_05(
            crew_ratings=crew_data['ratings'], 
            aircraft_type=flight_data['aircraft_type']
        )
        
        engine.evaluate_rule_duty_02(
            current_duty_hours_7d=crew_data['duty_hours_7d'],
            projected_duty_hours=flight_data['block_time_minutes'] / 60.0
        )
        
        engine.evaluate_rule_rest_04(
            last_rest_ended=crew_data['last_rest_ended'],
            next_duty_start=flight_data['scheduled_departure']
        )
        
        # Check base cost implications
        cost_implication = engine.evaluate_rule_base_07(
            crew_base=crew_data['base'],
            flight_departure_station=flight_data['departure_station'],
            is_reserve_callout=True
        )

        return {
            "status": "success",
            "legal": True,
            "cost_implication": cost_implication
        }

    except RuleViolation as rv:
        # LLM Error Payload Generation
        return {
            "status": "error",
            "legal": False,
            "violation": rv.rule_id,
            "detail": rv.detail
        }