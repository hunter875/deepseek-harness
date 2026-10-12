CREATE TABLE outbox_events (id BIGINT PRIMARY KEY, status VARCHAR(30), attempts INT, next_attempt_at DATETIME, published_at DATETIME, created_at DATETIME, updated_at DATETIME);
INSERT INTO outbox_events VALUES (1, 'PUBLISHED', 1, NOW(), NOW(), NOW(), NOW());
CREATE USER 'observer'@'%' IDENTIFIED BY 'fake-mysql-observer-canary';
GRANT SELECT (id, status, attempts, next_attempt_at, published_at, created_at, updated_at) ON fixture.outbox_events TO 'observer'@'%';
