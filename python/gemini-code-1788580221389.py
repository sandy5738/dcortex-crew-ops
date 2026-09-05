from datetime import datetime
from typing import List, Dict, Any, Optional
from langchain_core.tools import tool

# ==========================================
# 1. IN-MEMORY DATA STORE (Mock Repository)
# ==========================================

class InMemoryDataStore:
    """Simulates a database using pure Python data structures."""
    
    def __init__(self):
        self.crew = {
            "CRW-001": {
                "crew_id": "CRW-001", "name": "Rajesh Kumar", "rank": "CAPTAIN", "base": "DEL", 
                "reachability_minutes": 90, "ratings": ["A320", "A321"],
                "duty_hours_7d": 45.5, "flight_hours_28d": 82.0, "last_rest_ended": "2026-09-04T06:00:00"
            },
            "CRW-002": {
                "crew_id": "CRW-002", "name": "Anita Desai", "rank": "FIRST_OFFICER", "base": "BOM", 
                "reachability_minutes": 120, "ratings": ["A320", "B737"],
                "duty_hours_7d": 58.0, "flight_hours_28d": 90.5, "last_rest_ended": "2026-09-03T20:00:00"
            },
            "CRW-003": {
                "crew_id": "CRW-003", "name": "Vikram Singh", "rank": "CAPTAIN", "base": "BLR", 
                "reachability_minutes": 60, "ratings": ["A320"],
                "duty_hours_7d": 12.0, "flight_hours_28d": 40.0, "last_rest_ended": "2026-09-02T18:00:00"
            }
        }
        
        self.flights = {
            "FLT-801": {
                "flight_id": "FLT-801", "departure_station": "DEL", "arrival_station": "BLR",
                "scheduled_departure": "2026-09-05T08:00:00", "aircraft_type": "A320", 
                "block_time_minutes": 165
            }
        }
        
        self.assignments = [
            {"assignment_id": "A-CRW-001-FLT-801", "pairing_id": "PAIR-99", "crew_id": "CRW-001", "flight_id": "FLT-801", "status": "SCHEDULED"}
        ]
        
        self.reserve_pool = [
            {"crew_id": "CRW-003", "station": "BLR", "standby_status": "AVAILABLE"}
        ]

# Global singleton instance for the tools to share state during the graph execution
db = InMemoryDataStore()


# ==========================================
# 2. DETERMINISTIC RULES ENGINE
# ==========================================

class RuleViolation(Exception):
    def __init__(self, rule_id: str, detail: str):
        self.rule_id = rule_id
        self.detail = detail
        super().__init__(f"{rule_id}: {detail}")

class RulesEngine:
    @staticmethod
    def evaluate_all(crew_data: dict, flight_data: dictTo isolate Python business logic from direct database queries, the standard architectural approaches depend on whether you are decoupling within a single application or across a distributed system:

---

### 1. Repository / Data Access Abstraction (Monolith / Single Service)
Business logic depends on an abstract interface (Repository) rather than executing ORM or raw SQL queries directly.

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

# 1. Domain Model
@dataclass
class User:
    id: int
    name: str
    email: str

# 2. Abstract Interface (No DB logic)
class UserRepository(ABC):
    @abstractmethod
    def get_by_id(self, user_id: int) -> Optional[User]:
        pass

# 3. Concrete Implementation (Encapsulates DB/Storage)
class PostgresUserRepository(UserRepository):
    def __init__(self, db_session):
        self.db = db_session

    def get_by_id(self, user_id: int) -> Optional[User]:
        # All DB query execution lives strictly inside the repository class
        row = self.db.query("SELECT id, name, email FROM users WHERE id = %s", (user_id,))
        return User(*row) if row else None

# 4. Business Service (Decoupled from DB)
class UserService:
    def __init__(self, repo: UserRepository):
        self.repo = repo  # Accepts interface, enabling easy mocking & decoupling

    def get_user_profile(self, user_id: int) -> dict:
        user = self.repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")
        return {"id": user.id, "display_name": user.name.title()}