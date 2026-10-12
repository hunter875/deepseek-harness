#!/bin/bash
# Row counts for the tables the matching worker is expected to write, plus a
# direct look at how many rows the event ledger holds after three registrations.
set -u
PSQL='docker exec edumatch-staging-matching-db-1 sh -c'

run_sql() {
  $PSQL "PGPASSWORD=\$POSTGRES_PASSWORD psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"$1\"" 2>&1 | tr -cd '[:print:]\n'
}

echo "=== row counts ==="
for t in schema_migrations processed_events applicant_features opportunity_features matching_scores recommendation_cache; do
  n=$(run_sql "SELECT COUNT(*) FROM $t;")
  echo "$t = $n"
done

echo ""
echo "=== processed_events content ==="
run_sql "SELECT event_id, routing_key, status, attempt_count FROM processed_events;"

echo ""
echo "=== recommendation_cache content ==="
run_sql "SELECT * FROM recommendation_cache LIMIT 3;"

echo ""
echo "=== applicant_features content ==="
run_sql "SELECT * FROM applicant_features LIMIT 3;"
