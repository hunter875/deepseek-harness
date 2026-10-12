#!/bin/bash
# Evidence collection for the staging session: proves the event pipeline,
# cache layer and data persistence with concrete queries rather than log text.
PG_MATCH='docker exec edumatch-staging-matching-db-1 sh -c'
MY_AUTH='docker exec edumatch-staging-auth-db-1 sh -c'
REDIS='docker exec edumatch-staging-redis-1 redis-cli'

echo "########## E1 matching_db tables ##########"
$PG_MATCH 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT tablename FROM pg_tables WHERE schemaname='"'"'public'"'"' ORDER BY tablename;"' 2>&1 | tr -cd '[:print:]\n'

echo ""
echo "########## E2 processed_events schema ##########"
$PG_MATCH 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='"'"'processed_events'"'"' ORDER BY ordinal_position;"' 2>&1 | tr -cd '[:print:]\n'

echo ""
echo "########## E3 processed_events row count (idempotency ledger) ##########"
$PG_MATCH 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT COUNT(*) FROM processed_events;"' 2>&1 | tr -cd '[:print:]\n'

echo ""
echo "########## E4 processed_events rows ##########"
$PG_MATCH 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT * FROM processed_events LIMIT 5;"' 2>&1 | tr -cd '[:print:]\n' | head -10

echo ""
echo "########## E5 auth_db users (persistence across flows) ##########"
$MY_AUTH 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "SELECT COUNT(*) FROM auth_db.users; SELECT id, username, status FROM auth_db.users ORDER BY id;"' 2>&1 | tr -cd '[:print:]\n'

echo ""
echo "########## E6 Redis keyspace (cache evidence) ##########"
$REDIS INFO keyspace 2>&1 | tr -cd '[:print:]\n'
echo "DBSIZE: $($REDIS DBSIZE 2>&1)"
echo "--- all keys (up to 20) ---"
$REDIS --scan --count 50 2>&1 | head -20 | tr -cd '[:print:]\n'

echo ""
echo "########## E7 RabbitMQ queue depths ##########"
docker exec edumatch-staging-rabbitmq-1 rabbitmqctl list_queues name messages 2>/dev/null | grep -vE '^Timeout|^Listing|^name' | head -20 | tr -cd '[:print:]\n'

echo ""
echo "########## E8 consumer handler activity (event delivery proof) ##########"
docker logs edumatch-staging-matching-consumer-1 2>&1 | grep -E "Executed handler|processed|routing_key" | tail -8 | tr -cd '[:print:]\n'

echo ""
echo "########## E9 container uptimes ##########"
docker ps --format '{{.Names}}|{{.Status}}' | tr -cd '[:print:]\n'

echo ""
echo "########## EVIDENCE COMPLETE ##########"
