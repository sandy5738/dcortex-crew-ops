import sqlite3
import json
import os
from pathlib import Path

# Paths
DATA_DIR = Path("data")
DB_PATH = "airline.db"

def init_db(cursor):
    """Create the necessary tables in SQLite."""
    print("Creating tables...")
    
    # Create Crew table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS crew (
            crew_id TEXT PRIMARY KEY,
            name TEXT,
            rank TEXT,
            base TEXT,
            ratings TEXT, -- Stored as JSON string since SQLite doesn't have an Array type
            seniority INTEGER,
            reachability_minutes INTEGER
        )
    ''')

    # Create Duty Clocks table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS duty_clocks (
            crew_id TEXT PRIMARY KEY,
            duty_hours_7d REAL,
            flight_hours_28d REAL,
            last_rest_ended TEXT,
            FOREIGN KEY(crew_id) REFERENCES crew(crew_id)
        )
    ''')
    
    # You would add more tables here for flights, rosters, etc.
    # e.g., CREATE TABLE flights (...)

def ingest_crew(cursor):
    """Load crew.json and insert into the crew table."""
    crew_file = DATA_DIR / "crew.json"
    if not crew_file.exists():
        print(f"Skipping crew ingestion, {crew_file} not found.")
        return

    with open(crew_file, "r") as f:
        crew_data = json.load(f)
    
    print(f"Ingesting {len(crew_data)} crew members...")
    
    # Prepare the INSERT statement. Use REPLACE to overwrite if the script is run multiple times.
    insert_sql = '''
        INSERT OR REPLACE INTO crew (crew_id, name, rank, base, ratings, seniority, reachability_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    '''
    
    for c in crew_data:
        # We use json.dumps for the 'ratings' array to store it as a string
        cursor.execute(insert_sql, (
            c.get("crew_id"),
            c.get("name"),
            c.get("rank"),
            c.get("base"),
            json.dumps(c.get("ratings", [])), 
            c.get("seniority"),
            c.get("reachability_minutes")
        ))

def ingest_duty_clocks(cursor):
    """Load duty_clocks.json and insert into the duty_clocks table."""
    clocks_file = DATA_DIR / "duty_clocks.json"
    if not clocks_file.exists():
        print(f"Skipping duty clocks ingestion, {clocks_file} not found.")
        return

    with open(clocks_file, "r") as f:
        clocks_data = json.load(f)
    
    print(f"Ingesting {len(clocks_data)} duty clocks...")
    
    insert_sql = '''
        INSERT OR REPLACE INTO duty_clocks (crew_id, duty_hours_7d, flight_hours_28d, last_rest_ended)
        VALUES (?, ?, ?, ?)
    '''
    
    for dc in clocks_data:
        cursor.execute(insert_sql, (
            dc.get("crew_id"),
            dc.get("duty_hours_7d"),
            dc.get("flight_hours_28d"),
            dc.get("last_rest_ended")
        ))

def main():
    print(f"Connecting to SQLite database: {DB_PATH}")
    # Connect to the database (this creates the file if it doesn't exist)
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    try:
        init_db(cursor)
        
        # Run the ingestion functions
        ingest_crew(cursor)
        ingest_duty_clocks(cursor)
        
        # Commit the transaction to save the data
        conn.commit()
        print("Data ingestion complete!")
        
    except Exception as e:
        conn.rollback() # Undo any partial inserts if something failed
        print(f"Error during ingestion: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    main()
