import sqlite3

def initialize_database(db_path="crew_ops.db"):
    conn = sqlite3.connect(db_path)
    # Enable foreign key enforcement in SQLite
    conn.execute("PRAGMA foreign_keys = ON;")
    cursor = conn.cursor()

    # Core Entities
    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS Station (
            station_code TEXT PRIMARY KEY,
            timezone TEXT
        );

        CREATE TABLE IF NOT EXISTS Flight (
            flight_id TEXT PRIMARY KEY,
            departure_station TEXT,
            arrival_station TEXT,
            scheduled_departure DATETIME,
            scheduled_arrival DATETIME,
            block_time_minutes INTEGER,
            aircraft_type TEXT,
            FOREIGN KEY(departure_station) REFERENCES Station(station_code),
            FOREIGN KEY(arrival_station) REFERENCES Station(station_code)
        );

        CREATE TABLE IF NOT EXISTS CrewMember (
            crew_id TEXT PRIMARY KEY,
            name TEXT,
            rank TEXT,
            base TEXT,
            seniority INTEGER,
            reachability_minutes INTEGER,
            FOREIGN KEY(base) REFERENCES Station(station_code)
        );

        CREATE TABLE IF NOT EXISTS DutyClock (
            clock_id TEXT PRIMARY KEY,
            crew_id TEXT,
            duty_hours_7d REAL,
            flight_hours_28d REAL,
            last_rest_ended DATETIME,
            FOREIGN KEY(crew_id) REFERENCES CrewMember(crew_id)
        );
    """)

    # Many-to-Many Junction Tables
    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS CrewAircraftRating (
            rating_id TEXT PRIMARY KEY,
            crew_id TEXT,
            aircraft_type TEXT,
            FOREIGN KEY(crew_id) REFERENCES CrewMember(crew_id)
        );

        CREATE TABLE IF NOT EXISTS CrewFlightAssignment (
            assignment_id TEXT PRIMARY KEY,
            pairing_id TEXT,
            crew_id TEXT,
            flight_id TEXT,
            duty_start DATETIME,
            duty_end DATETIME,
            status TEXT DEFAULT 'SCHEDULED',
            FOREIGN KEY(crew_id) REFERENCES CrewMember(crew_id),
            FOREIGN KEY(flight_id) REFERENCES Flight(flight_id)
        );
    """)
    conn.commit()
    return conn