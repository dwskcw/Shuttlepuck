// Small date/time helpers shared by the journey planner UI.
//
// All transit times in this project are local clock times in Troy, NY
// (America/New_York), so every conversion goes through that zone rather than
// the viewer's local zone.

export const TroyTZ = 'America/New_York';

const troyFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TroyTZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// {date: 'YYYY-MM-DD', minute: minutes since midnight, right now in Troy}
export function troyNow() {
    const parts = Object.fromEntries(
        troyFormatter.formatToParts(new Date()).map((part) => [part.type, part.value])
    );
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        minute: Number(parts.hour) * 60 + Number(parts.minute),
    };
}

// 'YYYY-MM-DD' -> 'MONDAY' | 'TUESDAY' | ... (independent of viewer's zone).
export function weekdayName(date) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    return ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][day];
}

// Shuttle schedule groups days into day types.
export function shuttleDayType(date) {
    const name = weekdayName(date);
    if (name === 'SATURDAY') return 'saturday';
    if (name === 'SUNDAY') return 'sunday';
    return 'weekday';
}

// 'YYYY-MM-DD' -> the day before, still 'YYYY-MM-DD'.
export function previousDate(date) {
    const day = new Date(`${date}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() - 1);
    return day.toISOString().slice(0, 10);
}

// Does service `serviceIndex` (an entry of cdta.services) run on `date`?
// services: [[monday..sunday mask '1'/'0', startDateInt, endDateInt], ...]
// exceptions: { 'YYYYMMDD': [[serviceIndex, exceptionType], ...] } where
// exceptionType 1 = added, 2 = removed (GTFS calendar_dates semantics).
export function serviceRuns(services, exceptions, serviceIndex, date) {
    const service = services[serviceIndex];
    if (!service) return false;
    const numericDate = Number(date.replaceAll('-', ''));
    const exception = (exceptions[String(numericDate)] || [])
        .find(([index]) => index === serviceIndex);
    if (exception) return exception[1] === 1;

    const [weekdays, start, end] = service;
    const sundayBasedDay = new Date(`${date}T12:00:00Z`).getUTCDay();
    const mondayBasedDay = (sundayBasedDay + 6) % 7;
    return numericDate >= start && numericDate <= end && weekdays[mondayBasedDay] === '1';
}

// 645 -> '6:45 AM', 1435 -> '11:55 PM'. GTFS minutes can exceed 24h (24:10);
// those wrap with a "+1 day" marker so the UI can show them honestly.
export function formatClock(minute) {
    const dayOffset = Math.floor(minute / 1440);
    const within = ((minute % 1440) + 1440) % 1440;
    const hour = Math.floor(within / 60);
    const clock = `${hour % 12 || 12}:${String(within % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
    return dayOffset ? `${clock} +1d` : clock;
}
