from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime, date

# ==========================================
# 1. CORE ENTITIES (NO FOREIGN KEYS)
# ==========================================

class Station(BaseModel):
    station_code: str = Field(description="PK: e.g., BLR, DEL, BOM")
    timezone: Optional[str] = None

class Flight(BaseModel):
    flight_id: str = Field(description="PK: e.g., DX412")
    departure_station: str = Field(description="FK -> Station.station_code")
    arrival_station: str = Field(description="FK -> Station.station_code")
    scheduled_departure: datetime
    scheduled_arrival: datetime
    block_time_minutes: int
    aircraft_type: str

class CrewMember(BaseModel):
    crew_id: str = Field(description="PK: e.g., C-1042")
    name: str
    rank: str
    base: str = Field(description="FK -> Station.station_code")
    seniority: int
    reachability_minutes: int


# ==========================================
# 2. 1:1 OR 1:N DEPENDENT TABLES
# ==========================================

class DutyClock(BaseModel):
    clock_id: str = Field(description="PK")
    crew_id: str = Field(description="FK -> CrewMember.crew_id")
    duty_hours_7d: float
    flight_hours_28d: float
    last_rest_ended: datetime

class Certification(BaseModel):
    cert_id: str = Field(description="PK")
    crew_id: str = Field(description="FK -> CrewMember.crew_id")
    licence_expiry: date
    medical_expiry: date
    training_expiry: date

class ReservePool(BaseModel):
    reserve_id: str = Field(description="PK")
    crew_id: str = Field(description="FK -> CrewMember.crew_id")
    station: str = Field(description="FK -> Station.station_code")
    on_call_start: datetime
    on_call_end: datetime
    standby_status: str


# ==========================================
# 3. MANY-TO-MANY (M2M) INTERMEDIATE TABLES
# ==========================================

class CrewAircraftRating(BaseModel):
    """
    M2M Junction Table: A crew member has multiple ratings; 
    a rating belongs to multiple crew members.
    Resolves the `ratings: ["A320"]` list from crew.json.
    """
    rating_id: str = Field(description="PK")
    crew_id: str = Field(description="FK -> CrewMember.crew_id")
    aircraft_type: str = Field(description="e.g., A320. Checked against Flight.aircraft_type for RULE-QUAL-05")

class CrewFlightAssignment(BaseModel):
    """
    M2M Junction Table: A flight has multiple crew members;
    a crew member flies multiple flights (grouped by pairing).
    Replaces the nested lists in rosters.json.
    """
    assignment_id: str = Field(description="PK")
    pairing_id: str = Field(description="Groups multiple flights into a single duty block (e.g., P-2291)")
    crew_id: str = Field(description="FK -> CrewMember.crew_id")
    flight_id: str = Field(description="FK -> Flight.flight_id")
    duty_start: datetime = Field(description="Start time of the overarching pairing")
    duty_end: datetime = Field(description="End time of the overarching pairing")
    status: str = Field(default="SCHEDULED", description="SCHEDULED, COMPLETED, OR CANCELLED")