CREATE TABLE legacy_fixture (
  id INTEGER PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

INSERT INTO legacy_fixture (id, value) VALUES (1, 'preserve-me');
