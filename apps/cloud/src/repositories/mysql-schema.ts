export const COLLECTIONS = [
  'users',
  'rooms',
  'room_members',
  'room_codes',
  'activities',
  'activity_scores',
  'activity_cards',
  'commands',
  'user_room_signals',
  'notification_outbox',
  'result_slots',
  'rate_limits',
  'point_changes',
  'point_results',
  'point_totals',
  'da_a_entries',
  'da_a_totals',
] as const
export const table = (name: string) => {
  if (!(COLLECTIONS as readonly string[]).includes(name)) throw new Error('Unknown collection')
  return `sb_${name}`
}
// Canonical JSON preserves legacy optional fields and immutable receipts. Generated
// relational projections/indexes serve authorization, pagination and uniqueness.
export const schemaStatements = [
  ...COLLECTIONS.map(
    (name) => `CREATE TABLE IF NOT EXISTS ${table(name)} (
    id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    doc JSON NOT NULL,
    room_id VARCHAR(128) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc,'$.roomId'))) STORED,
    activity_id VARCHAR(128) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc,'$.activityId'))) STORED,
    user_id VARCHAR(128) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc,'$.userId'))) STORED,
    status VARCHAR(32) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc,'$.status'))) STORED,
    visited BIGINT GENERATED ALWAYS AS (JSON_EXTRACT(doc,'$.lastVisitedAt')) STORED,
    INDEX room_status(room_id,status,id), INDEX activity_idx(activity_id,id),
    INDEX user_recent(user_id,status,visited DESC,id)
    ${name === 'users' ? ", app_id VARCHAR(64) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc,'$.wechatAppId'))) STORED, open_id VARCHAR(128) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc,'$.wechatOpenId'))) STORED, UNIQUE KEY wechat_identity(app_id,open_id)" : ''}
    ${name === 'room_members' ? ', UNIQUE KEY membership(room_id,user_id)' : ''}
    ${name === 'commands' ? ", actor_id VARCHAR(128) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc,'$.actorUserId'))) STORED, request_id VARCHAR(100) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc,'$.result.requestId'))) STORED, UNIQUE KEY actor_request(actor_id,request_id)" : ''}
    ${name === 'activity_cards' ? ", number_value INT GENERATED ALWAYS AS (JSON_EXTRACT(doc,'$.number')) STORED, UNIQUE KEY activity_number(activity_id,number_value)" : ''}
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  ),
  `CREATE TABLE IF NOT EXISTS sb_activity_hot (id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, activity JSON NOT NULL, cards JSON NOT NULL, scores JSON NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS sb_sessions (token_hash CHAR(64) CHARACTER SET ascii PRIMARY KEY, app_id VARCHAR(64) NOT NULL, open_id VARCHAR(128) NOT NULL, expires_at BIGINT NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE, INDEX expiry(expires_at)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS sb_auth_limits (id CHAR(64) CHARACTER SET ascii PRIMARY KEY, window_start BIGINT NOT NULL, count_value INT NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS sb_migration_meta (id VARCHAR(32) PRIMARY KEY, value_text VARCHAR(128) NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS sb_staging (batch_id CHAR(64) CHARACTER SET ascii NOT NULL, collection_name VARCHAR(32) CHARACTER SET ascii NOT NULL, id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, doc JSON NOT NULL, PRIMARY KEY(batch_id,collection_name,id)) ENGINE=InnoDB`,
]
