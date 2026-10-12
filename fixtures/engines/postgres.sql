CREATE TABLE processed_events (event_id VARCHAR(36) PRIMARY KEY, routing_key VARCHAR(255), status VARCHAR(30), attempt_count INTEGER, claimed_at TIMESTAMP, lease_until TIMESTAMP, processed_at TIMESTAMP);
INSERT INTO processed_events VALUES ('evt-fixture', 'user.profile.updated', 'PROCESSED', 1, NOW(), NOW(), NOW());
CREATE ROLE observer LOGIN PASSWORD 'fake-pg-observer-canary';
GRANT CONNECT ON DATABASE fixture TO observer;
GRANT USAGE ON SCHEMA public TO observer;
GRANT SELECT (event_id, routing_key, status, attempt_count, claimed_at, lease_until, processed_at) ON processed_events TO observer;
ALTER ROLE observer SET default_transaction_read_only = on;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
