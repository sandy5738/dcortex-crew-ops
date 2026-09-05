from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime, date

# 1. Core Entities
class CrewMember(BaseModel):
    crew_id: str = Field(description="Primary key linking to clocks, certs, and rosters")
    name: str
    rank: str
    base: str = Field(description="Station code used to calculate deadhead costs")
    ratings: List[str] = Field(description="Aircraft types for RULE-QUAL-05 validation")
    seniority: int
    reachability_minutes: int

class Flight(BaseModel):
    flight_id: str = Field(description="Flight number, e.g., DX412")
    departure_station: str
    arrival_station: str
    scheduled_departure: datetime
    scheduled_arrival: datetime
    block_time_minutes: int
    aircraft_type: str

# 2. Crew State & Constraints (Linked by crew_id)
class DutyClock(BaseModel):
    crew_id: str
    duty_hours_7d: float = Field(description="Evaluated against RULE-DUTY-02")
    flight_hours_28d: float = Field(description="Evaluated against RULE-FLT-03")
    last_rest_ended: datetime = Field(description="Evaluated against RULE-REST-04")

class Certification(BaseModel):
    crew_id: str
    licence_expiry: date = Field(description="Evaluated against RULE-CERT-06")
    medical_expiry: date
    training_expiry: date

class ReservePool(BaseModel):
    crew_id: str
    station: str
    on_call_start: datetime
    on_call_end: datetime
    standby_status: str

class RiskSignal(BaseModel):
    crew_id: str
    disruption_risk_score: float

# 3. Operational Assignments (The Junction Table)
class RosterAssignment(BaseModel):
    pairing_id: str = Field(description="e.g., P-2291")
    crew_id: str
    flights: List[str] = Field(description="List of flight_ids in this pairing sequence")
    duty_start: datetime
    duty_end: datetime

# 4. Rules & System Configurations
class LegalityRule(BaseModel):
    rule_id: str
    constraint_type: str
    threshold_value: Optional[float] = None
    description: str

class CostRates(BaseModel):
    callout_inr: int
    overtime_per_hour_inr: int
    deadhead_per_sector_inr: int
    penalty_inr: int