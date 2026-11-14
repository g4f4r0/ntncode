#!/usr/bin/env python3
"""Generate test/scheduler/fixtures.json: python-dateutil's rrule as the oracle
for src/scheduler/rrule.ts.

Each case is {name, text, after, expected}: `expected` holds the first 12
distinct occurrence instants strictly after `after`, ascending, in UTC ISO form
(the format of Temporal.Instant#toString).

How an occurrence becomes an instant. dateutil expands in local wall time and
yields wall times carrying the start's ZoneInfo (fold=0). Some of those wall
times do not exist (spring-forward gap) or exist twice (fall-back overlap). The
TypeScript engine converts with Temporal's disambiguation "compatible", so this
script does the same explicitly in `to_utc_compatible`:
  - unambiguous wall time: its single offset;
  - ambiguous wall time: the earlier instant (the offset before the transition);
  - nonexistent wall time: the offset before the transition, which lands the
    instant `gap` past the wall time (02:30 in a 1h gap runs at 03:30 local).
Distinct instants are kept (a gap wall time can map onto the same instant as a
later wall time) and sorted, since wall order and instant order differ inside
a gap.

Run: python3 scripts/rrule-fixtures.py  (needs python-dateutil)
"""

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from dateutil.rrule import rrulestr

N = 12
OUT = Path(__file__).resolve().parent.parent / "test" / "scheduler" / "fixtures.json"
DTSTART = re.compile(r"^DTSTART(?:;TZID=([^:;]+))?:(\d{8}T\d{6})(Z?)$")
MAX_OFFSET = timedelta(hours=14)  # no zone is further ahead of UTC


