import { dirname, extname, join, posix, resolve, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateEvent } from '../core/events.js';
import { opencodeDatabasePath } from '../lib/platform-roots.js';

const RESTORE_WINDOW_MS = 2 * 60 * 60 * 1000;
const IDLE_END_MS = 6 * 60 * 1000;
const SESSION_LIMIT = 200;
const MESSAGE_LIMIT = 200;
const PART_LIMIT = 500;
const KNOWN_PART_TYPES = new Set(['text', 'reasoning', 'tool', 'step-start', 'step-finish', 'compaction', 'file', 'patch', 'subtask']);
const TOOL_ROOMS = new Map([
  ['read', 'library'], ['glob', 'library'], ['grep', 'library'],
  ['edit', 'dev'], ['write', 'dev'], ['patch', 'dev'],
  ['bash', 'server'], ['shell', 'server'], ['webfetch', 'search'], ['websearch', 'search']
]);
// 이벤트에 싣는 도구 이름은 알려진 기본 도구로 제한한다. MCP·플러그인 도구는 서버 이름이 드러나지 않게 mcp로 줄인다.
const KNOWN_TOOLS = new Set([...TOOL_ROOMS.keys(), 'task', 'todowrite', 'todoread', 'list', 'skill', 'question', 'lsp',
  'multiedit', 'apply_patch', 'batch', 'codesearch']);
function safeToolName(name) {
  if (!name) return 'unknown';
  return KNOWN_TOOLS.has(name) ? name : 'mcp';
}

const SESSION_SQL = `SELECT id, project_id, parent_id, time_created, time_updated
  FROM session WHERE time_updated >= ? ORDER BY time_updated DESC, id DESC LIMIT ?`;
const PROJECT_SQL = `WITH RECURSIVE path_parts(id, rest, segment) AS (
  SELECT id, rtrim(replace(worktree, char(92), '/'), '/') || '/', NULL
  FROM project WHERE id IN (%IDS%)
  UNION ALL
  SELECT id, substr(rest, instr(rest, '/') + 1), substr(rest, 1, instr(rest, '/') - 1)
  FROM path_parts WHERE rest <> ''
)
SELECT id, segment AS project FROM path_parts WHERE rest = ''`;
const MESSAGE_SQL = `SELECT id, time_updated, json_extract(data, '$.role') AS role,
  json_extract(data, '$.time.completed') AS completed
  FROM message WHERE session_id = ? AND time_updated >= ?
  ORDER BY time_updated, id LIMIT ?`;
const MESSAGE_CURSOR_SQL = `SELECT id, time_updated, json_extract(data, '$.role') AS role,
  json_extract(data, '$.time.completed') AS completed
  FROM message WHERE session_id = ? AND
  (time_updated > ? OR (time_updated = ? AND id > ?))
  ORDER BY time_updated, id LIMIT ?`;
const PART_SQL = `SELECT id, time_updated, json_extract(data, '$.type') AS type,
  json_extract(data, '$.tool') AS tool, json_extract(data, '$.state.status') AS status
  FROM part WHERE session_id = ? AND time_updated >= ?
  ORDER BY time_updated, id LIMIT ?`;
const PART_CURSOR_SQL = `SELECT id, time_updated, json_extract(data, '$.type') AS type,
  json_extract(data, '$.tool') AS tool, json_extract(data, '$.state.status') AS status
  FROM part WHERE session_id = ? AND
  (time_updated > ? OR (time_updated = ? AND id > ?))
  ORDER BY time_updated, id LIMIT ?`;

// V2 keeps message roles in a column and content inline, not in the legacy part table.
// Extract structural metadata in SQL so prompts, reasoning, and tool payloads never leave SQLite.
const V2_MESSAGE_COLUMNS = `SELECT id, time_created, time_updated, type AS role,
  json_extract(data, '$.time.completed') AS completed,
  (SELECT json_group_array(json_object(
    'ordinal', content.key, 'type', json_extract(content.value, '$.type'),
    'tool', json_extract(content.value, '$.name'),
    'status', json_extract(content.value, '$.state.status'),
    'created', json_extract(content.value, '$.time.created'),
    'completed', json_extract(content.value, '$.time.completed')
  )) FROM (SELECT key, value FROM json_each(session_message.data, '$.content') LIMIT ${PART_LIMIT}) content) AS parts
  FROM session_message WHERE session_id = ? AND `;
const V2_MESSAGE_SQL = `${V2_MESSAGE_COLUMNS}time_updated >= ? ORDER BY time_updated, id LIMIT ?`;
const V2_MESSAGE_CURSOR_SQL = `${V2_MESSAGE_COLUMNS}(time_updated > ? OR (time_updated = ? AND id > ?))
  ORDER BY time_updated, id LIMIT ?`;

function databaseSchema(database) {
  const v2 = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_v2'").get();
  return v2 ? 'v2' : 'legacy';
}

