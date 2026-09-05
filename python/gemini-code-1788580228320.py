import httpx
from typing import Optional

class UserDataClient:
    def __init__(self, base_url: str):
        self.client = httpx.Client(base_url=base_url, timeout=5.0)

    def fetch_user(self, user_id: int) -> Optional[dict]:
        response = self.client.get(f"/internal/v1/users/{user_id}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()