def to_utc_compatible(wall):
    """Instant (aware UTC datetime) for a wall time, with "compatible" rules."""
    zone = wall.tzinfo
    naive = wall.replace(tzinfo=None)
    first = naive - zone.utcoffset(naive.replace(tzinfo=zone, fold=0))
    second = naive - zone.utcoffset(naive.replace(tzinfo=zone, fold=1))
    candidates = sorted({first, second})

    def exists(utc_naive):
        local = utc_naive.replace(tzinfo=timezone.utc).astimezone(zone)
        return local.replace(tzinfo=None) == naive

    real = [c for c in candidates if exists(c)]
    if real:
        chosen = real[0]  # unambiguous, or the earlier of two
    else:
        # In a gap: fold=0 uses the offset before the transition, which is the
        # one that shifts the instant forward past the gap.
        chosen = naive - zone.utcoffset(naive.replace(tzinfo=zone, fold=0))
        assert chosen == max(candidates), wall
    return chosen.replace(tzinfo=timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_start(line):
    m = DTSTART.match(line)
    assert m, line
    tzid, stamp, z = m.groups()
    zone = ZoneInfo("UTC" if z else tzid)
    return datetime.strptime(stamp, "%Y%m%dT%H%M%S").replace(tzinfo=zone)


def expected(text, after):
    lines = text.split("\n")
    start = parse_start(lines[0])
    if len(lines) == 1:
        utc = to_utc_compatible(start)
        return [iso(utc)] if utc > after else []
    rule = rrulestr(lines[1], dtstart=start, forceset=False)
    found = set()
    for wall in rule:
        utc = to_utc_compatible(wall)
        if utc > after:
            found.add(utc)
        if len(found) >= N:
            twelfth = sorted(found)[N - 1]
            # Every later wall time maps to an instant >= wall - MAX_OFFSET.
            if wall.replace(tzinfo=timezone.utc) - MAX_OFFSET > twelfth:
                break
    return [iso(x) for x in sorted(found)[:N]]


MAD = "TZID=Europe/Madrid"
BER = "TZID=Europe/Berlin"
NYC = "TZID=America/New_York"
SYD = "TZID=Australia/Sydney"
KOL = "TZID=Asia/Kolkata"


def start(zone, stamp):
    return f"DTSTART:{stamp}Z" if zone == "UTC" else f"DTSTART;{zone}:{stamp}"


WEEKDAYS = "MO,TU,WE,TH,FR"
EVEN_HOURS = ",".join(str(h) for h in range(0, 24, 2))
WORK_HOURS = ",".join(str(h) for h in range(9, 18))

# (name, zone, dtstart, rrule or None, after)
CASES = [
    # once
    ("once before start", BER, "20261120T090000", None, "2026-11-14T00:00:00Z"),
    ("once after start", BER, "20261120T090000", None, "2026-11-20T08:00:00Z"),
    ("once utc", "UTC", "20260101T000000", None, "2025-12-31T23:59:59Z"),
    # YEARLY
    ("yearly feb 29 skips non-leap years", MAD, "20200229T100000", "FREQ=YEARLY", "2021-01-01T00:00:00Z"),
    ("every 31 march", MAD, "20260331T090000", "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=31", "2026-01-01T00:00:00Z"),
    ("09:00 nov 11-24", MAD, "20261111T090000", "FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=" + ",".join(str(d) for d in range(11, 25)), "2026-11-14T12:00:00Z"),
    ("yearly interval 2 mondays jan and jul", BER, "20250106T080000", "FREQ=YEARLY;INTERVAL=2;BYMONTH=1,7;BYDAY=MO", "2026-06-01T00:00:00Z"),
    ("yearly last day of february", "UTC", "20240229T120000", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1", "2024-03-01T00:00:00Z"),
    ("friday 13th", NYC, "20260213T180000", "FREQ=YEARLY;BYMONTHDAY=13;BYDAY=FR", "2026-03-01T00:00:00Z"),
    ("last weekday of december", SYD, "20261231T170000", "FREQ=YEARLY;BYMONTH=12;BYDAY=" + WEEKDAYS + ";BYSETPOS=-1", "2026-01-01T00:00:00Z"),
    ("leap day count 3", "UTC", "20240229T000000", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;COUNT=3", "2020-01-01T00:00:00Z"),
    ("yearly with hours and minutes", KOL, "20260601T090000", "FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=1;BYHOUR=9,18;BYMINUTE=0,30", "2026-06-01T04:00:00Z"),
    ("yearly jump from 1990", BER, "19900704T120000", "FREQ=YEARLY", "2026-11-14T00:00:00Z"),
    ("yearly never (feb 31)", "UTC", "20260101T000000", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31", "2026-01-01T00:00:00Z"),
    # MONTHLY
    ("1st and 15th", MAD, "20260101T090000", "FREQ=MONTHLY;BYMONTHDAY=1,15", "2026-03-10T00:00:00Z"),
    ("last day of month", BER, "20260131T180000", "FREQ=MONTHLY;BYMONTHDAY=-1", "2026-01-01T00:00:00Z"),
    ("monthly on the 31st skips short months", MAD, "20260131T100000", "FREQ=MONTHLY", "2026-02-01T00:00:00Z"),
    ("monthly 29 30 31", "UTC", "20260101T060000", "FREQ=MONTHLY;BYMONTHDAY=29,30,31", "2026-01-15T00:00:00Z"),
    ("last working day 17:00", MAD, "20260130T170000", "FREQ=MONTHLY;BYDAY=" + WEEKDAYS + ";BYSETPOS=-1", "2026-02-15T00:00:00Z"),
    ("first working day", NYC, "20260101T090000", "FREQ=MONTHLY;BYDAY=" + WEEKDAYS + ";BYSETPOS=1", "2026-02-15T00:00:00Z"),
    ("second working day", BER, "20260101T090000", "FREQ=MONTHLY;BYDAY=" + WEEKDAYS + ";BYSETPOS=2", "2026-09-15T00:00:00Z"),
    ("first monday of quarter", MAD, "20260105T090000", "FREQ=MONTHLY;INTERVAL=3;BYDAY=MO;BYSETPOS=1", "2026-02-01T00:00:00Z"),
    ("second-to-last tuesday", SYD, "20260101T100000", "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=-2", "2026-01-01T00:00:00Z"),
    ("first and last weekend slot", "UTC", "20260101T100000", "FREQ=MONTHLY;BYDAY=SA,SU;BYHOUR=10,14;BYSETPOS=-1,1", "2026-01-01T00:00:00Z"),
    ("monthly interval 2 filtered by month", KOL, "20260115T080000", "FREQ=MONTHLY;INTERVAL=2;BYMONTH=1,3,5", "2026-01-01T00:00:00Z"),
    ("monthly friday 13th", BER, "20260101T090000", "FREQ=MONTHLY;BYMONTHDAY=13;BYDAY=FR", "2026-01-01T00:00:00Z"),
    ("monthly until", MAD, "20260115T120000", "FREQ=MONTHLY;UNTIL=20260915T100000Z", "2026-03-01T00:00:00Z"),
    ("monthly jump from 2000", NYC, "20000310T083000", "FREQ=MONTHLY;INTERVAL=5", "2026-11-14T00:00:00Z"),
    ("monthly never (apr/jun 31)", "UTC", "20260101T000000", "FREQ=MONTHLY;BYMONTH=4,6;BYMONTHDAY=31", "2026-01-01T00:00:00Z"),
    # WEEKLY
    ("every other monday 08:00", MAD, "20260105T080000", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "2026-03-20T00:00:00Z"),
    ("mon wed fri", BER, "20260101T073000", "FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-10-20T00:00:00Z"),
    ("weekly default weekday across us dst", NYC, "20260115T093000", "FREQ=WEEKLY", "2026-02-20T00:00:00Z"),
    ("weekdays 09:00 and 17:00", MAD, "20260105T090000", "FREQ=WEEKLY;BYDAY=" + WEEKDAYS + ";BYHOUR=9,17;BYMINUTE=0", "2026-03-26T12:00:00Z"),
    ("biweekly mon wed until", MAD, "20261102T090000", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T225959Z", "2026-11-14T00:00:00Z"),
    ("weekly setpos partial first week", "UTC", "20260107T120000", "FREQ=WEEKLY;BYDAY=MO,FR;BYSETPOS=1", "2026-01-01T00:00:00Z"),
    ("sundays in december", SYD, "20261206T190000", "FREQ=WEEKLY;BYMONTH=12;BYDAY=SU", "2026-12-10T00:00:00Z"),
    ("every 3 weeks jump from 2015", KOL, "20150105T090000", "FREQ=WEEKLY;INTERVAL=3", "2026-11-14T00:00:00Z"),
    ("saturdays count 5 after before start", BER, "20261107T100000", "FREQ=WEEKLY;BYDAY=SA;COUNT=5", "2026-01-01T00:00:00Z"),
    ("last of tue sat across new year", "UTC", "20261201T120000", "FREQ=WEEKLY;BYDAY=TU,SA;BYSETPOS=-1", "2026-12-20T00:00:00Z"),
    # DAILY
    ("daily 08:00 madrid spring", MAD, "20260301T080000", "FREQ=DAILY", "2026-03-26T00:00:00Z"),
    ("daily 08:00 madrid fall", MAD, "20260301T080000", "FREQ=DAILY", "2026-10-22T00:00:00Z"),
    ("daily 02:30 madrid spring gap", MAD, "20260301T023000", "FREQ=DAILY", "2026-03-26T00:00:00Z"),
    ("daily 02:30 madrid fall overlap", MAD, "20260301T023000", "FREQ=DAILY", "2026-10-22T00:00:00Z"),
    ("daily 02:30 new york spring gap", NYC, "20260101T023000", "FREQ=DAILY", "2026-03-05T00:00:00Z"),
    ("daily 01:30 new york fall overlap", NYC, "20260101T013000", "FREQ=DAILY", "2026-10-29T00:00:00Z"),
    ("daily 02:30 sydney spring gap", SYD, "20260101T023000", "FREQ=DAILY", "2026-09-30T00:00:00Z"),
    ("daily 02:30 sydney fall overlap", SYD, "20260101T023000", "FREQ=DAILY", "2026-04-01T00:00:00Z"),
    ("every 2 hours at :15 madrid spring", MAD, "20260101T001500", "FREQ=DAILY;BYHOUR=" + EVEN_HOURS + ";BYMINUTE=15", "2026-03-28T20:00:00Z"),
    ("every 2 hours at :15 madrid fall", MAD, "20260101T001500", "FREQ=DAILY;BYHOUR=" + EVEN_HOURS + ";BYMINUTE=15", "2026-10-24T20:00:00Z"),
    ("every 3 days jump", BER, "20200101T060000", "FREQ=DAILY;INTERVAL=3", "2026-11-14T00:00:00Z"),
    ("weekdays 09:00", MAD, "20260101T090000", "FREQ=DAILY;BYDAY=" + WEEKDAYS, "2026-11-14T00:00:00Z"),
    ("weekdays 09 and 17 new york", NYC, "20260101T090000", "FREQ=DAILY;BYDAY=" + WEEKDAYS + ";BYHOUR=9,17", "2026-03-05T00:00:00Z"),
    ("daily 07:00 count 10", MAD, "20261201T070000", "FREQ=DAILY;COUNT=10", "2026-12-05T00:00:00Z"),
    ("daily 07:00 until end of 2026", MAD, "20261201T070000", "FREQ=DAILY;UNTIL=20261231T225959Z", "2026-12-25T00:00:00Z"),
    ("first and last day of month", KOL, "20260101T080000", "FREQ=DAILY;BYMONTHDAY=-1,1", "2026-01-01T00:00:00Z"),
    ("daily on leap days", "UTC", "20200101T000000", "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29", "2026-01-01T00:00:00Z"),
    ("every 15 min 09:00-17:45 weekdays", MAD, "20260105T090000", "FREQ=DAILY;BYDAY=" + WEEKDAYS + ";BYHOUR=" + WORK_HOURS + ";BYMINUTE=0,15,30,45", "2026-11-13T15:00:00Z"),
    ("daily second of three times", BER, "20260101T080000", "FREQ=DAILY;BYHOUR=8,12,16;BYSETPOS=2", "2026-03-27T00:00:00Z"),
    ("daily after before start", "UTC", "20261201T120000", "FREQ=DAILY", "2026-01-01T00:00:00Z"),
    ("every 2 days count 5", KOL, "20261101T070000", "FREQ=DAILY;INTERVAL=2;COUNT=5", "2026-11-04T00:00:00Z"),
    # HOURLY
    ("hourly madrid spring", MAD, "20260328T220000", "FREQ=HOURLY", "2026-03-28T23:30:00Z"),
    ("hourly madrid fall", MAD, "20261024T220000", "FREQ=HOURLY", "2026-10-24T22:30:00Z"),
    ("every 3 hours new york fall", NYC, "20261031T000000", "FREQ=HOURLY;INTERVAL=3", "2026-11-01T00:00:00Z"),
    ("every 2 hours at :15 hourly", MAD, "20260101T001500", "FREQ=HOURLY;INTERVAL=2;BYMINUTE=15", "2026-03-28T20:00:00Z"),
    ("hourly 9-11 weekdays", BER, "20260101T090000", "FREQ=HOURLY;BYDAY=" + WEEKDAYS + ";BYHOUR=9,10,11", "2026-11-13T09:00:00Z"),
    ("every 5 hours jump from 2020", "UTC", "20200101T000000", "FREQ=HOURLY;INTERVAL=5", "2026-11-14T03:00:00Z"),
    ("every 7 hours filtered", KOL, "20260101T010000", "FREQ=HOURLY;INTERVAL=7;BYHOUR=1,8,15", "2026-06-01T00:00:00Z"),
    ("hourly last of two minutes", SYD, "20260101T000000", "FREQ=HOURLY;BYMINUTE=0,30;BYSETPOS=-1", "2026-04-04T14:00:00Z"),
    ("hourly count 30", MAD, "20261024T200000", "FREQ=HOURLY;COUNT=30", "2026-10-25T00:00:00Z"),
    ("hourly until sydney spring", SYD, "20261003T200000", "FREQ=HOURLY;INTERVAL=2;UNTIL=20261004T050000Z", "2026-10-03T12:00:00Z"),
    # MINUTELY
    ("every 10 min jump from 2020", MAD, "20200101T000000", "FREQ=MINUTELY;INTERVAL=10", "2026-06-15T12:34:00Z"),
    ("every 25 min across madrid gap", MAD, "20260328T220000", "FREQ=MINUTELY;INTERVAL=25", "2026-03-29T00:30:00Z"),
    ("every 15 min across madrid overlap", MAD, "20261024T220000", "FREQ=MINUTELY;INTERVAL=15", "2026-10-25T00:20:00Z"),
    ("every 15 min working hours new york", NYC, "20260101T090000", "FREQ=MINUTELY;INTERVAL=15;BYDAY=" + WEEKDAYS + ";BYHOUR=" + WORK_HOURS, "2026-03-06T21:00:00Z"),
    ("every 7 min at :00 or :30", "UTC", "20260101T000000", "FREQ=MINUTELY;INTERVAL=7;BYMINUTE=0,30", "2026-01-01T00:00:00Z"),
    ("minutely count 20", BER, "20261114T100000", "FREQ=MINUTELY;COUNT=20", "2026-11-14T09:05:00Z"),
    ("every 45 min jump across sydney gap", SYD, "20190101T000000", "FREQ=MINUTELY;INTERVAL=45", "2026-10-03T14:00:00Z"),
    ("every 90 min mornings", KOL, "20260101T060000", "FREQ=MINUTELY;INTERVAL=90;BYHOUR=6,7,8", "2026-01-05T00:00:00Z"),
    ("every 30 min across new york gap", NYC, "20260307T000000", "FREQ=MINUTELY;INTERVAL=30", "2026-03-08T06:10:00Z"),
]


def main():
    out = []
    for name, zone, stamp, rule, after in CASES:
        text = start(zone, stamp) + ("" if rule is None else "\nRRULE:" + rule)
        after_dt = datetime.strptime(after, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        out.append({"name": name, "text": text, "after": after, "expected": expected(text, after_dt)})
    OUT.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {len(out)} cases to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