function configuredDatabasePath(config, fallback, platform) {
  const selected = typeof config?.path === 'string' && config.path.trim() ? config.path.trim() : fallback;
  const pathApi = platform === 'win32' ? win32 : posix;
  return extname(selected).toLowerCase() === '.db' ? pathApi.resolve(selected) : pathApi.join(pathApi.resolve(selected), 'opencode.db');
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function projectQuery(ids) {
  return PROJECT_SQL.replace('%IDS%', ids.map(() => '?').join(', '));
}

/** OpenCode의 SQLite 상태를 읽기 전용으로 증분 변환 */
export function createOpenCodeAdapter({
  home = undefined,
  platform = process.platform,
  env = process.env,
  now = Date.now,
  databasePath = null,
  databaseFactory = (path, options) => new DatabaseSync(path, options)
} = {}) {
  const resolvePath = platform === 'win32' ? win32.resolve : resolve;
  const fallbackPath = databasePath ? resolvePath(databasePath) : opencodeDatabasePath({ platform, home, env });
  const cursors = new Map();
  const started = new Set();
  const ended = new Set();
  const lastActivityAt = new Map();
  const lastRoom = new Map();
  const lastTextEventAt = new Map();
  const v2Records = new Map();
  let ignoredCount = 0;
  let unknownCount = 0;
  let databaseErrorCount = 0;
  let lastEventAt = null;

  function event(session, kind, ts, values = {}) {
    const result = {
      v: 1, source: 'opencode', sessionId: session.id, agentId: session.id,
      parentAgentId: session.parentId, project: session.project ?? null, title: null,
      kind, tool: null, room: null, detail: null, exitCode: null, git: null,
      ts, startedAt: null, endedAt: null, live: true, ...values
    };
    return validateEvent(result) ? result : null;
  }

  function append(events, session, kind, ts, values = {}) {
    if (ended.has(session.id)) {
      ended.delete(session.id);
      started.delete(session.id);
    }
    if (!started.has(session.id)) {
      started.add(session.id);
      const start = event(session, 'session_start', ts);
      if (start) events.push(start);
    }
    const item = event(session, kind, ts, values);
    if (item) {
      events.push(item);
      lastActivityAt.set(session.id, ts);
      lastEventAt = Math.max(lastEventAt ?? 0, ts);
      ended.delete(session.id);
    }
  }

  function queryRows(database, sql, params) {
    return database.prepare(sql).all(...params);
  }

  function v2MessageRecords(messages, sessionId) {
    const seen = v2Records.get(sessionId) ?? new Map();
    v2Records.set(sessionId, seen);
    const records = [];
    for (const row of messages) {
      const signature = `${row.role}:${row.completed ?? ''}`;
      if (seen.get(row.id) !== signature) {
        seen.set(row.id, signature);
        // V2 also stores system/idle/location messages; they are not conversation turns.
        if (row.role === 'user' || row.role === 'assistant') {
          records.push({ category: 'message', row,
            ts: timestamp(row.completed) ?? timestamp(row.time_created) ?? now() });
        }
      }
      for (const part of JSON.parse(row.parts)) {
        const id = `${row.id}:${part.ordinal}`;
        const signature = JSON.stringify([part.type, part.tool, part.status,
          part.type === 'tool' ? part.completed ?? part.created : row.time_updated]);
        if (seen.get(id) === signature) continue;
        seen.set(id, signature);
        // Streaming text/reasoning can have an old creation time while still being updated.
        const activityTime = part.type === 'tool' ? part.created : row.time_updated;
        records.push({ category: 'part', row: { ...part, id },
          ts: timestamp(part.completed) ?? timestamp(activityTime) ?? timestamp(row.time_updated) ?? now() });
      }
    }
    return records;
  }

  function poll(sourceConfig = {}) {
    const path = configuredDatabasePath(sourceConfig, fallbackPath, platform);
    let database;
    try {
      database = databaseFactory(path, { readOnly: true });
      const schema = databaseSchema(database);
      const cutoff = now() - RESTORE_WINDOW_MS;
      const sessions = queryRows(database, schema === 'v2' ? SESSION_SQL.replace('FROM session ', 'FROM session_v2 ') : SESSION_SQL,
        [cutoff, SESSION_LIMIT]);
      const projectIds = [...new Set(sessions.map((row) => row.project_id).filter((id) => id !== null))];
      const projects = projectIds.length
        ? new Map(queryRows(database, projectQuery(projectIds), projectIds).map((row) => [row.id, row.project]))
        : new Map();
      const events = [];

      for (const row of sessions) {
        if (typeof row.id !== 'string') {
          unknownCount += 1;
          continue;
        }
        const session = { id: row.id, parentId: typeof row.parent_id === 'string' ? row.parent_id : null,
          project: typeof row.project_id === 'string' && projects.get(row.project_id)
            ? projects.get(row.project_id) : null };
        const cursor = cursors.get(session.id) ?? { messages: null, parts: null };
        const messageSql = schema === 'v2' ? V2_MESSAGE_SQL : MESSAGE_SQL;
        const messageCursorSql = schema === 'v2' ? V2_MESSAGE_CURSOR_SQL : MESSAGE_CURSOR_SQL;
        const messages = cursor.messages
          ? queryRows(database, messageCursorSql, [session.id, cursor.messages.time, cursor.messages.time, cursor.messages.id, MESSAGE_LIMIT])
          : queryRows(database, messageSql, [session.id, cutoff, MESSAGE_LIMIT]);
        const parts = schema === 'v2' ? [] : cursor.parts
          ? queryRows(database, PART_CURSOR_SQL, [session.id, cursor.parts.time, cursor.parts.time, cursor.parts.id, PART_LIMIT])
          : queryRows(database, PART_SQL, [session.id, cutoff, PART_LIMIT]);
        const records = (schema === 'v2' ? v2MessageRecords(messages, session.id) : [
          ...messages.map((row) => ({ category: 'message', row, ts: timestamp(row.time_updated) ?? now() })),
          ...parts.map((row) => ({ category: 'part', row, ts: timestamp(row.time_updated) ?? now() }))
        ]).sort((left, right) => left.ts - right.ts
          || Number(left.category === 'message' && left.row.role === 'assistant')
            - Number(right.category === 'message' && right.row.role === 'assistant')
          || String(left.row.id).localeCompare(String(right.row.id)));
        if (messages.length) {
          const last = messages.at(-1);
          cursor.messages = { time: last.time_updated, id: last.id };
        }
        if (parts.length) {
          const last = parts.at(-1);
          cursor.parts = { time: last.time_updated, id: last.id };
        }
        for (const record of records) {
          const { row, ts } = record;
          if (record.category === 'message') {
            if (row.role === 'user') {
              append(events, session, 'turn_start', ts);
            } else if (row.role === 'assistant' && row.completed !== null && row.completed !== undefined) {
              append(events, session, 'turn_end', ts);
            } else if (row.role !== 'user' && row.role !== 'assistant') {
              ignoredCount += 1;
            }
            continue;
          }

          if (row.type === 'reasoning') {
            append(events, session, 'thinking', ts, { room: lastRoom.get(session.id) ?? null });
          } else if (row.type === 'text') {
            if (ts - (lastTextEventAt.get(session.id) ?? 0) >= 10_000) {
              append(events, session, 'message', ts);
              lastTextEventAt.set(session.id, ts);
            } else {
              lastActivityAt.set(session.id, ts);
            }
          } else if (row.type === 'step-finish') {
            append(events, session, 'turn_end', ts);
          } else if (row.type === 'tool') {
            const toolName = typeof row.tool === 'string' ? row.tool.toLowerCase() : '';
            const room = TOOL_ROOMS.get(toolName) ?? 'desk';
            lastRoom.set(session.id, room);
            const isTask = toolName === 'task';
            if (row.status === 'running') {
              append(events, session, isTask ? 'spawn' : 'tool_start', ts, {
                tool: safeToolName(toolName), room: isTask ? null : room, startedAt: ts
              });
            } else if (row.status === 'completed' || row.status === 'error') {
              append(events, session, isTask ? 'despawn' : 'tool_end', ts, {
                tool: safeToolName(toolName), room: isTask ? null : room,
                exitCode: isTask ? null : row.status === 'completed' ? 0 : 1, endedAt: ts
              });
            } else {
              ignoredCount += 1;
            }
          } else if (KNOWN_PART_TYPES.has(row.type)) {
            ignoredCount += 1;
          } else {
            unknownCount += 1;
          }
        }
        cursors.set(session.id, cursor);

        const last = lastActivityAt.get(session.id) ?? timestamp(row.time_updated);
        if (started.has(session.id) && last !== null && now() - last >= IDLE_END_MS && !ended.has(session.id)) {
          ended.add(session.id);
          const end = event(session, 'session_end', last + IDLE_END_MS);
          if (end) events.push(end);
        }
      }
      return events;
    } catch {
      databaseErrorCount += 1;
      return [];
    } finally {
      try { database?.close(); } catch { /* 잠긴 DB 정리 오류는 다음 폴링에서 재시도 */ }
    }
  }

  function roots(sourceConfig = {}) {
    return [configuredDatabasePath(sourceConfig, fallbackPath, platform)];
  }

  return {
    id: 'opencode',
    pollOnly: true,
    handlesConfiguredPath: true,
    roots,
    match: () => false,
    createSession: () => null,
    parseLine: () => [],
    poll,
    diagnostics: () => ({ ignoredCount, unknownCount, databaseErrorCount }),
    connectivity: (at = now()) => ({
      recent: lastEventAt !== null && at - lastEventAt < 2 * 60 * 1000,
      lastEventAt
    }),
    configuredDatabasePath: (config = {}) => configuredDatabasePath(config, fallbackPath, platform)
  };
}

export default createOpenCodeAdapter();
