CREATE TABLE tasks (
        profile TEXT NOT NULL, task TEXT NOT NULL, last_activity INTEGER NOT NULL,
        record TEXT NOT NULL, PRIMARY KEY(profile, task));
CREATE INDEX tasks_activity ON tasks(last_activity DESC);
