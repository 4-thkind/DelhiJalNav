# Data sources for the pilot corridor

| File | What it is | Source | Retrieved | Verification |
|---|---|---|---|---|
| `routes/minto-corridor.json` | Two road-following candidates from JLN Marg near Ajmeri Gate to Connaught Place (Outer Circle). **A**: via Vivekanand Marg and the Minto Bridge underpass. **B**: via Maharaja Ranjeet Singh Marg, Shivaji Flyover and Barakhamba Road. | Public OSRM demo server (`router.project-osrm.org`), `driving` profile, which runs on OpenStreetMap data | 2026-10-08, by `scripts/fetch_corridor.py` (exact request URLs are stored in the file) | **candidate**: retrieved by a script, not reviewed by a person |
| `hotspots.geojson` | The Minto Bridge underpass hazard corridor. It is the 70 m of candidate A around OSM way 596346053 ("Minto Bridge", `man_made=bridge`), buffered by 15 m. | Derived from the two sources above | 2026-10-08 | **candidate** |

## Attribution and terms

- Map data © OpenStreetMap contributors, available under the [Open Database License 1.0](https://www.openstreetmap.org/copyright). The route and corridor geometry is derived from OSM, so you must keep the attribution and the ODbL derived-database terms when redistributing it.
- The OSRM demo server is a free public service with no availability guarantee. The fixtures are committed so the demo never calls it at runtime.

## Known limits

- The public OSRM server has only a car profile. The two-wheeler profile is not modelled.
- Durations are OSRM free-flow estimates, not live traffic.
- The underpass is named as a historical waterlogging site in the original project brief. Nobody has surveyed it for this project. Historical susceptibility never creates a current restriction: only reports do.
- Before claiming the corridor is "reviewed", a team member must:
  - open both lines on a map and confirm they follow real, legal road directions;
  - confirm that the corridor polygon covers the underpass carriageway and nothing grade-separated;
  - then set `verification` to `map_reviewed` and record the reviewer and date in a private team log.
- To regenerate the files, run `python scripts/fetch_corridor.py`. Then re-run the tests, because `test_fixture_geometry_real_and_valid` checks that A still crosses the corridor and B does not.
