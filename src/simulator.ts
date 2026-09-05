import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(__dirname, '../data');

const ROSTERS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rosters.json'), 'utf-8')).pairings;
const FLIGHTS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'flights.json'), 'utf-8'));

function getFlightDetails(flightId: string) {
    return FLIGHTS.find((f: any) => f.flight_id === flightId);
}

export function simulateImpact(crewId: string, date: string) {
    let targetPairing: any = null;
    let targetRole: string | null = null;
    
    // 1. Find the pairing this crew member is assigned to
    for (const pairing of ROSTERS) {
        for (const crew of pairing.crew) {
            if (crew.crew_id === crewId) {
                targetPairing = pairing;
                targetRole = crew.role;
                break;
            }
        }
        if (targetPairing) break;
    }
            
    if (!targetPairing) {
        return { error: `Crew member ${crewId} is not assigned to any pairings.` };
    }

    // 2. Find the specific day in the pairing
    let affectedFlights: string[] = [];
    let reportUtc: string | null = null;
    
    for (const day of targetPairing.days) {
        if (day.date === date) {
            affectedFlights = day.flights;
            reportUtc = day.report_utc;
            break;
        }
    }
            
    if (affectedFlights.length === 0) {
        return { error: `Crew member ${crewId} is on pairing ${targetPairing.pairing_id}, but has no flights on ${date}.` };
    }

    // 3. Gather flight details to calculate passenger impact
    const uncrewedFlightsDetails = [];
    let totalPassengersAtRisk = 0;
    
    for (const fId of affectedFlights) {
        const details = getFlightDetails(fId);
        if (details) {
            uncrewedFlightsDetails.push({
                flight_no: details.flight_no,
                dep_station: details.dep_station,
                arr_station: details.arr_station
            });
            totalPassengersAtRisk += (details.seats || 0);
        }
    }

    // 4. Return the structured "Ripple Effect"
    return {
        disruption: `${targetRole} ${crewId} is unavailable on ${date}.`,
        pairing_broken: targetPairing.pairing_id,
        uncrewed_flights: uncrewedFlightsDetails,
        passengers_affected: totalPassengersAtRisk,
        action_required: `A replacement ${targetRole} must be found before ${reportUtc}.`
    };
}

if (require.main === module) {
    console.log("Simulating disruption for C-5837 on 2026-09-14...\n");
    const impact = simulateImpact("C-5837", "2026-09-14");
    console.log(JSON.stringify(impact, null, 2));
}
