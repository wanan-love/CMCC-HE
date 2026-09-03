-- Cloudflare D1 初始化（与 prisma/schema.prisma 同构；列名保持 camelCase 与 API/前端 1:1）
-- 执行：wrangler d1 execute <db-name> --remote --file migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS Tariff (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  scope       TEXT NOT NULL,
  "range"     TEXT NOT NULL,
  province    TEXT NOT NULL,
  price       TEXT,
  priceValue  REAL,
  onlineDate  TEXT,
  offlineDate TEXT,
  target      TEXT,
  channels    TEXT,
  effective   TEXT,
  requirement TEXT,
  unsubscribe TEXT,
  liability   TEXT,
  usageJson   TEXT NOT NULL,
  extraJson   TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  firstSeenAt TEXT NOT NULL,
  lastSeenAt  TEXT NOT NULL,
  status      TEXT NOT NULL,
  removedAt   TEXT
);

CREATE INDEX IF NOT EXISTS Tariff_category_idx   ON Tariff(category);
CREATE INDEX IF NOT EXISTS Tariff_status_idx     ON Tariff(status);
CREATE INDEX IF NOT EXISTS Tariff_onlineDate_idx ON Tariff(onlineDate);
CREATE INDEX IF NOT EXISTS Tariff_offlineDate_idx ON Tariff(offlineDate);
CREATE INDEX IF NOT EXISTS Tariff_priceValue_idx ON Tariff(priceValue);

CREATE TABLE IF NOT EXISTS SyncRun (
  id          TEXT PRIMARY KEY,
  startedAt   TEXT NOT NULL,
  finishedAt  TEXT,
  date        TEXT NOT NULL,
  status      TEXT NOT NULL,
  source      TEXT NOT NULL,
  mode        TEXT NOT NULL,
  totalBefore INTEGER NOT NULL DEFAULT 0,
  totalAfter  INTEGER NOT NULL DEFAULT 0,
  added       INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  message     TEXT,
  undoJson    TEXT,
  undoneAt    TEXT
);

CREATE TABLE IF NOT EXISTS ChangeEvent (
  id            TEXT PRIMARY KEY,
  date          TEXT NOT NULL,
  type          TEXT NOT NULL,
  source        TEXT NOT NULL,
  tariffCode    TEXT,
  tariffName    TEXT NOT NULL,
  category      TEXT,
  changedFields TEXT,
  summary       TEXT,
  syncRunId     TEXT,
  createdAt     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ChangeEvent_date_idx       ON ChangeEvent(date);
CREATE INDEX IF NOT EXISTS ChangeEvent_type_idx       ON ChangeEvent(type);
CREATE INDEX IF NOT EXISTS ChangeEvent_tariffCode_idx ON ChangeEvent(tariffCode);
CREATE INDEX IF NOT EXISTS ChangeEvent_source_idx     ON ChangeEvent(source);
