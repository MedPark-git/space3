import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { augustActivities, OPERATIONS_SEED_VERSION } from "./august-seed.js";
import { SEED_VERSION, seedApplications, seedCandidates, seedInterviews, seedRequisitions } from "./seed-data.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const ASSET_ALIASES = new Map([
  ["hr-maps-operations-v2-20260811.js", "app.js"],
  ["hr-maps-operations-v2-20260811.css", "styles.css"],
  ["hr-maps-operations-v2-20260811b.js", "app.js"],
  ["hr-maps-operations-v2-20260811b.css", "styles.css"],
  ["hr-maps-operations-v2-20260811c.js", "app.js"],
  ["hr-maps-operations-v2-20260811c.css", "styles.css"],
  ["hr-maps-operations-v3-20260812a.js", "app.js"],
  ["hr-maps-operations-v3-20260812a.css", "styles.css"],
  ["hr-maps-operations-v4-20260812b.js", "app.js"],
  ["hr-maps-operations-v4-20260812b.css", "styles.css"],
  ["hr-maps-operations-v4-20260812c.js", "app.js"],
  ["hr-maps-operations-v4-20260812c.css", "styles.css"],
  ["hr-maps-operations-v4-20260812d.js", "app.js"],
  ["hr-maps-operations-v4-20260812d.css", "styles.css"],
  ["hr-maps-operations-v5-20260812a.js", "app.js"],
  ["hr-maps-operations-v5-20260812a.css", "styles.css"],
  ["hr-maps-operations-v5-20260812b.js", "app.js"],
  ["hr-maps-operations-v5-20260812c.js", "app.js"],
  ["hr-maps-operations-v5-20260812d.css", "styles.css"],
  ["hr-maps-operations-v6-20260814a.js", "app.js"],
  ["hr-maps-operations-v6-20260814a.css", "styles.css"],
  ["hr-maps-operations-v9-20260910b.js", "app.js"],
  ["hr-maps-operations-v9-20260910b.css", "styles.css"],
  ["hr-maps-operations-v9-20260910c.js", "app.js"],
  ["hr-maps-operations-v9-20260910c.css", "styles.css"],
  ["hr-maps-operations-v9-20260910d.js", "app.js"],
  ["hr-maps-operations-v9-20260910d.css", "styles.css"],
  ["hr-maps-operations-v9-20260910e.js", "app.js"],
  ["hr-maps-operations-v9-20260910e.css", "styles.css"],
  ["hr-maps-operations-v9-20260910f.js", "app.js"],
  ["hr-maps-operations-v9-20260910f.css", "styles.css"],
  ["hr-maps-operations-v10-20260911a.js", "app.js"],
  ["hr-maps-operations-v10-20260911a.css", "styles.css"],
  ["hr-maps-operations-v7-20260825a.js", "app.js"],
  ["hr-maps-operations-v7-20260825a.css", "styles.css"],
  ["hr-maps-operations-v7-20260825b.js", "app.js"],
  ["hr-maps-operations-v7-20260825b.css", "styles.css"],
  ["hr-maps-operations-v7-20260828c.js", "app.js"],
  ["hr-maps-operations-v7-20260828c.css", "styles.css"],
  ["hr-maps-operations-v7-20260901d.js", "app.js"],
  ["hr-maps-operations-v7-20260901d.css", "styles.css"],
  ["hr-maps-operations-v8-20260910a.js", "app.js"],
  ["hr-maps-operations-v8-20260910a.css", "styles.css"],
]);
const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = 7;
const ROLES = new Set(["admin", "recruiter", "viewer"]);
const STAGES = new Set(["sourced", "contacted", "screening", "interview", "offer", "hired", "talent_pool", "closed"]);
const ACTIVITY_TYPES = new Set([
  "application_received", "resume_reviewed", "interview_scheduled", "interview_conducted",
  "dm_sent", "dm_accepted", "dm_followup", "past_pool_reviewed", "past_pool_contacted",
  "reinterview_scheduled", "offer_coordination", "hired", "other"
]);
const SOURCES = new Set(["saramin", "dm", "past_pool", "referral", "jobkorea", "mixed", "other"]);
const PRIORITIES = new Set(["1순위", "2순위", "3순위"]);
const GOAL_STATUSES = new Set(["active", "on_hold", "completed", "closed"]);
const JOB_POSTING_STATUSES = new Set(["active", "closed", "draft"]);
const INTERVIEW_STATUSES = new Set(["scheduled", "completed", "cancelled", "no_show"]);
const INTERVIEW_RESULTS = new Set(["pending", "pass", "hold", "fail", "withdrawn", "no_show"]);
const REJECTION_REASONS = new Set(["", "경력 부족", "직무 부적합", "연봉 불일치", "조직 적합성", "지원 철회", "타사 합격", "연락 두절", "면접 불참", "기타"]);
const MEETING_STATUSES = new Set(["scheduled", "completed", "cancelled"]);
const ACTION_STATUSES = new Set(["open", "in_progress", "review", "completed", "cancelled"]);
const ACTION_PRIORITIES = new Set(["urgent", "high", "normal", "low"]);
const NOTIFICATION_SCOPES = new Set(["personal", "all"]);
const SARAMIN_COMPANY_PAGE = "https://www.saramin.co.kr/zf_user/company-info/view-inner-recruit/csn/MDZMSlhFT1ZrV3RZZXU5YjArOHo4Zz09/company_nm/%28%EC%A3%BC%29%EB%A9%94%EB%93%9C%ED%8C%8C%ED%81%AC";
const SARAMIN_SYNC_INTERVAL_MS = 3 * 60 * 60 * 1000;
const loginAttempts = new Map();
let saraminSyncInFlight = null;

function resolveDataDir() {
  const preferred = process.env.DATA_DIR || "/app/user_data";
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    const fallback = join(ROOT, ".data");
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

const dataDir = resolveDataDir();
const db = new Database(process.env.SQLITE_PATH || join(dataDir, "medpark-hr-maps.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin','recruiter','viewer')),
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users(email) WHERE email IS NOT NULL AND email <> '';
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS requisitions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    target_date TEXT,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS candidates_name_idx ON candidates(name);
  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    requisition_id TEXT REFERENCES requisitions(id) ON DELETE SET NULL,
    stage TEXT NOT NULL,
    outcome TEXT,
    is_talent_pool INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS applications_stage_idx ON applications(stage, outcome);
  CREATE INDEX IF NOT EXISTS applications_candidate_idx ON applications(candidate_id);
  CREATE TABLE IF NOT EXISTS interviews (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    scheduled_at TEXT,
    status TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS interviews_schedule_idx ON interviews(scheduled_at, status);
  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    actor_username TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS activity_logs_time_idx ON activity_logs(occurred_at DESC);
  CREATE TABLE IF NOT EXISTS recruiting_activities (
    id TEXT PRIMARY KEY,
    activity_date TEXT NOT NULL,
    department TEXT NOT NULL,
    position TEXT NOT NULL,
    requisition_id TEXT REFERENCES requisitions(id) ON DELETE SET NULL,
    candidate_id TEXT REFERENCES candidates(id) ON DELETE SET NULL,
    application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
    activity_type TEXT NOT NULL,
    source TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 0),
    accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
    candidate_name TEXT,
    owner_username TEXT,
    owner_name TEXT NOT NULL,
    details TEXT,
    next_action_at TEXT,
    created_by_username TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS recruiting_activities_date_idx ON recruiting_activities(activity_date, activity_type);
  CREATE INDEX IF NOT EXISTS recruiting_activities_owner_idx ON recruiting_activities(owner_name, activity_date);
  CREATE INDEX IF NOT EXISTS recruiting_activities_req_idx ON recruiting_activities(requisition_id, activity_date);
  CREATE TABLE IF NOT EXISTS candidate_activities (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
    recruiting_activity_id TEXT UNIQUE,
    activity_date TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    stage_after TEXT,
    outcome TEXT,
    summary TEXT NOT NULL,
    next_activity TEXT,
    next_action_at TEXT,
    target_date TEXT,
    previous_state_json TEXT NOT NULL DEFAULT '{}',
    created_by_username TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS candidate_activities_candidate_idx ON candidate_activities(candidate_id, activity_date DESC, created_at DESC);
  CREATE INDEX IF NOT EXISTS candidate_activities_application_idx ON candidate_activities(application_id, activity_date DESC, created_at DESC);
  CREATE TABLE IF NOT EXISTS goal_checkpoints (
    id TEXT PRIMARY KEY,
    requisition_id TEXT NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
    checkpoint_date TEXT NOT NULL,
    progress_percent INTEGER NOT NULL DEFAULT 0,
    review_status TEXT NOT NULL DEFAULT 'reviewed',
    summary TEXT NOT NULL,
    risks TEXT,
    backup_plan TEXT,
    previous_target_date TEXT,
    revised_target_date TEXT,
    created_by_username TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS goal_checkpoints_req_idx ON goal_checkpoints(requisition_id, checkpoint_date DESC, created_at DESC);
  CREATE TABLE IF NOT EXISTS report_snapshots (
    id TEXT PRIMARY KEY,
    period_type TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    note TEXT,
    closed_by_username TEXT NOT NULL,
    closed_by_name TEXT NOT NULL,
    closed_at TEXT NOT NULL,
    UNIQUE(period_type, period_start, period_end)
  );
  CREATE TABLE IF NOT EXISTS job_postings (
    id TEXT PRIMARY KEY,
    saramin_id TEXT UNIQUE,
    title TEXT NOT NULL,
    department TEXT,
    location TEXT,
    experience TEXT,
    job_type TEXT,
    education TEXT,
    opening_date TEXT,
    expiration_date TEXT,
    close_type TEXT NOT NULL DEFAULT '접수마감일',
    url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','draft')),
    view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
    apply_count INTEGER NOT NULL DEFAULT 0 CHECK (apply_count >= 0),
    requisition_id TEXT REFERENCES requisitions(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    last_synced_at TEXT,
    created_by_username TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS job_postings_status_idx ON job_postings(status, expiration_date, opening_date);
  CREATE INDEX IF NOT EXISTS job_postings_req_idx ON job_postings(requisition_id, status);
  CREATE TABLE IF NOT EXISTS workforce_plans (
    id TEXT PRIMARY KEY,
    department TEXT NOT NULL,
    position TEXT NOT NULL,
    approved_headcount INTEGER NOT NULL DEFAULT 0 CHECK (approved_headcount >= 0),
    current_headcount INTEGER NOT NULL DEFAULT 0 CHECK (current_headcount >= 0),
    recruiting_to INTEGER NOT NULL DEFAULT 0 CHECK (recruiting_to >= 0),
    joining_planned INTEGER NOT NULL DEFAULT 0 CHECK (joining_planned >= 0),
    leaving_planned INTEGER NOT NULL DEFAULT 0 CHECK (leaving_planned >= 0),
    as_of_date TEXT NOT NULL,
    note TEXT,
    created_by_username TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workforce_department_idx ON workforce_plans(department, position);
  CREATE TABLE IF NOT EXISTS hr_meetings (
    id TEXT PRIMARY KEY,
    meeting_date TEXT NOT NULL,
    title TEXT NOT NULL,
    agenda TEXT,
    minutes TEXT,
    key_discussions TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
    created_by_username TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    updated_by_username TEXT NOT NULL,
    updated_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS hr_meetings_date_idx ON hr_meetings(meeting_date DESC, status);
  CREATE TABLE IF NOT EXISTS action_items (
    id TEXT PRIMARY KEY,
    meeting_id TEXT REFERENCES hr_meetings(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    details TEXT,
    assignee_username TEXT REFERENCES users(username) ON DELETE SET NULL,
    assignee_name TEXT,
    due_date TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','review','completed','cancelled')),
    notification_scope TEXT NOT NULL DEFAULT 'personal' CHECK (notification_scope IN ('personal','all')),
    created_by_username TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS action_items_due_idx ON action_items(status, due_date, assignee_username);
  CREATE INDEX IF NOT EXISTS action_items_meeting_idx ON action_items(meeting_id, created_at);
`);

ensureColumn("users", "department", "TEXT");
ensureColumn("requisitions", "original_target_date", "TEXT");
ensureColumn("requisitions", "checkpoint_date", "TEXT");
ensureColumn("requisitions", "revised_target_date", "TEXT");
ensureColumn("requisitions", "backup_plan", "TEXT");
ensureColumn("requisitions", "goal_status", "TEXT NOT NULL DEFAULT 'active'");
ensureColumn("recruiting_activities", "candidate_id", "TEXT REFERENCES candidates(id) ON DELETE SET NULL");
ensureColumn("recruiting_activities", "application_id", "TEXT REFERENCES applications(id) ON DELETE SET NULL");
ensureColumn("recruiting_activities", "interview_location", "TEXT");
ensureColumn("recruiting_activities", "interviewer_names", "TEXT");
ensureColumn("recruiting_activities", "interview_round", "INTEGER");
ensureColumn("recruiting_activities", "interview_duration", "INTEGER");
ensureColumn("recruiting_activities", "interview_status", "TEXT");
ensureColumn("recruiting_activities", "interview_result", "TEXT");
ensureColumn("recruiting_activities", "rejection_reason", "TEXT");
ensureColumn("recruiting_activities", "result_notes", "TEXT");
ensureColumn("recruiting_activities", "previous_state_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("workforce_plans", "current_members", "TEXT");
ensureColumn("workforce_plans", "recruit_plan", "TEXT");
ensureColumn("workforce_plans", "as_is_tasks", "TEXT");
ensureColumn("workforce_plans", "to_be_tasks", "TEXT");
ensureColumn("workforce_plans", "future_plan", "TEXT");
ensureColumn("hr_meetings", "participants", "TEXT");
ensureColumn("hr_meetings", "transcript", "TEXT");
ensureColumn("hr_meetings", "decisions", "TEXT");
ensureColumn("hr_meetings", "issues", "TEXT");
ensureColumn("hr_meetings", "analysis_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("hr_meetings", "analysis_status", "TEXT NOT NULL DEFAULT 'draft'");
ensureColumn("hr_meetings", "analysis_confirmed_at", "TEXT");
ensureColumn("hr_meetings", "analysis_confirmed_by", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS recruiting_activities_candidate_idx ON recruiting_activities(candidate_id, activity_date)");

seedWorkbookData();
seedOperationsData();
seedWorkforcePlans();
db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
const setupToken = ensureSetupToken();

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function seedWorkbookData() {
  const current = db.prepare("SELECT value FROM app_meta WHERE key='seed_version'").get();
  if (current?.value === SEED_VERSION) return;
  const now = new Date().toISOString();
  const insertReq = db.prepare("INSERT OR IGNORE INTO requisitions (id,status,priority,target_date,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
  const insertCandidate = db.prepare("INSERT OR IGNORE INTO candidates (id,name,data_json,created_at,updated_at) VALUES (?,?,?,?,?)");
  const insertApplication = db.prepare("INSERT OR IGNORE INTO applications (id,candidate_id,requisition_id,stage,outcome,is_talent_pool,archived_at,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const insertInterview = db.prepare("INSERT OR IGNORE INTO interviews (id,application_id,scheduled_at,status,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
  db.transaction(() => {
    for (const row of seedRequisitions) insertReq.run(row.id, row.status || "open", row.priority || "2순위", row.targetDate || null, JSON.stringify(row), now, now);
    for (const row of seedCandidates) insertCandidate.run(row.id, row.name, JSON.stringify(row), now, now);
    for (const row of seedApplications) insertApplication.run(row.id, row.candidateId, row.requisitionId || null, row.stage || "sourced", row.outcome || null, row.isTalentPool ? 1 : 0, row.archivedAt || null, JSON.stringify(row), now, now);
    for (const row of seedInterviews) insertInterview.run(row.id, row.applicationId, row.scheduledAt || null, row.status || "scheduled", JSON.stringify(row), now, now);
    db.prepare("INSERT INTO activity_logs (kind,summary,actor_username,actor_name,occurred_at,details_json) VALUES (?,?,?,?,?,?)")
      .run("import", "기존 HR 엑셀 데이터 1차 이관", "system", "시스템", now, JSON.stringify({ candidates: seedCandidates.length, applications: seedApplications.length, interviews: seedInterviews.length }));
    setMeta("seed_version", SEED_VERSION, now);
  })();
}

function seedOperationsData() {
  const current = db.prepare("SELECT value FROM app_meta WHERE key='operations_seed_version'").get();
  if (current?.value === OPERATIONS_SEED_VERSION) return;
  const now = new Date().toISOString();
  const insertActivity = db.prepare(`INSERT OR IGNORE INTO recruiting_activities
    (id,activity_date,department,position,requisition_id,activity_type,source,count,accepted_count,candidate_name,owner_username,owner_name,details,next_action_at,created_by_username,created_by_name,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const seed of seedRequisitions) {
      const currentRow = db.prepare("SELECT data_json FROM requisitions WHERE id=?").get(seed.id);
      if (!currentRow) continue;
      const data = {
        ...parseJson(currentRow.data_json),
        originalTargetDate: parseJson(currentRow.data_json).originalTargetDate || seed.targetDate || null,
        checkpointDate: parseJson(currentRow.data_json).checkpointDate || seed.midCheckAt || null,
        currentTargetDate: parseJson(currentRow.data_json).currentTargetDate || seed.targetDate || null,
        backupPlan: parseJson(currentRow.data_json).backupPlan || "",
        goalStatus: parseJson(currentRow.data_json).goalStatus || "active"
      };
      db.prepare(`UPDATE requisitions SET
        original_target_date=COALESCE(original_target_date,?),
        checkpoint_date=COALESCE(checkpoint_date,?),
        backup_plan=COALESCE(backup_plan,''),
        goal_status=COALESCE(goal_status,'active'),
        data_json=? WHERE id=?`)
        .run(seed.targetDate || null, seed.midCheckAt || null, JSON.stringify(data), seed.id);
    }
    for (const row of augustActivities) {
      insertActivity.run(
        row.id, row.activityDate, row.department, row.position, row.requisitionId || null,
        row.activityType, row.source || "other", integer(row.count, 1), integer(row.acceptedCount, 0),
        row.candidateName || null, null, row.ownerName || "HR TF", row.details || null,
        row.nextActionAt || null, "system", "엑셀 이관", now, now
      );
    }
    db.prepare("INSERT INTO activity_logs (kind,summary,actor_username,actor_name,occurred_at,details_json) VALUES (?,?,?,?,?,?)")
      .run("operations_import", "2026년 8월 유효 채용활동 이관", "system", "시스템", now, JSON.stringify({ activities: augustActivities.length, goals: seedRequisitions.length }));
    setMeta("operations_seed_version", OPERATIONS_SEED_VERSION, now);
  })();
}

function seedWorkforcePlans() {
  const count = db.prepare("SELECT COUNT(*) AS value FROM workforce_plans").get().value;
  if (count > 0) return;
  const now = new Date().toISOString();
  const today = isoToday();
  const insert = db.prepare(`INSERT OR IGNORE INTO workforce_plans
    (id,department,position,approved_headcount,current_headcount,recruiting_to,joining_planned,leaving_planned,as_of_date,note,created_by_username,created_by_name,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const goal of getRequisitions()) {
      insert.run(
        `workforce-${goal.id}`,
        goal.division || "부서 미지정",
        goal.functionName || goal.title || "포지션 미지정",
        0,
        0,
        Math.max(0, integer(goal.targetHeadcount, 1, 1000)),
        0,
        0,
        today,
        "기존 채용목표의 TO를 연동했습니다. 정원·현원을 입력해 주세요.",
        "system",
        "기존 목표 연동",
        now,
        now
      );
    }
  })();
}

function setMeta(key, value, now = new Date().toISOString()) {
  db.prepare("INSERT INTO app_meta (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(key, value, now);
}

function ensureSetupToken() {
  const userCount = db.prepare("SELECT COUNT(*) AS value FROM users").get().value;
  if (userCount > 0) return null;
  const configured = String(process.env.SETUP_TOKEN || "").trim();
  if (configured) return configured;
  const stored = db.prepare("SELECT value FROM app_meta WHERE key='setup_token'").get();
  if (stored?.value) return stored.value;
  const token = randomBytes(24).toString("base64url");
  setMeta("setup_token", token);
  return token;
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}

function verifyPassword(password, user) {
  const expected = Buffer.from(user.password_hash, "hex");
  const actual = scryptSync(password, user.password_salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 10) throw httpError(400, "비밀번호는 10자 이상이어야 합니다.");
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw httpError(400, "비밀번호에는 영문과 숫자를 모두 포함하세요.");
}

function normalizeUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw httpError(400, "아이디는 영문 소문자·숫자·._- 조합 3~40자로 입력하세요.");
  return username;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "올바른 이메일을 입력하세요.");
  return email || null;
}

function createSession(username) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare("INSERT INTO sessions (token_hash,username,expires_at,created_at) VALUES (?,?,?,?)")
    .run(sha256(token), username, expires.toISOString(), now.toISOString());
  return { token, expires };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function actorFromRequest(req) {
  const token = cookieValue(req, "hr_session");
  if (!token) return null;
  return db.prepare(`SELECT u.username,u.display_name AS name,u.email,u.role,u.department,u.active,u.must_change_password AS mustChangePassword
    FROM sessions s JOIN users u ON u.username=s.username
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(sha256(token), new Date().toISOString()) || null;
}

function requireActor(req) {
  const actor = actorFromRequest(req);
  if (!actor) throw httpError(401, "로그인이 필요합니다.");
  return actor;
}

function requireWrite(actor) {
  if (!actor || !["admin", "recruiter"].includes(actor.role)) throw httpError(403, "수정 권한이 없습니다.");
}

function requireAdmin(actor) {
  if (!actor || actor.role !== "admin") throw httpError(403, "관리자만 사용할 수 있습니다.");
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function textValue(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function integer(value, fallback = 0, max = 100000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(max, Math.round(number)));
}

function dateValue(value, required = false) {
  const date = String(value || "").trim();
  if (!date && !required) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw httpError(400, "날짜 형식은 YYYY-MM-DD로 입력하세요.");
  return date;
}

function dateTimeValue(value) {
  const date = String(value || "").trim();
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(date) || Number.isNaN(Date.parse(date))) throw httpError(400, "일시 형식을 확인하세요.");
  return date.slice(0, 16);
}

function isoToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function dateFromYmd(value) {
  return new Date(`${value}T00:00:00Z`);
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value, amount) {
  const date = dateFromYmd(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return ymd(date);
}

function monthEnd(value) {
  const [year, month] = value.split("-").map(Number);
  return ymd(new Date(Date.UTC(year, month, 0)));
}

function daysBetween(from, to) {
  return Math.round((dateFromYmd(to) - dateFromYmd(from)) / 86400000);
}

function rangeFromUrl(url) {
  const today = isoToday();
  const from = dateValue(url.searchParams.get("from")) || `${today.slice(0, 7)}-01`;
  const to = dateValue(url.searchParams.get("to")) || monthEnd(today);
  if (from > to) throw httpError(400, "조회 시작일은 종료일보다 늦을 수 없습니다.");
  if (daysBetween(from, to) > 366) throw httpError(400, "조회 기간은 최대 1년입니다.");
  return { from, to };
}

function maskPersonName(value) {
  const chars = [...String(value || "").trim()];
  if (!chars.length) return "비공개";
  if (chars.length === 1) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(Math.min(2, chars.length - 1))}`;
}

function getRequisitions() {
  return db.prepare("SELECT * FROM requisitions ORDER BY priority,target_date,id").all().map((row) => {
    const data = parseJson(row.data_json);
    const originalTargetDate = row.original_target_date || data.originalTargetDate || data.targetDate || row.target_date || null;
    const revisedTargetDate = row.revised_target_date || data.revisedTargetDate || null;
    return {
      ...data,
      id: row.id,
      status: row.status,
      goalStatus: row.goal_status || data.goalStatus || "active",
      priority: row.priority,
      originalTargetDate,
      checkpointDate: row.checkpoint_date || data.checkpointDate || data.midCheckAt || null,
      revisedTargetDate,
      targetDate: revisedTargetDate || row.target_date || data.targetDate || null,
      backupPlan: row.backup_plan || data.backupPlan || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

function getApplicationsByRequisition() {
  const grouped = new Map();
  for (const row of db.prepare("SELECT requisition_id,stage,outcome,archived_at FROM applications WHERE requisition_id IS NOT NULL").all()) {
    if (!grouped.has(row.requisition_id)) grouped.set(row.requisition_id, []);
    grouped.get(row.requisition_id).push(row);
  }
  return grouped;
}

function getLatestCheckpoints() {
  const rows = db.prepare("SELECT * FROM goal_checkpoints ORDER BY checkpoint_date DESC,created_at DESC").all();
  const map = new Map();
  for (const row of rows) if (!map.has(row.requisition_id)) map.set(row.requisition_id, checkpointRecord(row));
  return map;
}

function checkpointRecord(row) {
  return {
    id: row.id,
    requisitionId: row.requisition_id,
    checkpointDate: row.checkpoint_date,
    progressPercent: integer(row.progress_percent),
    reviewStatus: row.review_status,
    summary: row.summary,
    risks: row.risks || "",
    backupPlan: row.backup_plan || "",
    previousTargetDate: row.previous_target_date,
    revisedTargetDate: row.revised_target_date,
    createdByUsername: row.created_by_username,
    createdByName: row.created_by_name,
    createdAt: row.created_at
  };
}

function buildGoals() {
  const today = isoToday();
  const applications = getApplicationsByRequisition();
  const latestCheckpoints = getLatestCheckpoints();
  const weights = { sourced: 10, contacted: 20, screening: 35, talent_pool: 15, interview: 55, offer: 80, hired: 100, closed: 0 };
  return getRequisitions().map((goal) => {
    const target = Math.max(1, integer(goal.targetHeadcount, 1, 1000));
    const rows = applications.get(goal.id) || [];
    const scores = rows.map((row) => weights[row.stage] || 0).sort((a, b) => b - a).slice(0, target);
    while (scores.length < target) scores.push(0);
    const autoProgress = Math.round(scores.reduce((sum, value) => sum + value, 0) / target);
    const latestCheckpoint = latestCheckpoints.get(goal.id) || null;
    const progress = Math.max(autoProgress, latestCheckpoint?.progressPercent || 0);
    const currentTargetDate = goal.targetDate;
    const checkpointDone = latestCheckpoint && (!goal.checkpointDate || latestCheckpoint.checkpointDate >= goal.checkpointDate);
    let riskStatus = "on_track";
    if (goal.goalStatus === "completed" || progress >= 100) riskStatus = "completed";
    else if (goal.goalStatus === "on_hold") riskStatus = "on_hold";
    else if (currentTargetDate && currentTargetDate < today) riskStatus = "overdue";
    else if (goal.checkpointDate && goal.checkpointDate <= today && !checkpointDone) riskStatus = "checkpoint_due";
    else if (currentTargetDate && daysBetween(today, currentTargetDate) <= 7 && progress < 60) riskStatus = "risk";
    const stageCounts = {};
    for (const row of rows) stageCounts[row.stage] = (stageCounts[row.stage] || 0) + 1;
    return {
      ...goal,
      targetHeadcount: target,
      autoProgress,
      progress,
      riskStatus,
      filledCount: stageCounts.hired || 0,
      stageCounts,
      latestCheckpoint
    };
  });
}

function activityRecord(row) {
  return {
    id: row.id,
    activityDate: row.activity_date,
    department: row.department,
    position: row.position,
    requisitionId: row.requisition_id,
    candidateId: row.candidate_id,
    applicationId: row.application_id,
    activityType: row.activity_type,
    source: row.source,
    count: integer(row.count),
    acceptedCount: integer(row.accepted_count),
    candidateName: row.candidate_name,
    ownerUsername: row.owner_username,
    ownerName: row.owner_name,
    details: row.details || "",
    nextActionAt: row.next_action_at,
    interviewLocation: row.interview_location || "",
    interviewerNames: row.interviewer_names || "",
    interviewRound: integer(row.interview_round, 1, 10),
    interviewDuration: integer(row.interview_duration, 60, 480),
    interviewStatus: row.interview_status || "",
    interviewResult: row.interview_result || "",
    rejectionReason: row.rejection_reason || "",
    resultNotes: row.result_notes || "",
    nextActivity: row.candidate_next_activity || "",
    targetDate: row.candidate_target_date || null,
    createdByUsername: row.created_by_username,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getRecruitingActivities(from, to) {
  return db.prepare(`SELECT ra.*,ca.next_activity AS candidate_next_activity,ca.target_date AS candidate_target_date
    FROM recruiting_activities ra LEFT JOIN candidate_activities ca ON ca.recruiting_activity_id=ra.id
    WHERE ra.activity_date BETWEEN ? AND ? ORDER BY ra.activity_date DESC,ra.created_at DESC,ra.id DESC LIMIT 1200`)
    .all(from, to).map(activityRecord);
}

function workforceRecord(row) {
  return {
    id: row.id,
    department: row.department,
    position: row.position,
    approvedHeadcount: integer(row.approved_headcount),
    currentHeadcount: integer(row.current_headcount),
    recruitingTo: integer(row.recruiting_to),
    joiningPlanned: integer(row.joining_planned),
    leavingPlanned: integer(row.leaving_planned),
    asOfDate: row.as_of_date,
    note: row.note || "",
    currentMembers: row.current_members || "",
    recruitPlan: row.recruit_plan || "",
    asIsTasks: row.as_is_tasks || "",
    toBeTasks: row.to_be_tasks || "",
    futurePlan: row.future_plan || "",
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getWorkforcePlans() {
  return db.prepare("SELECT * FROM workforce_plans ORDER BY department,position,id").all().map(workforceRecord);
}

function workforceOverview(rows = getWorkforcePlans()) {
  const totals = rows.reduce((sum, row) => ({
    approvedHeadcount: sum.approvedHeadcount + row.approvedHeadcount,
    currentHeadcount: sum.currentHeadcount + row.currentHeadcount,
    recruitingTo: sum.recruitingTo + row.recruitingTo,
    joiningPlanned: sum.joiningPlanned + row.joiningPlanned,
    leavingPlanned: sum.leavingPlanned + row.leavingPlanned
  }), { approvedHeadcount: 0, currentHeadcount: 0, recruitingTo: 0, joiningPlanned: 0, leavingPlanned: 0 });
  const byDepartment = new Map();
  for (const row of rows) {
    if (!byDepartment.has(row.department)) byDepartment.set(row.department, { department: row.department, approvedHeadcount: 0, currentHeadcount: 0, recruitingTo: 0, joiningPlanned: 0, leavingPlanned: 0, positions: 0 });
    const item = byDepartment.get(row.department);
    item.approvedHeadcount += row.approvedHeadcount;
    item.currentHeadcount += row.currentHeadcount;
    item.recruitingTo += row.recruitingTo;
    item.joiningPlanned += row.joiningPlanned;
    item.leavingPlanned += row.leavingPlanned;
    item.positions += 1;
  }
  const enrich = (item) => ({
    ...item,
    projectedHeadcount: item.currentHeadcount + item.joiningPlanned - item.leavingPlanned,
    vacancy: Math.max(0, item.approvedHeadcount - (item.currentHeadcount + item.joiningPlanned - item.leavingPlanned)),
    fillRate: metricRate(item.currentHeadcount, item.approvedHeadcount)
  });
  return {
    ...enrich(totals),
    baselineRows: rows.filter((row) => row.approvedHeadcount > 0 || row.currentHeadcount > 0).length,
    totalRows: rows.length,
    asOfDate: rows.map((row) => row.asOfDate).filter(Boolean).sort().at(-1) || null,
    byDepartment: [...byDepartment.values()].map(enrich).sort((a, b) => b.recruitingTo - a.recruitingTo || b.currentHeadcount - a.currentHeadcount || a.department.localeCompare(b.department, "ko"))
  };
}

function meetingRecord(row) {
  let analysis = {};
  try { analysis = JSON.parse(row.analysis_json || "{}"); } catch { analysis = {}; }
  return {
    id: row.id,
    meetingDate: row.meeting_date,
    title: row.title,
    agenda: row.agenda || "",
    minutes: row.minutes || "",
    keyDiscussions: row.key_discussions || "",
    participants: row.participants || "",
    transcript: row.transcript || "",
    decisions: row.decisions || "",
    issues: row.issues || "",
    analysis,
    analysisStatus: row.analysis_status || "draft",
    analysisConfirmedAt: row.analysis_confirmed_at || null,
    analysisConfirmedBy: row.analysis_confirmed_by || "",
    status: row.status,
    createdByName: row.created_by_name,
    updatedByName: row.updated_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getMeetings() {
  return db.prepare("SELECT * FROM hr_meetings ORDER BY meeting_date DESC,created_at DESC LIMIT 160").all().map(meetingRecord);
}

function actionItemRecord(row) {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    title: row.title,
    details: row.details || "",
    assigneeUsername: row.assignee_username,
    assigneeName: row.assignee_name || "미지정",
    dueDate: row.due_date,
    priority: row.priority,
    status: row.status,
    notificationScope: row.notification_scope,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getActionItems() {
  return db.prepare(`SELECT * FROM action_items
    ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'review' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END,
      due_date, CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at DESC LIMIT 400`).all().map(actionItemRecord);
}

function buildMyWork(actor, actions) {
  if (!actor) return null;
  const today = isoToday();
  const weekEnd = addDays(today, 6);
  const active = actions.filter((row) => !["completed", "cancelled"].includes(row.status));
  const mine = active.filter((row) => row.notificationScope === "all" || row.assigneeUsername === actor.username);
  return {
    today: mine.filter((row) => row.dueDate === today),
    week: mine.filter((row) => row.dueDate >= today && row.dueDate <= weekEnd),
    overdue: mine.filter((row) => row.dueDate < today),
    review: mine.filter((row) => row.status === "review"),
    open: mine,
    allNotifications: active.filter((row) => row.notificationScope === "all").length
  };
}

function classifyRejectionReason(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/경력|연차|경험 부족/.test(text)) return "경력 부족";
  if (/직무|역량|스킬|자격/.test(text)) return "직무 부적합";
  if (/연봉|처우|급여/.test(text)) return "연봉 불일치";
  if (/조직|컬처|인성|태도/.test(text)) return "조직 적합성";
  if (/지원.?철회|입사.?포기|본인.?포기|거절/.test(text)) return "지원 철회";
  if (/타사|다른 회사/.test(text)) return "타사 합격";
  if (/연락.?두절|무응답|no.?response/i.test(text)) return "연락 두절";
  if (/불참|no.?show/i.test(text)) return "면접 불참";
  return "기타";
}

function rejectionReasonSummary() {
  const explicitByApplication = new Map();
  for (const row of db.prepare("SELECT application_id,rejection_reason FROM recruiting_activities WHERE application_id IS NOT NULL AND rejection_reason IS NOT NULL AND rejection_reason<>'' ORDER BY activity_date DESC,updated_at DESC").all()) {
    if (!explicitByApplication.has(row.application_id)) explicitByApplication.set(row.application_id, row.rejection_reason);
  }
  const counts = new Map();
  for (const row of db.prepare("SELECT id,stage,outcome,data_json FROM applications").all()) {
    const data = parseJson(row.data_json);
    const raw = explicitByApplication.get(row.id) || row.outcome || data.outcome || data.finalResult || data.firstResult || "";
    if (!raw || (row.stage !== "closed" && !/불합격|탈락|철회|포기|거절|불참|두절/.test(String(raw)))) continue;
    const reason = REJECTION_REASONS.has(raw) && raw ? raw : classifyRejectionReason(raw);
    if (reason) counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, "ko"));
}

function candidateActivityRecord(row) {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    applicationId: row.application_id,
    recruitingActivityId: row.recruiting_activity_id,
    activityDate: row.activity_date,
    activityType: row.activity_type,
    stageAfter: row.stage_after,
    outcome: row.outcome || "",
    summary: row.summary,
    nextActivity: row.next_activity || "",
    nextActionAt: row.next_action_at,
    targetDate: row.target_date,
    createdByUsername: row.created_by_username,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    origin: "candidate",
    editable: true
  };
}

function candidatePipelineRows() {
  const latestByApplication = new Map();
  for (const row of db.prepare("SELECT * FROM candidate_activities ORDER BY activity_date DESC,created_at DESC,id DESC").all()) {
    if (row.application_id && !latestByApplication.has(row.application_id)) latestByApplication.set(row.application_id, candidateActivityRecord(row));
  }
  const rows = db.prepare(`SELECT a.*,c.name AS candidate_name,c.data_json AS candidate_data,
    r.priority AS requisition_priority,r.target_date AS requisition_target_date,r.data_json AS requisition_data
    FROM applications a
    JOIN candidates c ON c.id=a.candidate_id
    LEFT JOIN requisitions r ON r.id=a.requisition_id
    ORDER BY CASE WHEN a.archived_at IS NULL AND a.stage NOT IN ('closed','hired') THEN 0 WHEN a.stage='talent_pool' THEN 1 ELSE 2 END,
      a.updated_at DESC,a.id DESC LIMIT 500`).all();
  const today = isoToday();
  return rows.map((row) => {
    const candidate = parseJson(row.candidate_data) || {};
    const application = parseJson(row.data_json) || {};
    const goal = parseJson(row.requisition_data) || {};
    const latest = latestByApplication.get(row.id) || null;
    const nextActionAt = latest?.nextActionAt ?? application.nextActionAt ?? null;
    const targetDate = latest?.targetDate ?? application.targetDate ?? row.requisition_target_date ?? goal.targetDate ?? null;
    const stage = latest?.stageAfter || row.stage || application.stage || "sourced";
    const terminal = ["closed", "hired"].includes(stage) || Boolean(row.archived_at);
    const dueDate = nextActionAt ? String(nextActionAt).slice(0, 10) : null;
    let scheduleStatus = "normal";
    if (!terminal && dueDate && dueDate < today) scheduleStatus = "overdue";
    else if (!terminal && dueDate && dueDate <= addDays(today, 3)) scheduleStatus = "due";
    else if (!terminal && targetDate && targetDate < today) scheduleStatus = "target_overdue";
    return {
      applicationId: row.id,
      candidateId: row.candidate_id,
      candidateName: row.candidate_name,
      gender: candidate.gender || "",
      age: candidate.age || null,
      experienceText: candidate.experienceText || "",
      currentCompany: candidate.currentCompany || "",
      currentTitle: candidate.currentTitle || "",
      requisitionId: row.requisition_id,
      priority: row.requisition_priority || goal.priority || "",
      division: goal.division || "",
      position: goal.functionName || goal.title || application.legacyPosition || "포지션 미연결",
      level: goal.level || "",
      sourceChannel: application.sourceChannel || application.sourceDetail || "기타",
      stage,
      outcome: latest?.outcome || row.outcome || application.outcome || "",
      ownerName: application.ownerName || "미지정",
      lastActivityAt: latest?.activityDate || application.lastActivityAt || row.updated_at,
      lastActivity: latest?.summary || application.contactResult || application.firstResult || application.memo || "기존 이력 이관",
      nextActivity: latest?.nextActivity ?? application.nextActivity ?? "",
      nextActionAt,
      targetDate,
      scheduleStatus,
      isTalentPool: Boolean(row.is_talent_pool) || stage === "talent_pool",
      archivedAt: row.archived_at
    };
  });
}

function candidatePipelineSummary(rows) {
  const byStage = {};
  for (const row of rows) byStage[row.stage] = (byStage[row.stage] || 0) + 1;
  return {
    total: rows.length,
    active: rows.filter((row) => !row.archivedAt && !["closed", "hired"].includes(row.stage)).length,
    talentPool: rows.filter((row) => row.isTalentPool).length,
    interview: rows.filter((row) => row.stage === "interview").length,
    offer: rows.filter((row) => row.stage === "offer").length,
    overdue: rows.filter((row) => ["overdue", "target_overdue"].includes(row.scheduleStatus)).length,
    dueSoon: rows.filter((row) => row.scheduleStatus === "due").length,
    byStage
  };
}

function candidateDetail(candidateId) {
  const row = db.prepare("SELECT * FROM candidates WHERE id=?").get(candidateId);
  if (!row) throw httpError(404, "후보자를 찾을 수 없습니다.");
  const profile = parseJson(row.data_json) || {};
  const pipeline = candidatePipelineRows().filter((item) => item.candidateId === candidateId);
  const applicationRows = db.prepare("SELECT * FROM applications WHERE candidate_id=? ORDER BY updated_at DESC,id DESC").all(candidateId);
  const applicationIds = new Set(applicationRows.map((item) => item.id));
  const timeline = db.prepare("SELECT * FROM candidate_activities WHERE candidate_id=? ORDER BY activity_date DESC,created_at DESC,id DESC LIMIT 300")
    .all(candidateId).map(candidateActivityRecord);
  const linkedRecruitingIds = new Set(timeline.map((item) => item.recruitingActivityId).filter(Boolean));
  const sameNameCount = db.prepare("SELECT COUNT(*) AS value FROM candidates WHERE name=?").get(row.name).value;
  const recruitingRows = sameNameCount === 1
    ? db.prepare("SELECT * FROM recruiting_activities WHERE candidate_id=? OR (candidate_id IS NULL AND candidate_name=?) ORDER BY activity_date DESC,created_at DESC LIMIT 200").all(candidateId, row.name)
    : db.prepare("SELECT * FROM recruiting_activities WHERE candidate_id=? ORDER BY activity_date DESC,created_at DESC LIMIT 200").all(candidateId);
  for (const activity of recruitingRows) {
    if (linkedRecruitingIds.has(activity.id)) continue;
    timeline.push({
      id: `daily-${activity.id}`,
      candidateId,
      applicationId: activity.application_id,
      activityDate: activity.activity_date,
      activityType: activity.activity_type,
      stageAfter: null,
      outcome: activity.interview_result || activity.rejection_reason || "",
      summary: [activity.details || "일일 채용활동 입력", activity.result_notes, activity.rejection_reason ? `불합격 사유: ${activity.rejection_reason}` : ""].filter(Boolean).join(" / "),
      nextActivity: "",
      nextActionAt: activity.next_action_at,
      targetDate: null,
      createdByUsername: activity.created_by_username,
      createdByName: activity.created_by_name,
      createdAt: activity.created_at,
      updatedAt: activity.updated_at,
      origin: "daily",
      editable: false
    });
  }
  const interviews = applicationIds.size
    ? db.prepare(`SELECT i.* FROM interviews i JOIN applications a ON a.id=i.application_id WHERE a.candidate_id=? ORDER BY i.scheduled_at DESC,i.created_at DESC`).all(candidateId)
    : [];
  for (const interview of interviews) {
    const data = parseJson(interview.data_json);
    timeline.push({
      id: `interview-${interview.id}`,
      candidateId,
      applicationId: interview.application_id,
      activityDate: String(interview.scheduled_at || interview.created_at).slice(0, 10),
      activityType: "interview_scheduled",
      stageAfter: "interview",
      outcome: data.result || "",
      summary: `${data.round || 1}차 ${data.mode || "면접"}${data.result ? ` · ${data.result}` : ""}`,
      nextActivity: "",
      nextActionAt: interview.scheduled_at,
      targetDate: null,
      createdByUsername: "system",
      createdByName: "면접일정",
      createdAt: interview.created_at,
      updatedAt: interview.updated_at,
      origin: "interview",
      editable: false
    });
  }
  for (const applicationRow of applicationRows) {
    const data = parseJson(applicationRow.data_json);
    const details = [
      data.sourceChannel ? `유입 ${data.sourceChannel}${data.sourceDateRaw ? `(${data.sourceDateRaw})` : ""}` : "",
      data.contactResult ? `연락 ${data.contactResult}` : "",
      data.firstInterviewRaw || data.firstResult ? `1차 ${[data.firstInterviewRaw, data.firstResult].filter(Boolean).join(" · ")}` : "",
      data.secondInterviewRaw || data.secondResult ? `2차 ${[data.secondInterviewRaw, data.secondResult].filter(Boolean).join(" · ")}` : "",
      data.finalResult ? `최종 ${data.finalResult}` : "",
      data.employmentStatus ? `입사 ${data.employmentStatus}` : "",
      data.memo || data.specialNotes || ""
    ].filter(Boolean);
    if (!details.length) continue;
    timeline.push({
      id: `legacy-${applicationRow.id}`,
      candidateId,
      applicationId: applicationRow.id,
      activityDate: String(data.lastActivityAt || applicationRow.updated_at).slice(0, 10),
      activityType: "other",
      stageAfter: applicationRow.stage,
      outcome: applicationRow.outcome || "",
      summary: details.join(" / "),
      nextActivity: data.nextActivity || "",
      nextActionAt: data.nextActionAt || null,
      targetDate: data.targetDate || null,
      createdByUsername: "system",
      createdByName: "기존 데이터 이관",
      createdAt: applicationRow.created_at,
      updatedAt: applicationRow.updated_at,
      origin: "legacy",
      editable: false
    });
  }
  timeline.sort((a, b) => String(b.activityDate || b.createdAt).localeCompare(String(a.activityDate || a.createdAt)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    candidate: {
      id: row.id,
      name: row.name,
      gender: profile.gender || "",
      age: profile.age || null,
      experienceText: profile.experienceText || "",
      phone: profile.phone || "",
      email: profile.email || "",
      currentCompany: profile.currentCompany || "",
      currentTitle: profile.currentTitle || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at
    },
    applications: pipeline,
    timeline: timeline.slice(0, 400)
  };
}

function metricRow(group, activity) {
  group.entryCount += 1;
  group.totalCount += activity.count;
  if (activity.activityType === "dm_sent") group.dmSent += activity.count;
  if (activity.activityType === "dm_accepted") group.dmAccepted += activity.count;
  group.dmAccepted += activity.acceptedCount;
  if (activity.activityType === "application_received") group.applications += activity.count;
  if (activity.activityType === "resume_reviewed") group.reviews += activity.count;
  if (["interview_scheduled", "reinterview_scheduled"].includes(activity.activityType)) group.interviews += activity.count;
  if (activity.activityType === "reinterview_scheduled") group.reinterviews += activity.count;
  if (activity.activityType === "interview_conducted" || (["interview_scheduled", "reinterview_scheduled"].includes(activity.activityType) && activity.interviewStatus === "completed")) group.interviewsConducted += activity.count;
  if (activity.activityType === "past_pool_reviewed") group.pastReviews += activity.count;
  if (activity.activityType === "past_pool_contacted") group.pastContacts += activity.count;
  if (activity.activityType === "hired") group.hired += activity.count;
  return group;
}

function emptyMetric(label) {
  return { label, entryCount: 0, totalCount: 0, dmSent: 0, dmAccepted: 0, applications: 0, reviews: 0, interviews: 0, reinterviews: 0, interviewsConducted: 0, pastReviews: 0, pastContacts: 0, hired: 0 };
}

function groupedMetrics(activities, keySelector) {
  const map = new Map();
  for (const activity of activities) {
    const key = keySelector(activity) || "미지정";
    if (!map.has(key)) map.set(key, emptyMetric(key));
    metricRow(map.get(key), activity);
  }
  return [...map.values()].sort((a, b) => b.totalCount - a.totalCount || a.label.localeCompare(b.label, "ko"));
}

function buildReport(activities, goals, from, to) {
  const totals = emptyMetric("전체");
  for (const activity of activities) metricRow(totals, activity);
  const typeMap = new Map();
  const sourceMap = new Map();
  for (const activity of activities) {
    typeMap.set(activity.activityType, (typeMap.get(activity.activityType) || 0) + activity.count);
    sourceMap.set(activity.source, (sourceMap.get(activity.source) || 0) + activity.count);
  }
  const byDay = groupedMetrics(activities, (item) => item.activityDate).sort((a, b) => a.label.localeCompare(b.label));
  const byOwner = groupedMetrics(activities, (item) => item.ownerName);
  const byDepartment = groupedMetrics(activities, (item) => item.department);
  const byPosition = groupedMetrics(activities, (item) => item.position);
  const dmAcceptanceRate = totals.dmSent ? Math.round((totals.dmAccepted / totals.dmSent) * 1000) / 10 : 0;
  const atRiskGoals = goals.filter((goal) => ["risk", "overdue", "checkpoint_due"].includes(goal.riskStatus));
  const completedGoals = goals.filter((goal) => goal.riskStatus === "completed");
  const averageProgress = goals.length ? Math.round(goals.reduce((sum, goal) => sum + goal.progress, 0) / goals.length) : 0;
  return {
    from,
    to,
    days: daysBetween(from, to) + 1,
    totals: { ...totals, dmAcceptanceRate },
    typeMix: [...typeMap.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    sourceMix: [...sourceMap.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    byDay,
    byOwner,
    byDepartment,
    byPosition,
    activityDetails: activities.slice(0, 1200),
    goals: {
      total: goals.length,
      active: goals.filter((goal) => !["completed", "closed"].includes(goal.goalStatus)).length,
      completed: completedGoals.length,
      atRisk: atRiskGoals.length,
      checkpointDue: goals.filter((goal) => goal.riskStatus === "checkpoint_due").length,
      averageProgress
    },
    atRiskGoals: atRiskGoals.map((goal) => ({ id: goal.id, title: goal.title, functionName: goal.functionName || goal.title, division: goal.division || "미지정", level: goal.level || "", priority: goal.priority, ownerPrimary: goal.ownerPrimary, progress: goal.progress, riskStatus: goal.riskStatus, checkpointDate: goal.checkpointDate, targetDate: goal.targetDate, backupPlan: goal.backupPlan || goal.latestCheckpoint?.backupPlan || "" })),
    narrative: `채용활동 ${totals.totalCount}건 · DM ${totals.dmSent}건 · 수락 ${totals.dmAccepted}건(${dmAcceptanceRate}%) · 면접수립 ${totals.interviews}건 · 과거후보 재접촉 ${totals.pastContacts}건 · 위험목표 ${atRiskGoals.length}건`
  };
}

function metricRate(numerator, denominator) {
  return denominator ? Math.round((Number(numerator || 0) / Number(denominator)) * 1000) / 10 : 0;
}

function sourceDisplay(value) {
  const raw = textValue(value, 80) || "기타";
  const lower = raw.toLowerCase();
  if (lower.includes("사람인") || lower === "saramin") return "사람인";
  if (lower.includes("잡코리아") || lower === "jobkorea") return "잡코리아";
  if (lower.includes("알바천국")) return "알바천국";
  if (lower === "dm" || lower.includes("다이렉트") || lower.includes("헤드헌팅")) return "DM";
  if (lower.includes("인재풀") || lower.includes("과거") || lower === "past_pool") return "24~26년 인재풀";
  if (lower.includes("추천") || lower === "referral") return "추천";
  if (lower.includes("공고") || lower.includes("지원")) return "공고·지원";
  if (lower === "mixed" || lower.includes("복수")) return "복합";
  if (lower === "other") return "기타";
  return raw;
}

function applicationJourney(row) {
  const data = parseJson(row.data_json) || {};
  const stage = row.stage || data.stage || "sourced";
  const interviewEvidence = [data.firstInterviewRaw, data.firstResult, data.secondInterviewRaw, data.secondResult].some(Boolean);
  const contactEvidence = [data.contactDateRaw, data.contactResult, data.nextActionAt].some(Boolean);
  const firstResult = String(data.firstResult || "").trim();
  const finalResult = String(data.finalResult || "").trim();
  const employmentStatus = String(data.employmentStatus || "").trim();
  const positiveResult = !/불합격|탈락|거절|포기|취소|연락두절|타사합격/.test(`${firstResult} ${finalResult}`)
    && /(^|\s)합격($|\s)|최종합격|제안수락|처우|오퍼/.test(`${firstResult} ${finalResult}`);
  const employmentOffer = /입사예정|입사완료/.test(employmentStatus);
  const actualHire = /입사완료|재직/.test(employmentStatus) && !/입사포기|입사취소|미입사/.test(employmentStatus);
  return {
    data,
    stage,
    source: sourceDisplay(data.sourceChannel || data.sourceDetail || "기타"),
    reviewed: stage !== "sourced" || contactEvidence || interviewEvidence || Boolean(data.memo || data.specialNotes),
    contacted: ["contacted", "screening", "interview", "offer", "hired", "closed"].includes(stage) || contactEvidence || interviewEvidence,
    interviewed: ["interview", "offer", "hired"].includes(stage) || interviewEvidence,
    offered: ["offer", "hired"].includes(stage) || positiveResult || employmentOffer,
    hired: stage === "hired" || actualHire
  };
}

function applicationFunnelRows(activities) {
  const map = new Map();
  const ensure = (label) => {
    if (!map.has(label)) map.set(label, { source: label, candidates: 0, reviewed: 0, contacted: 0, interviews: 0, offers: 0, hired: 0, periodActivities: 0, periodInterviews: 0, periodHired: 0 });
    return map.get(label);
  };
  const rows = db.prepare("SELECT candidate_id,stage,outcome,data_json FROM applications").all();
  for (const row of rows) {
    const journey = applicationJourney(row);
    const item = ensure(journey.source);
    item.candidates += 1;
    if (journey.reviewed) item.reviewed += 1;
    if (journey.contacted) item.contacted += 1;
    if (journey.interviewed) item.interviews += 1;
    if (journey.offered) item.offers += 1;
    if (journey.hired) item.hired += 1;
  }
  for (const activity of activities) {
    const item = ensure(sourceDisplay(activity.source));
    item.periodActivities += activity.count;
    if (["interview_scheduled", "reinterview_scheduled", "interview_conducted"].includes(activity.activityType)) item.periodInterviews += activity.count;
    if (activity.activityType === "hired") item.periodHired += activity.count;
  }
  return [...map.values()].map((row) => ({
    ...row,
    interviewRate: metricRate(row.interviews, row.candidates),
    hireRate: metricRate(row.hired, row.candidates)
  })).sort((a, b) => b.periodActivities - a.periodActivities || b.candidates - a.candidates || a.source.localeCompare(b.source, "ko"));
}

function candidateOutcomeSummary() {
  const sets = { all: new Set(), interviewed: new Set(), offered: new Set(), hired: new Set() };
  for (const row of db.prepare("SELECT candidate_id,stage,outcome,data_json FROM applications").all()) {
    if (!row.candidate_id) continue;
    const journey = applicationJourney(row);
    sets.all.add(row.candidate_id);
    if (journey.interviewed) sets.interviewed.add(row.candidate_id);
    if (journey.offered) sets.offered.add(row.candidate_id);
    if (journey.hired) sets.hired.add(row.candidate_id);
  }
  return { totalCandidates: sets.all.size, interviews: sets.interviewed.size, offers: sets.offered.size, hired: sets.hired.size };
}

function uniqueCandidateCount(rows) {
  return new Set(rows.map((row) => row.candidateId).filter(Boolean)).size;
}

function departmentDecisionRows(goals, pipeline, activities) {
  const departments = new Map();
  const ensure = (name) => {
    const label = textValue(name, 100) || "미지정";
    if (!departments.has(label)) departments.set(label, { department: label, goals: [], candidates: [], activities: [] });
    return departments.get(label);
  };
  for (const goal of goals) ensure(goal.division).goals.push(goal);
  for (const candidate of pipeline) ensure(candidate.division).candidates.push(candidate);
  for (const activity of activities) ensure(activity.department).activities.push(activity);
  return [...departments.values()].map((group) => {
    const departmentGoals = group.goals;
    const targetHeadcount = departmentGoals.reduce((sum, goal) => sum + Number(goal.targetHeadcount || 0), 0);
    const weightedProgress = targetHeadcount
      ? Math.round(departmentGoals.reduce((sum, goal) => sum + Number(goal.progress || 0) * Number(goal.targetHeadcount || 0), 0) / targetHeadcount)
      : 0;
    const riskGoals = departmentGoals.filter((goal) => ["risk", "overdue", "checkpoint_due"].includes(goal.riskStatus));
    const completedGoals = departmentGoals.filter((goal) => goal.riskStatus === "completed");
    const activeCandidates = group.candidates.filter((row) => !row.archivedAt && !["closed", "hired"].includes(row.stage));
    const interviews = uniqueCandidateCount(group.candidates.filter((row) => row.stage === "interview"));
    const offers = uniqueCandidateCount(group.candidates.filter((row) => row.stage === "offer"));
    const hired = uniqueCandidateCount(group.candidates.filter((row) => row.stage === "hired"));
    const overdueCandidates = uniqueCandidateCount(group.candidates.filter((row) => ["overdue", "target_overdue"].includes(row.scheduleStatus)));
    const activityTotals = emptyMetric(group.department);
    for (const activity of group.activities) metricRow(activityTotals, activity);
    const backupPlans = [...new Set(departmentGoals.map((goal) => goal.backupPlan || goal.latestCheckpoint?.backupPlan || "").filter(Boolean))];
    let status = "pipeline_needed";
    if (departmentGoals.length && completedGoals.length === departmentGoals.length) status = "completed";
    else if (riskGoals.length || overdueCandidates) status = "action_required";
    else if (interviews + offers + hired > 0 || weightedProgress >= 50) status = "on_track";
    let recommendation = "사람인 공고·DM·과거 인재풀을 병행해 우선 후보군을 확보하고 담당자별 다음 활동일을 등록하세요.";
    if (backupPlans.length) recommendation = `등록 백업플랜 실행: ${backupPlans.join(" / ")}`;
    else if (overdueCandidates) recommendation = `지연 후보 ${overdueCandidates}명의 다음 활동일을 재설정하고 담당자 조치를 확인하세요.`;
    else if (activeCandidates.length && interviews + offers + hired === 0) recommendation = "검토 기준을 재점검하고 우선 후보에게 1:1 연락해 면접 슬롯을 먼저 확보하세요.";
    else if (interviews > 0 && offers + hired === 0) recommendation = "면접 결과와 탈락 사유를 정리하고 조건 조정 또는 과거 면접자 재접촉을 검토하세요.";
    else if (status === "completed") recommendation = "목표 달성 상태를 유지하면서 입사 확정·초기 정착 여부를 추적하세요.";
    else if (status === "on_track") recommendation = "현재 후보의 다음 단계와 목표일을 유지하고 예정된 중간점검에서 전환을 확인하세요.";
    return {
      department: group.department,
      status,
      goalCount: departmentGoals.length,
      targetHeadcount,
      weightedProgress,
      riskGoals: riskGoals.length,
      completedGoals: completedGoals.length,
      activeCandidates: uniqueCandidateCount(activeCandidates),
      interviews,
      offers,
      hired,
      overdueCandidates,
      activityCount: activityTotals.totalCount,
      applications: activityTotals.applications,
      reviews: activityTotals.reviews,
      periodInterviews: activityTotals.interviews,
      periodHired: activityTotals.hired,
      dmSent: activityTotals.dmSent,
      backupPlan: backupPlans.join(" / "),
      recommendation,
      positions: departmentGoals.map((goal) => `${goal.priority} ${goal.functionName || goal.title}`).slice(0, 8),
      goalDetails: departmentGoals.map((goal) => ({ id: goal.id, priority: goal.priority, position: goal.functionName || goal.title, level: goal.level || "", owner: goal.ownerPrimary || "미지정", progress: goal.progress, status: goal.riskStatus, checkpointDate: goal.checkpointDate, targetDate: goal.targetDate, backupPlan: goal.backupPlan || goal.latestCheckpoint?.backupPlan || "" }))
    };
  }).sort((a, b) => ({ action_required: 0, pipeline_needed: 1, on_track: 2, completed: 3 }[a.status] ?? 9) - ({ action_required: 0, pipeline_needed: 1, on_track: 2, completed: 3 }[b.status] ?? 9) || b.riskGoals - a.riskGoals || a.department.localeCompare(b.department, "ko"));
}

function buildExecutiveReport(activities, goals, pipeline, from, to) {
  const totals = emptyMetric("전체");
  for (const activity of activities) metricRow(totals, activity);
  totals.dmAcceptanceRate = metricRate(totals.dmAccepted, totals.dmSent);
  const days = daysBetween(from, to) + 1;
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(days - 1));
  const previousTotals = emptyMetric("이전 기간");
  for (const activity of getRecruitingActivities(previousFrom, previousTo)) metricRow(previousTotals, activity);
  previousTotals.dmAcceptanceRate = metricRate(previousTotals.dmAccepted, previousTotals.dmSent);
  const sourceFunnel = applicationFunnelRows(activities);
  const rejectionReasons = rejectionReasonSummary();
  const departments = departmentDecisionRows(goals, pipeline, activities);
  const outcomeSummary = candidateOutcomeSummary();
  const activeCandidates = uniqueCandidateCount(pipeline.filter((row) => !row.archivedAt && !["closed", "hired"].includes(row.stage)));
  const overdueCandidates = uniqueCandidateCount(pipeline.filter((row) => ["overdue", "target_overdue"].includes(row.scheduleStatus)));
  const actionDepartments = departments.filter((row) => row.status === "action_required");
  const pipelineNeededDepartments = departments.filter((row) => row.status === "pipeline_needed" && row.goalCount > 0);
  const onTrackDepartments = departments.filter((row) => ["on_track", "completed"].includes(row.status));
  const explicitBackups = goals.filter((goal) => goal.backupPlan || goal.latestCheckpoint?.backupPlan).length;
  const leadingSource = [...sourceFunnel].sort((a, b) => b.periodActivities - a.periodActivities || b.candidates - a.candidates)[0] || null;
  const status = actionDepartments.length ? "action_required" : pipelineNeededDepartments.length ? "monitor" : "on_track";
  const delta = (current, previous) => Number(current || 0) - Number(previous || 0);
  const bullets = [
    `선택 기간 활동은 ${totals.totalCount}건이며 이전 동일 길이 기간 대비 ${delta(totals.totalCount, previousTotals.totalCount) >= 0 ? "+" : ""}${delta(totals.totalCount, previousTotals.totalCount)}건입니다. 면접 수립 ${totals.interviews}건, 면접 실시 ${totals.interviewsConducted}건, 입사 기록 ${totals.hired}건입니다.`,
    `현재 등록 후보자 ${outcomeSummary.totalCandidates}명 중 면접 경험 ${outcomeSummary.interviews}명(${metricRate(outcomeSummary.interviews, outcomeSummary.totalCandidates)}%), 실제 입사 ${outcomeSummary.hired}명(${metricRate(outcomeSummary.hired, outcomeSummary.totalCandidates)}%)입니다.`,
    actionDepartments.length
      ? `조치 필요 부서는 ${actionDepartments.map((row) => row.department).join(", ")}이며 목표 위험 또는 후보 일정 지연이 확인됩니다.`
      : pipelineNeededDepartments.length
        ? `즉시 위험 목표는 없지만 후보 파이프라인 확보가 필요한 부서는 ${pipelineNeededDepartments.map((row) => row.department).join(", ")}입니다.`
        : `목표 위험·일정 지연 기준으로 모든 부서가 정상 범위이며, 양호·완료 부서는 ${onTrackDepartments.map((row) => row.department).join(", ") || "없음"}입니다.`,
    `등록된 백업플랜은 ${explicitBackups}개 목표에 있으며${leadingSource ? `, 선택 기간 활동이 가장 많은 채용소스는 ${leadingSource.source}(${leadingSource.periodActivities}건)입니다.` : "."}`
  ];
  const actions = departments.filter((row) => ["action_required", "pipeline_needed"].includes(row.status) && row.goalCount > 0).slice(0, 8).map((row) => ({ department: row.department, status: row.status, action: row.recommendation, ownerAction: row.goalDetails.filter((goal) => ["risk", "overdue", "checkpoint_due"].includes(goal.status)).map((goal) => `${goal.owner} · ${goal.position}`).join(", ") }));
  return {
    status,
    generatedAt: new Date().toISOString(),
    from,
    to,
    previousFrom,
    previousTo,
    totals,
    previousTotals,
    deltas: {
      totalCount: delta(totals.totalCount, previousTotals.totalCount),
      applications: delta(totals.applications, previousTotals.applications),
      reviews: delta(totals.reviews, previousTotals.reviews),
      interviews: delta(totals.interviews, previousTotals.interviews),
      hired: delta(totals.hired, previousTotals.hired)
    },
    pipeline: {
      totalCandidates: outcomeSummary.totalCandidates,
      activeCandidates,
      interviews: outcomeSummary.interviews,
      offers: outcomeSummary.offers,
      hired: outcomeSummary.hired,
      interviewRate: metricRate(outcomeSummary.interviews, outcomeSummary.totalCandidates),
      hireRate: metricRate(outcomeSummary.hired, outcomeSummary.totalCandidates),
      overdueCandidates
    },
    departmentSummary: {
      total: departments.filter((row) => row.goalCount || row.activityCount).length,
      onTrack: onTrackDepartments.length,
      actionRequired: actionDepartments.length,
      pipelineNeeded: pipelineNeededDepartments.length
    },
    sourceFunnel,
    rejectionReasons,
    departments,
    bullets,
    actions,
    definitions: [
      "선택 기간 실적은 담당자가 입력한 일일 채용활동의 활동일 기준입니다.",
      "전체 후보·면접·입사는 후보자 중복을 제거한 누적 이력 기준입니다. 유입경로 표는 지원 포지션별 기록 기준이므로 동일 후보의 복수 지원이 포함될 수 있습니다.",
      "부서 판정은 완료, 목표 위험·중간점검·목표일 경과, 후보 일정 지연, 면접 이상 단계 보유 여부 순으로 계산합니다.",
      `증감 비교기간은 ${previousFrom}~${previousTo}로 선택 기간과 동일한 ${days}일입니다.`
    ]
  };
}

function publicExecutiveReport(report) {
  if (!report) return null;
  return {
    ...report,
    departments: report.departments.map((row) => ({ ...row, backupPlan: "", recommendation: row.status === "action_required" || row.backupPlan ? "등록 사용자가 목표 위험과 백업플랜을 확인해야 합니다." : row.recommendation, goalDetails: row.goalDetails.map((goal) => ({ ...goal, owner: maskPersonName(goal.owner), backupPlan: "" })) })),
    actions: report.actions.map((row) => ({ ...row, ownerAction: "", action: row.status === "action_required" || String(row.action || "").startsWith("등록 백업플랜") ? "등록 사용자가 목표 위험과 백업플랜을 확인해야 합니다." : row.action }))
  };
}

function publicGoal(goal) {
  return {
    id: goal.id,
    priority: goal.priority,
    division: goal.division || "",
    functionName: goal.functionName || "",
    title: goal.title || "",
    level: goal.level || "",
    targetHeadcount: goal.targetHeadcount,
    originalTargetDate: goal.originalTargetDate,
    checkpointDate: goal.checkpointDate,
    revisedTargetDate: goal.revisedTargetDate,
    targetDate: goal.targetDate,
    ownerPrimary: goal.ownerPrimary ? maskPersonName(goal.ownerPrimary) : "",
    ownerSecondary: goal.ownerSecondary ? maskPersonName(goal.ownerSecondary) : "",
    goalStatus: goal.goalStatus,
    autoProgress: goal.autoProgress,
    progress: goal.progress,
    riskStatus: goal.riskStatus,
    filledCount: goal.filledCount
  };
}

function publicReport(report) {
  return {
    ...report,
    byOwner: report.byOwner.map((row) => ({ ...row, label: maskPersonName(row.label) })),
    atRiskGoals: report.atRiskGoals.map((goal) => ({ ...goal, ownerPrimary: maskPersonName(goal.ownerPrimary), backupPlan: "" })),
    activityDetails: [],
    executive: publicExecutiveReport(report.executive)
  };
}

function listUsers() {
  return db.prepare(`SELECT username,display_name AS displayName,email,department,role,active,must_change_password AS mustChangePassword,created_at AS createdAt,updated_at AS updatedAt
    FROM users ORDER BY active DESC,role,display_name`).all().map((row) => ({ ...row, active: Boolean(row.active), mustChangePassword: Boolean(row.mustChangePassword) }));
}

function getSnapshots(from, to, isPublic) {
  return db.prepare("SELECT * FROM report_snapshots ORDER BY period_end DESC,closed_at DESC LIMIT 40")
    .all().map((row) => {
      const summary = parseJson(row.summary_json);
      return {
        id: row.id,
        periodType: row.period_type,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        summary: isPublic ? publicReport(summary) : summary,
        note: isPublic ? "" : row.note || "",
        closedByName: isPublic ? maskPersonName(row.closed_by_name) : row.closed_by_name,
        closedAt: row.closed_at
      };
    });
}

function legacyCounts() {
  return {
    candidates: db.prepare("SELECT COUNT(*) AS value FROM applications").get().value,
    talentPool: db.prepare("SELECT COUNT(*) AS value FROM applications WHERE is_talent_pool=1").get().value,
    interviews: db.prepare("SELECT COUNT(*) AS value FROM interviews").get().value
  };
}

function saraminConnected() {
  return Boolean(String(process.env.SARAMIN_ACCESS_KEY || "").trim());
}

function saraminCompanyName(value) {
  return String(value || "").toLowerCase().replace(/\(주\)|㈜|주식회사|\s/g, "");
}

function saraminDate(value, timestamp) {
  const direct = String(value || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(seconds * 1000));
}

function safeSaraminUrl(value) {
  const raw = textValue(value, 1200);
  if (!raw) throw httpError(400, "사람인 공고 URL을 입력하세요.");
  let parsed;
  try { parsed = new URL(raw); } catch { throw httpError(400, "사람인 공고 URL을 확인하세요."); }
  const host = parsed.hostname.toLowerCase();
  if (host !== "saramin.co.kr" && !host.endsWith(".saramin.co.kr")) throw httpError(400, "사람인 공고 URL만 등록할 수 있습니다.");
  if (!["http:", "https:"].includes(parsed.protocol)) throw httpError(400, "사람인 공고 URL을 확인하세요.");
  parsed.protocol = "https:";
  return parsed.toString();
}

function jobPostingRecord(row, isPublic = false) {
  const base = {
    id: row.id,
    title: row.title,
    department: row.department || "",
    location: row.location || "",
    experience: row.experience || "",
    jobType: row.job_type || "",
    education: row.education || "",
    openingDate: row.opening_date,
    expirationDate: row.expiration_date,
    closeType: row.close_type || "접수마감일",
    url: row.url,
    status: row.status,
    source: row.source,
    updatedAt: row.updated_at
  };
  if (isPublic) return base;
  return {
    ...base,
    saraminId: row.saramin_id,
    viewCount: integer(row.view_count),
    applyCount: integer(row.apply_count),
    requisitionId: row.requisition_id,
    lastSyncedAt: row.last_synced_at,
    createdByUsername: row.created_by_username,
    createdByName: row.created_by_name,
    createdAt: row.created_at
  };
}

function getJobPostings(actor) {
  const rows = actor
    ? db.prepare(`SELECT * FROM job_postings ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, COALESCE(expiration_date,'9999-12-31'), opening_date DESC, updated_at DESC LIMIT 200`).all()
    : db.prepare(`SELECT * FROM job_postings WHERE status='active' ORDER BY COALESCE(expiration_date,'9999-12-31'), opening_date DESC, updated_at DESC LIMIT 100`).all();
  return rows.map((row) => jobPostingRecord(row, !actor));
}

function saraminStatus(postings, actor) {
  const today = isoToday();
  const weekEnd = addDays(today, 7);
  const weekStart = addDays(today, -7);
  const active = postings.filter((row) => row.status === "active");
  const lastSyncedAt = db.prepare("SELECT value FROM app_meta WHERE key='saramin_last_sync'").get()?.value || null;
  return {
    connected: saraminConnected(),
    mode: saraminConnected() ? "api" : "manual",
    companyPage: SARAMIN_COMPANY_PAGE,
    lastSyncedAt,
    activeCount: active.length,
    closingThisWeek: active.filter((row) => row.expirationDate && row.expirationDate >= today && row.expirationDate <= weekEnd).length,
    newThisWeek: active.filter((row) => row.openingDate && row.openingDate >= weekStart && row.openingDate <= today).length,
    totalApplications: actor ? active.reduce((sum, row) => sum + Number(row.applyCount || 0), 0) : null,
    totalViews: actor ? active.reduce((sum, row) => sum + Number(row.viewCount || 0), 0) : null
  };
}

function normalizeJobPostingInput(body, current = {}) {
  const title = textValue(body.title ?? current.title, 240);
  const status = textValue(body.status ?? current.status ?? "active", 20);
  if (!title) throw httpError(400, "채용공고 제목을 입력하세요.");
  if (!JOB_POSTING_STATUSES.has(status)) throw httpError(400, "채용공고 상태를 확인하세요.");
  const openingDate = dateValue(body.openingDate ?? current.opening_date);
  const expirationDate = dateValue(body.expirationDate ?? current.expiration_date);
  if (openingDate && expirationDate && openingDate > expirationDate) throw httpError(400, "접수 시작일은 마감일보다 늦을 수 없습니다.");
  const requisitionId = textValue(body.requisitionId ?? current.requisition_id, 100) || null;
  if (requisitionId && !db.prepare("SELECT 1 FROM requisitions WHERE id=?").get(requisitionId)) throw httpError(400, "연결할 채용목표를 찾을 수 없습니다.");
  return {
    title,
    department: textValue(body.department ?? current.department, 100) || null,
    location: textValue(body.location ?? current.location, 160) || null,
    experience: textValue(body.experience ?? current.experience, 120) || null,
    jobType: textValue(body.jobType ?? current.job_type, 80) || null,
    education: textValue(body.education ?? current.education, 100) || null,
    openingDate,
    expirationDate,
    closeType: textValue(body.closeType ?? current.close_type ?? "접수마감일", 60) || "접수마감일",
    url: safeSaraminUrl(body.url ?? current.url),
    status,
    viewCount: integer(body.viewCount ?? current.view_count, 0, 100000000),
    applyCount: integer(body.applyCount ?? current.apply_count, 0, 100000000),
    requisitionId,
    saraminId: textValue(body.saraminId ?? current.saramin_id, 80) || null
  };
}

function saraminItem(item) {
  const companyName = item?.company?.detail?.name || item?.company?.name || "";
  if (saraminCompanyName(companyName) !== "메드파크") return null;
  const position = item.position || {};
  const title = textValue(position.title, 240);
  if (!title || !item.url || !item.id) return null;
  return {
    id: `saramin-${textValue(item.id, 80)}`,
    saraminId: textValue(item.id, 80),
    title,
    department: textValue(position["job-mid-code"]?.name, 100) || null,
    location: textValue(position.location?.name, 160) || null,
    experience: textValue(position["experience-level"]?.name, 120) || null,
    jobType: textValue(position["job-type"]?.name, 80) || null,
    education: textValue(position["required-education-level"]?.name, 100) || null,
    openingDate: saraminDate(item["posting-date"], item["opening-timestamp"] || item["posting-timestamp"]),
    expirationDate: saraminDate(item["expiration-date"], item["expiration-timestamp"]),
    closeType: textValue(item["close-type"]?.name || item["close-type"], 60) || "접수마감일",
    url: safeSaraminUrl(item.url),
    status: Number(item.active) === 1 ? "active" : "closed",
    viewCount: integer(item["read-cnt"], 0, 100000000),
    applyCount: integer(item["apply-cnt"], 0, 100000000)
  };
}

async function syncSaraminPostings(actor = { username: "system", name: "시스템" }) {
  const accessKey = String(process.env.SARAMIN_ACCESS_KEY || "").trim();
  if (!accessKey) throw httpError(409, "사람인 API 키가 아직 연결되지 않았습니다.");
  const params = new URLSearchParams({
    "access-key": accessKey,
    keywords: "(주)메드파크",
    count: "110",
    sort: "ud",
    fields: "posting-date expiration-date count"
  });
  const response = await fetch(`https://oapi.saramin.co.kr/job-search?${params}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code) throw httpError(502, textValue(payload.message, 300) || "사람인 공고를 불러오지 못했습니다.");
  const raw = payload?.jobs?.job;
  const rawItems = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const items = rawItems.map((item) => {
    try { return saraminItem(item); } catch { return null; }
  }).filter(Boolean);
  if (rawItems.length && !items.length) throw httpError(502, "사람인 응답에서 (주)메드파크 공고를 확인하지 못했습니다.");
  const now = new Date().toISOString();
  const syncedIds = new Set(items.map((item) => item.saraminId));
  const upsert = db.prepare(`INSERT INTO job_postings
    (id,saramin_id,title,department,location,experience,job_type,education,opening_date,expiration_date,close_type,url,status,view_count,apply_count,requisition_id,source,last_synced_at,created_by_username,created_by_name,created_at,updated_at)
    VALUES (@id,@saraminId,@title,@department,@location,@experience,@jobType,@education,@openingDate,@expirationDate,@closeType,@url,@status,@viewCount,@applyCount,NULL,'saramin_api',@now,'system','사람인 API',@now,@now)
    ON CONFLICT(saramin_id) DO UPDATE SET title=excluded.title,department=excluded.department,location=excluded.location,experience=excluded.experience,job_type=excluded.job_type,education=excluded.education,opening_date=excluded.opening_date,expiration_date=excluded.expiration_date,close_type=excluded.close_type,url=excluded.url,status=excluded.status,view_count=excluded.view_count,apply_count=excluded.apply_count,source='saramin_api',last_synced_at=excluded.last_synced_at,updated_at=excluded.updated_at`);
  db.transaction(() => {
    for (const item of items) upsert.run({ ...item, now });
    for (const row of db.prepare("SELECT id,saramin_id FROM job_postings WHERE source='saramin_api' AND status='active'").all()) {
      if (!syncedIds.has(row.saramin_id)) db.prepare("UPDATE job_postings SET status='closed',last_synced_at=?,updated_at=? WHERE id=?").run(now, now, row.id);
    }
    setMeta("saramin_last_sync", now, now);
    logActivity("saramin_synced", `사람인 채용공고 ${items.length}건 동기화`, actor, { synced: items.length });
  })();
  return { synced: items.length, at: now };
}

async function maybeSyncSaraminPostings(force = false, actor) {
  if (!saraminConnected()) return null;
  const last = db.prepare("SELECT value FROM app_meta WHERE key='saramin_last_sync'").get()?.value;
  if (!force && last && Date.now() - Date.parse(last) < SARAMIN_SYNC_INTERVAL_MS) return null;
  if (saraminSyncInFlight) return saraminSyncInFlight;
  saraminSyncInFlight = syncSaraminPostings(actor).finally(() => { saraminSyncInFlight = null; });
  return saraminSyncInFlight;
}

function getHrData(actor, range) {
  const goals = buildGoals();
  const recruitingActivities = getRecruitingActivities(range.from, range.to);
  const candidatePipeline = candidatePipelineRows();
  const workforcePlans = getWorkforcePlans();
  const workforce = workforceOverview(workforcePlans);
  const report = buildReport(recruitingActivities, goals, range.from, range.to);
  report.executive = buildExecutiveReport(recruitingActivities, goals, candidatePipeline, range.from, range.to);
  const recentAudit = actor ? db.prepare("SELECT id,kind,summary,actor_name AS actorName,occurred_at AS occurredAt FROM activity_logs ORDER BY occurred_at DESC,id DESC LIMIT 40").all() : [];
  const checkpoints = actor ? db.prepare("SELECT * FROM goal_checkpoints ORDER BY checkpoint_date DESC,created_at DESC LIMIT 120").all().map(checkpointRecord) : [];
  const users = actor?.role === "admin" ? listUsers() : [];
  const assignees = actor ? db.prepare("SELECT username,display_name AS displayName,department FROM users WHERE active=1 ORDER BY display_name").all() : [];
  const jobPostings = getJobPostings(actor);
  const saramin = saraminStatus(jobPostings, actor);
  const candidateSummary = candidatePipelineSummary(candidatePipeline);
  const meetings = actor ? getMeetings() : [];
  const actionItems = actor ? getActionItems() : [];
  const myWork = actor ? buildMyWork(actor, actionItems) : null;
  if (!actor) {
    return {
      actor: null,
      access: "public-readonly",
      today: isoToday(),
      period: range,
      report: publicReport(report),
      goals: goals.map(publicGoal),
      recruitingActivities: [],
      checkpoints: [],
      snapshots: getSnapshots(range.from, range.to, true),
      recentAudit: [],
      users: [],
      assignees: [],
      jobPostings,
      saramin,
      candidatePipeline: [],
      candidateSummary,
      workforcePlans: workforcePlans.map((row) => ({ id: row.id, department: row.department, position: row.position, approvedHeadcount: row.approvedHeadcount, currentHeadcount: row.currentHeadcount, recruitingTo: row.recruitingTo, joiningPlanned: row.joiningPlanned, leavingPlanned: row.leavingPlanned, asOfDate: row.asOfDate, note: "" })),
      workforce,
      meetings: [],
      actionItems: [],
      myWork: null,
      legacy: legacyCounts()
    };
  }
  return {
    actor,
    access: "registered",
    today: isoToday(),
    period: range,
    report,
    goals,
    recruitingActivities,
    checkpoints,
    snapshots: getSnapshots(range.from, range.to, false),
    recentAudit,
    users,
    assignees,
    jobPostings,
    saramin,
    candidatePipeline,
    candidateSummary,
    workforcePlans,
    workforce,
    meetings,
    actionItems,
    myWork,
    legacy: legacyCounts()
  };
}

function logActivity(kind, summary, actor, details = {}) {
  db.prepare("INSERT INTO activity_logs (kind,summary,actor_username,actor_name,occurred_at,details_json) VALUES (?,?,?,?,?,?)")
    .run(kind, summary, actor.username, actor.name, new Date().toISOString(), JSON.stringify(details));
}

function assertActivityOwnership(actor, row) {
  if (actor.role !== "admin" && row.created_by_username !== actor.username) throw httpError(403, "본인이 입력한 활동만 수정할 수 있습니다.");
}

function normalizeActivityInput(body, actor, current = null) {
  const activityDate = dateValue(body.activityDate ?? current?.activity_date, true);
  const department = textValue(body.department ?? current?.department, 80);
  const position = textValue(body.position ?? current?.position, 100);
  const activityType = textValue(body.activityType ?? current?.activity_type, 60);
  const source = textValue(body.source ?? current?.source ?? "other", 40);
  if (!department || !position) throw httpError(400, "부서와 포지션을 입력하세요.");
  if (!ACTIVITY_TYPES.has(activityType)) throw httpError(400, "활동 구분을 확인하세요.");
  if (!SOURCES.has(source)) throw httpError(400, "채용 소스를 확인하세요.");
  let requisitionId = textValue(body.requisitionId ?? current?.requisition_id, 100) || null;
  if (requisitionId && !db.prepare("SELECT 1 FROM requisitions WHERE id=?").get(requisitionId)) throw httpError(400, "연결할 채용목표를 찾을 수 없습니다.");
  const count = integer(body.count ?? current?.count, 1, 10000);
  const acceptedCount = integer(body.acceptedCount ?? current?.accepted_count, 0, 10000);
  if (count < 1) throw httpError(400, "활동 건수는 1건 이상이어야 합니다.");
  const ownerName = actor.role === "admin" && textValue(body.ownerName, 80) ? textValue(body.ownerName, 80) : (current?.owner_name || actor.name);
  let applicationId = textValue(body.applicationId ?? current?.application_id, 100) || null;
  let candidateId = textValue(body.candidateId ?? current?.candidate_id, 100) || null;
  let candidateName = textValue(body.candidateName ?? current?.candidate_name, 100) || null;
  if (applicationId) {
    const application = db.prepare(`SELECT a.id,a.candidate_id,a.requisition_id,c.name AS candidate_name
      FROM applications a JOIN candidates c ON c.id=a.candidate_id WHERE a.id=?`).get(applicationId);
    if (!application) throw httpError(400, "연결할 후보자 지원이력을 찾을 수 없습니다.");
    candidateId = application.candidate_id;
    candidateName = application.candidate_name;
    requisitionId = requisitionId || application.requisition_id || null;
  } else if (candidateId && !db.prepare("SELECT 1 FROM candidates WHERE id=?").get(candidateId)) {
    throw httpError(400, "연결할 후보자를 찾을 수 없습니다.");
  }
  const interviewMode = ["interview_scheduled", "reinterview_scheduled", "interview_conducted"].includes(activityType);
  const interviewStatus = textValue(body.interviewStatus ?? current?.interview_status ?? (activityType === "interview_conducted" ? "completed" : "scheduled"), 30);
  const interviewResult = textValue(body.interviewResult ?? current?.interview_result ?? "pending", 30);
  let rejectionReason = textValue(body.rejectionReason ?? current?.rejection_reason, 80);
  if (interviewMode && !INTERVIEW_STATUSES.has(interviewStatus)) throw httpError(400, "면접 상태를 확인하세요.");
  if (interviewMode && !INTERVIEW_RESULTS.has(interviewResult)) throw httpError(400, "면접 결과를 확인하세요.");
  if (!REJECTION_REASONS.has(rejectionReason)) throw httpError(400, "불합격 사유를 확인하세요.");
  if (interviewResult === "fail" && !rejectionReason) throw httpError(400, "불합격 사유를 선택하세요.");
  if (interviewResult === "withdrawn" && !rejectionReason) rejectionReason = "지원 철회";
  if (interviewResult === "no_show" && !rejectionReason) rejectionReason = "면접 불참";
  return {
    activityDate,
    department,
    position,
    requisitionId,
    candidateId,
    applicationId,
    activityType,
    source,
    count,
    acceptedCount,
    candidateName,
    ownerName,
    details: textValue(body.details ?? current?.details, 1200) || null,
    nextActionAt: dateTimeValue(body.nextActionAt ?? current?.next_action_at),
    interviewLocation: interviewMode ? textValue(body.interviewLocation ?? current?.interview_location, 180) : null,
    interviewerNames: interviewMode ? textValue(body.interviewerNames ?? current?.interviewer_names, 500) : null,
    interviewRound: interviewMode ? Math.max(1, integer(body.interviewRound ?? current?.interview_round, 1, 10)) : null,
    interviewDuration: interviewMode ? Math.max(15, integer(body.interviewDuration ?? current?.interview_duration, 60, 480)) : null,
    interviewStatus: interviewMode ? interviewStatus : null,
    interviewResult: interviewMode ? interviewResult : null,
    rejectionReason: interviewMode ? rejectionReason || null : null,
    resultNotes: interviewMode ? textValue(body.resultNotes ?? current?.result_notes, 1800) || null : null
  };
}

function syncInterviewApplication(input, now = new Date().toISOString()) {
  if (!input.applicationId || !["interview_scheduled", "reinterview_scheduled", "interview_conducted"].includes(input.activityType)) return;
  const application = db.prepare("SELECT * FROM applications WHERE id=?").get(input.applicationId);
  if (!application) return;
  const previousData = parseJson(application.data_json);
  const data = {
    ...previousData,
    lastInterviewAt: input.nextActionAt || `${input.activityDate}T00:00`,
    lastInterviewStatus: input.interviewStatus,
    lastInterviewResult: input.interviewResult,
    lastRejectionReason: input.rejectionReason || null,
    lastInterviewLocation: input.interviewLocation || null,
    lastInterviewers: input.interviewerNames || null,
    lastActivityAt: now
  };
  let stage = application.stage;
  let outcome = application.outcome;
  let archivedAt = application.archived_at;
  if (["interview_scheduled", "reinterview_scheduled"].includes(input.activityType) && !["closed", "hired"].includes(stage)) stage = "interview";
  if (["fail", "withdrawn", "no_show"].includes(input.interviewResult)) {
    stage = "closed";
    outcome = input.rejectionReason || ({ fail: "불합격", withdrawn: "지원 철회", no_show: "면접 불참" })[input.interviewResult];
    archivedAt = archivedAt || now;
  } else if (["fail", "withdrawn", "no_show"].includes(previousData.lastInterviewResult) && stage === "closed") {
    stage = "interview";
    outcome = null;
    archivedAt = null;
  }
  data.stage = stage;
  data.outcome = outcome;
  data.archivedAt = archivedAt;
  db.prepare("UPDATE applications SET stage=?,outcome=?,archived_at=?,data_json=?,updated_at=? WHERE id=?")
    .run(stage, outcome, archivedAt, JSON.stringify(data), now, input.applicationId);
}

function sourceFromApplication(data) {
  const value = String(data.sourceChannel || data.sourceDetail || "").toLowerCase();
  if (value.includes("사람인")) return "saramin";
  if (value.includes("dm")) return "dm";
  if (value.includes("과거") || value.includes("인재풀")) return "past_pool";
  if (value.includes("추천")) return "referral";
  if (value.includes("잡코리아")) return "jobkorea";
  return "other";
}

function normalizeCandidateActivityInput(body, application, current = null) {
  const activityDate = dateValue(body.activityDate ?? current?.activity_date, true);
  const activityType = textValue(body.activityType ?? current?.activity_type, 60);
  const stageAfter = textValue(body.stageAfter ?? current?.stage_after ?? application.stage, 40);
  const summary = textValue(body.summary ?? current?.summary, 1800);
  if (!ACTIVITY_TYPES.has(activityType)) throw httpError(400, "활동 구분을 확인하세요.");
  if (!STAGES.has(stageAfter)) throw httpError(400, "후보자 진행단계를 확인하세요.");
  if (!summary) throw httpError(400, "이번 활동 내용을 입력하세요.");
  return {
    activityDate,
    activityType,
    stageAfter,
    outcome: textValue(body.outcome ?? current?.outcome, 100) || null,
    summary,
    nextActivity: textValue(body.nextActivity ?? current?.next_activity, 300) || null,
    nextActionAt: dateTimeValue(body.nextActionAt ?? current?.next_action_at),
    targetDate: dateValue(body.targetDate ?? current?.target_date)
  };
}

function applicationPreviousState(application) {
  const data = parseJson(application.data_json);
  return {
    stage: application.stage,
    outcome: application.outcome || null,
    isTalentPool: Boolean(application.is_talent_pool),
    archivedAt: application.archived_at || null,
    nextActivity: data.nextActivity || null,
    nextActionAt: data.nextActionAt || null,
    targetDate: data.targetDate || null,
    lastActivityAt: data.lastActivityAt || null
  };
}

function applyApplicationActivity(application, state, now = new Date().toISOString()) {
  const data = {
    ...parseJson(application.data_json),
    stage: state.stageAfter || state.stage || application.stage,
    outcome: state.outcome || null,
    nextActivity: state.nextActivity || null,
    nextActionAt: state.nextActionAt || null,
    targetDate: state.targetDate || null,
    lastActivityAt: state.activityDate ? `${state.activityDate}T00:00:00+09:00` : (state.lastActivityAt || now)
  };
  const stage = data.stage;
  const archivedAt = stage === "closed" ? (state.archivedAt || now) : null;
  const isTalentPool = stage === "talent_pool" ? 1 : 0;
  db.prepare("UPDATE applications SET stage=?,outcome=?,is_talent_pool=?,archived_at=?,data_json=?,updated_at=? WHERE id=?")
    .run(stage, data.outcome, isTalentPool, archivedAt, JSON.stringify(data), now, application.id);
}

function latestCandidateActivity(applicationId, excludingId = null) {
  return excludingId
    ? db.prepare("SELECT * FROM candidate_activities WHERE application_id=? AND id<>? ORDER BY activity_date DESC,created_at DESC,id DESC LIMIT 1").get(applicationId, excludingId)
    : db.prepare("SELECT * FROM candidate_activities WHERE application_id=? ORDER BY activity_date DESC,created_at DESC,id DESC LIMIT 1").get(applicationId);
}

function candidateActivityIsLatest(row) {
  const latest = latestCandidateActivity(row.application_id);
  return latest?.id === row.id;
}

function recruitingContext(application) {
  const data = parseJson(application.data_json);
  const goal = application.requisition_id ? getRequisitions().find((item) => item.id === application.requisition_id) : null;
  return {
    data,
    goal,
    department: goal?.division || "미지정",
    position: goal?.functionName || data.legacyPosition || "포지션 미연결",
    source: sourceFromApplication(data)
  };
}

function normalizeGoalInput(body, current = {}) {
  const priority = textValue(body.priority ?? current.priority ?? "2순위", 20);
  if (!PRIORITIES.has(priority)) throw httpError(400, "우선순위를 확인하세요.");
  const goalStatus = textValue(body.goalStatus ?? current.goalStatus ?? "active", 20);
  if (!GOAL_STATUSES.has(goalStatus)) throw httpError(400, "목표 상태를 확인하세요.");
  const division = textValue(body.division ?? current.division, 80);
  const functionName = textValue(body.functionName ?? current.functionName, 80);
  const title = textValue(body.title ?? current.title, 120);
  if (!division || !functionName || !title) throw httpError(400, "부서·직무·채용목표명을 입력하세요.");
  const originalTargetDate = dateValue(body.originalTargetDate ?? current.originalTargetDate);
  const revisedTargetDate = dateValue(body.revisedTargetDate ?? current.revisedTargetDate);
  return {
    priority,
    goalStatus,
    division,
    functionName,
    title,
    level: textValue(body.level ?? current.level, 80),
    targetHeadcount: Math.max(1, integer(body.targetHeadcount ?? current.targetHeadcount, 1, 1000)),
    originalTargetDate,
    checkpointDate: dateValue(body.checkpointDate ?? current.checkpointDate),
    revisedTargetDate,
    targetDate: revisedTargetDate || originalTargetDate,
    ownerPrimary: textValue(body.ownerPrimary ?? current.ownerPrimary, 80),
    ownerSecondary: textValue(body.ownerSecondary ?? current.ownerSecondary, 80),
    reviewers: textValue(body.reviewers ?? parseReviewers(current.reviewersJson), 500),
    dailyDmTarget: integer(body.dailyDmTarget ?? current.dailyDmTarget, 20, 10000),
    backupPlan: textValue(body.backupPlan ?? current.backupPlan, 1800)
  };
}

function parseReviewers(value) {
  if (Array.isArray(value)) return value.join(", ");
  try { return JSON.parse(value || "[]").join(", "); } catch { return String(value || ""); }
}

function goalDataPayload(id, input, existing = {}) {
  return {
    ...existing,
    id,
    priority: input.priority,
    division: input.division,
    functionName: input.functionName,
    title: input.title,
    level: input.level,
    targetHeadcount: input.targetHeadcount,
    originalTargetDate: input.originalTargetDate,
    checkpointDate: input.checkpointDate,
    revisedTargetDate: input.revisedTargetDate,
    currentTargetDate: input.targetDate,
    targetDate: input.targetDate,
    ownerPrimary: input.ownerPrimary,
    ownerSecondary: input.ownerSecondary,
    reviewersJson: JSON.stringify(input.reviewers.split(",").map((item) => item.trim()).filter(Boolean)),
    dailyDmTarget: input.dailyDmTarget,
    backupPlan: input.backupPlan,
    goalStatus: input.goalStatus,
    status: input.goalStatus === "closed" ? "closed" : "open"
  };
}

function normalizeWorkforceInput(body, current = {}) {
  const department = textValue(body.department ?? current.department, 100);
  const position = textValue(body.position ?? current.position, 120);
  if (!department || !position) throw httpError(400, "부서와 직무·포지션을 입력하세요.");
  return {
    department,
    position,
    approvedHeadcount: integer(body.approvedHeadcount ?? current.approved_headcount, 0, 10000),
    currentHeadcount: integer(body.currentHeadcount ?? current.current_headcount, 0, 10000),
    recruitingTo: integer(body.recruitingTo ?? current.recruiting_to, 0, 10000),
    joiningPlanned: integer(body.joiningPlanned ?? current.joining_planned, 0, 10000),
    leavingPlanned: integer(body.leavingPlanned ?? current.leaving_planned, 0, 10000),
    asOfDate: dateValue(body.asOfDate ?? current.as_of_date ?? isoToday(), true),
    note: textValue(body.note ?? current.note, 1200) || null,
    currentMembers: textValue(body.currentMembers ?? current.current_members, 3000) || null,
    recruitPlan: textValue(body.recruitPlan ?? current.recruit_plan, 3000) || null,
    asIsTasks: textValue(body.asIsTasks ?? current.as_is_tasks, 8000) || null,
    toBeTasks: textValue(body.toBeTasks ?? current.to_be_tasks, 8000) || null,
    futurePlan: textValue(body.futurePlan ?? current.future_plan, 8000) || null
  };
}

function normalizeMeetingInput(body, current = {}) {
  const title = textValue(body.title ?? current.title, 180);
  if (!title) throw httpError(400, "회의 제목을 입력하세요.");
  const status = textValue(body.status ?? current.status ?? "scheduled", 30);
  if (!MEETING_STATUSES.has(status)) throw httpError(400, "회의 상태를 확인하세요.");
  return {
    meetingDate: dateTimeValue(body.meetingDate ?? current.meeting_date) || `${isoToday()}T09:00`,
    title,
    agenda: textValue(body.agenda ?? current.agenda, 4000) || null,
    minutes: textValue(body.minutes ?? current.minutes, 12000) || null,
    keyDiscussions: textValue(body.keyDiscussions ?? current.key_discussions, 5000) || null,
    participants: textValue(body.participants ?? current.participants, 2000) || null,
    transcript: textValue(body.transcript ?? current.transcript, 50000) || null,
    decisions: textValue(body.decisions ?? current.decisions, 8000) || null,
    issues: textValue(body.issues ?? current.issues, 8000) || null,
    analysisJson: textValue(body.analysisJson ?? current.analysis_json ?? "{}", 30000) || "{}",
    analysisStatus: ["draft", "reviewed"].includes(body.analysisStatus ?? current.analysis_status) ? (body.analysisStatus ?? current.analysis_status) : "draft",
    status
  };
}

function cleanMeetingLine(value) {
  return String(value || "").replace(/^[-*•·\s]+/, "").replace(/\s+/g, " ").trim();
}

function uniqueLines(lines, limit = 12) {
  return [...new Set(lines.map(cleanMeetingLine).filter((line) => line.length >= 3))].slice(0, limit);
}

const MEETING_FILLERS = /(?:^|\s)(?:그냥|그러니까|그래서|그런데|근데|이제|일단|약간|사실|뭐|좀|저기|어|음|네|예|아니|맞죠|그렇죠|알겠죠)(?=\s|$|[,.!?])/g;
const MEETING_STOP_WORDS = new Set(["그리고", "그러니까", "그래서", "그런데", "이제", "일단", "그냥", "정도", "부분", "관련", "대한", "있는", "하는", "해야", "한다", "했다", "있다", "없다", "같다", "것으로", "내용", "회의", "진행"]);

function normalizeMeetingSentence(value) {
  return cleanMeetingLine(value)
    .replace(MEETING_FILLERS, " ")
    .replace(/\b(?:네|예|음|어)[,.!?]?\s*/g, "")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/([,.!?])\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function meetingSentences(transcript) {
  const raw = String(transcript || "")
    .replace(/\r/g, "\n")
    .replace(/([.!?。]|(?:다|요|죠|함|됨|예정|필요|완료|확정))\s+(?=[가-힣A-Z0-9])/g, "$1\n")
    .split(/\n+|\s[-•·]\s+/)
    .map(normalizeMeetingSentence)
    .filter((line) => line.length >= 8);
  const result = [];
  for (const line of raw) {
    if (line.length <= 240) result.push(line);
    else {
      const clauses = line.split(/(?<=[,;])\s+|\s+(?=(?:그리고|다만|하지만|따라서|추가로|결국)\s)/).map(normalizeMeetingSentence).filter((item) => item.length >= 8);
      result.push(...(clauses.length > 1 ? clauses : [line.slice(0, 237) + "…"]));
    }
  }
  return result;
}

function meetingTokens(value) {
  return new Set(String(value || "").toLowerCase().match(/[가-힣]{2,}|[a-z]{3,}|\d{2,}/g)?.filter((token) => !MEETING_STOP_WORDS.has(token)) || []);
}

function meetingSimilarity(a, b) {
  const left = meetingTokens(a);
  const right = meetingTokens(b);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / Math.min(left.size, right.size);
}

function distinctMeetingLines(lines, limit = 8, threshold = 0.58) {
  const result = [];
  for (const value of lines.map(normalizeMeetingSentence)) {
    if (value.length < 8 || result.some((saved) => meetingSimilarity(saved, value) >= threshold)) continue;
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function conciseMeetingLine(value, max = 150) {
  let line = normalizeMeetingSentence(value)
    .replace(/^(?:말씀드리면|결론적으로|정리하면|관련해서|이 부분은)\s*/g, "")
    .replace(/(?:라고|다는|라는)\s*(?:말씀|얘기|이야기)(?:을|를)?\s*(?:드렸습니다|했습니다|했어요|함)?[.!]?$/g, "")
    .replace(/\s*(?:인 것 같습니다|같은 상황입니다|라고 봅니다)[.!]?$/g, "")
    .trim();
  if (line.length > max) line = `${line.slice(0, max - 1).replace(/[,;\s]+$/, "")}…`;
  return line;
}

function rankMeetingLines(lines, pattern, agendaTokens = new Set()) {
  return lines.map((line, index) => {
    const tokens = meetingTokens(line);
    let agendaHits = 0;
    for (const token of tokens) if (agendaTokens.has(token)) agendaHits += 1;
    const signal = (line.match(pattern) || []).length;
    const specificity = /\d|[가-힣]{2,4}(?:님|팀|부|본부장|팀장|선임|프로)/.test(line) ? 1 : 0;
    const lengthFit = line.length >= 18 && line.length <= 150 ? 1 : 0;
    return { line, score: signal * 5 + agendaHits * 2 + specificity + lengthFit - index / Math.max(lines.length, 1) };
  }).sort((a, b) => b.score - a.score).map((item) => item.line);
}

function bulletMeetingLines(lines, limit, maxLength = 160) {
  return distinctMeetingLines(lines, limit).map((line) => `- ${conciseMeetingLine(line, maxLength)}`).join("\n");
}

function meetingDueDate(text, baseDate = isoToday()) {
  const full = text.match(/(20\d{2})[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})/);
  if (full) return `${full[1]}-${String(full[2]).padStart(2, "0")}-${String(full[3]).padStart(2, "0")}`;
  const short = text.match(/(?:~|까지|기한)?\s*(\d{1,2})[./월]\s*(\d{1,2})(?:일)?/);
  if (short) {
    const year = Number(baseDate.slice(0, 4));
    return `${year}-${String(short[1]).padStart(2, "0")}-${String(short[2]).padStart(2, "0")}`;
  }
  const offset = /내일/.test(text) ? 1 : /이번\s*주/.test(text) ? 5 : /다음\s*주/.test(text) ? 10 : 7;
  const date = new Date(`${baseDate}T00:00:00+09:00`);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function analyzeMeetingText(body) {
  const transcript = textValue(body.transcript, 50000);
  if (!transcript || transcript.length < 10) throw httpError(400, "분석할 녹취 내용 또는 회의록을 10자 이상 입력하세요.");
  const baseDate = dateValue(String(body.meetingDate || isoToday()).slice(0, 10), true);
  const users = db.prepare("SELECT username,display_name FROM users WHERE active=1 ORDER BY length(display_name) DESC").all();
  const lines = meetingSentences(transcript);
  const agendaTokens = meetingTokens(`${body.title || ""} ${body.agenda || ""}`);
  const decisionPattern = /(결정|확정|승인|합의|시행|적용|전환|선정|채택|하기로|진행한다|추진한다|운영한다|담당한다)/;
  const issuePattern = /(이슈|문제|지연|위험|리스크|우려|어려움|미정|보류|부족|누락|오류|불가|안\s*됨|확인 필요|검토 필요)/;
  const actionPattern = /(담당|기한|까지|오늘|내일|이번\s*주|다음\s*주|진행|수정|작성|공유|등록|확인|검토|보고|연락|조치|업로드|준비|정리|요청)/;
  const importancePattern = /(핵심|중요|우선|필수|대표이사|대표님|채용|면접|공고|지원자|처우|입사|비용|일정|목표|성과|결론)/;
  const decisions = distinctMeetingLines(rankMeetingLines(lines.filter((line) => decisionPattern.test(line)), decisionPattern, agendaTokens), 7);
  const issues = distinctMeetingLines(rankMeetingLines(lines.filter((line) => issuePattern.test(line)), issuePattern, agendaTokens), 7);
  const important = distinctMeetingLines(rankMeetingLines(lines, importancePattern, agendaTokens), 10);
  const actionLines = distinctMeetingLines(rankMeetingLines(lines.filter((line) => actionPattern.test(line)), actionPattern, agendaTokens), 12);
  const actions = actionLines.map((line) => {
    const assignee = users.find((user) => line.includes(user.display_name));
    const title = conciseMeetingLine(line.replace(/^(\[[^\]]+\]|\d+[.)]\s*)/, ""), 100);
    return {
      title,
      details: conciseMeetingLine(line, 240),
      assigneeUsername: assignee?.username || "",
      assigneeName: assignee?.display_name || "미지정",
      dueDate: meetingDueDate(line, baseDate),
      priority: /(긴급|즉시|오늘|최우선)/.test(line) ? "urgent" : /(중요|우선)/.test(line) ? "high" : "normal"
    };
  });
  const summaryCandidates = distinctMeetingLines([...decisions, ...important, ...issues, ...rankMeetingLines(lines, importancePattern, agendaTokens)], 6, 0.5);
  const discussionLines = distinctMeetingLines([...important, ...rankMeetingLines(lines, importancePattern, agendaTokens)], 8, 0.55);
  return {
    summary: bulletMeetingLines(summaryCandidates, 6, 140),
    keyDiscussions: bulletMeetingLines(discussionLines, 8, 170),
    decisions: bulletMeetingLines(decisions, 7, 160),
    issues: bulletMeetingLines(issues.filter((line) => !decisions.some((decision) => meetingSimilarity(line, decision) >= 0.6)), 7, 160),
    actions,
    analyzedAt: new Date().toISOString(),
    method: "local-contextual-analysis-v2"
  };
}

function normalizeActionItemInput(body, current = {}) {
  const title = textValue(body.title ?? current.title, 240);
  if (!title) throw httpError(400, "액션플랜 제목을 입력하세요.");
  const status = textValue(body.status ?? current.status ?? "open", 30);
  const priority = textValue(body.priority ?? current.priority ?? "normal", 30);
  const notificationScope = textValue(body.notificationScope ?? current.notification_scope ?? "personal", 30);
  if (!ACTION_STATUSES.has(status)) throw httpError(400, "업무 상태를 확인하세요.");
  if (!ACTION_PRIORITIES.has(priority)) throw httpError(400, "우선순위를 확인하세요.");
  if (!NOTIFICATION_SCOPES.has(notificationScope)) throw httpError(400, "알림 범위를 확인하세요.");
  const meetingId = textValue(body.meetingId ?? current.meeting_id, 120) || null;
  if (meetingId && !db.prepare("SELECT 1 FROM hr_meetings WHERE id=?").get(meetingId)) throw httpError(400, "연결할 HR 회의를 찾을 수 없습니다.");
  const assigneeUsername = textValue(body.assigneeUsername ?? current.assignee_username, 80) || null;
  const assignee = assigneeUsername ? db.prepare("SELECT username,display_name FROM users WHERE username=? AND active=1").get(assigneeUsername) : null;
  if (assigneeUsername && !assignee) throw httpError(400, "담당자로 지정할 활성 사용자를 찾을 수 없습니다.");
  return {
    meetingId,
    title,
    details: textValue(body.details ?? current.details, 3000) || null,
    assigneeUsername,
    assigneeName: assignee?.display_name || textValue(body.assigneeName ?? current.assignee_name, 100) || null,
    dueDate: dateValue(body.dueDate ?? current.due_date ?? isoToday(), true),
    priority,
    status,
    notificationScope
  };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/setup/status") {
    const count = db.prepare("SELECT COUNT(*) AS value FROM users").get().value;
    return sendJson(res, 200, { setupNeeded: count === 0 });
  }
  if (req.method === "POST" && url.pathname === "/api/setup") {
    assertSameOrigin(req);
    const body = await readJson(req);
    const count = db.prepare("SELECT COUNT(*) AS value FROM users").get().value;
    if (count > 0) throw httpError(409, "관리자 설정이 이미 완료되었습니다.");
    const expectedToken = String(process.env.SETUP_TOKEN || db.prepare("SELECT value FROM app_meta WHERE key='setup_token'").get()?.value || "");
    if (!expectedToken || String(body.token || "") !== expectedToken) throw httpError(403, "유효하지 않은 설정 링크입니다.");
    validatePassword(body.password);
    const displayName = textValue(body.displayName || "관리자", 80) || "관리자";
    const { salt, hash } = hashPassword(body.password);
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare("INSERT INTO users (username,display_name,email,department,role,password_hash,password_salt,active,must_change_password,created_at,updated_at) VALUES ('admin',?,?,?,'admin',?,?,1,0,?,?)")
        .run(displayName, normalizeEmail(body.email), textValue(body.department || "인사", 80), hash, salt, now, now);
      db.prepare("DELETE FROM app_meta WHERE key='setup_token'").run();
    })();
    const session = createSession("admin");
    setSessionCookie(res, session);
    logActivity("admin_created", "최초 관리자(admin) 계정 생성", { username: "admin", name: displayName });
    return sendJson(res, 201, { ok: true, username: "admin" });
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    assertSameOrigin(req);
    const body = await readJson(req);
    const ip = clientIp(req);
    enforceLoginRate(ip);
    const username = String(body.username || "").trim().toLowerCase();
    const user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
    if (!user || !user.active || !verifyPassword(String(body.password || ""), user)) {
      recordLoginFailure(ip);
      throw httpError(401, "아이디 또는 비밀번호를 확인하세요.");
    }
    loginAttempts.delete(ip);
    const session = createSession(username);
    setSessionCookie(res, session);
    logActivity("login", `${user.display_name} 로그인`, { username, name: user.display_name });
    return sendJson(res, 200, { ok: true, actor: { username, name: user.display_name, email: user.email, department: user.department, role: user.role, mustChangePassword: Boolean(user.must_change_password) } });
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    assertSameOrigin(req);
    const token = cookieValue(req, "hr_session");
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha256(token));
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/me") return sendJson(res, 200, { actor: actorFromRequest(req) });
  if (req.method === "GET" && url.pathname === "/api/hr") {
    const actor = requireActor(req);
    void maybeSyncSaraminPostings().catch((error) => console.error("saramin_background_sync_error", error.message));
    return sendJson(res, 200, getHrData(actor, rangeFromUrl(url)));
  }

  const actor = requireActor(req);
  if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);

  if (req.method === "POST" && url.pathname === "/api/job-postings/sync") {
    requireAdmin(actor);
    if (!saraminConnected()) throw httpError(409, "사람인 API 키가 아직 연결되지 않았습니다.");
    const result = await maybeSyncSaraminPostings(true, actor);
    return sendJson(res, 200, { ok: true, ...result });
  }

  const candidateTimelineMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)\/timeline$/);
  if (candidateTimelineMatch && req.method === "GET") {
    const candidateId = decodeURIComponent(candidateTimelineMatch[1]);
    return sendJson(res, 200, candidateDetail(candidateId));
  }

  const candidateActivityCreateMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)\/activities$/);
  if (candidateActivityCreateMatch && req.method === "POST") {
    requireWrite(actor);
    const candidateId = decodeURIComponent(candidateActivityCreateMatch[1]);
    const candidate = db.prepare("SELECT * FROM candidates WHERE id=?").get(candidateId);
    if (!candidate) throw httpError(404, "후보자를 찾을 수 없습니다.");
    const body = await readJson(req);
    const applicationId = textValue(body.applicationId, 100);
    const application = db.prepare("SELECT * FROM applications WHERE id=? AND candidate_id=?").get(applicationId, candidateId);
    if (!application) throw httpError(400, "후보자의 지원 포지션을 선택하세요.");
    const input = normalizeCandidateActivityInput(body, application);
    const context = recruitingContext(application);
    const id = `cact-${randomBytes(9).toString("hex")}`;
    const recruitingActivityId = `act-${randomBytes(9).toString("hex")}`;
    const now = new Date().toISOString();
    const previousState = applicationPreviousState(application);
    db.transaction(() => {
      db.prepare(`INSERT INTO recruiting_activities
        (id,activity_date,department,position,requisition_id,candidate_id,application_id,activity_type,source,count,accepted_count,candidate_name,owner_username,owner_name,details,next_action_at,created_by_username,created_by_name,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(recruitingActivityId, input.activityDate, context.department, context.position, application.requisition_id, candidateId, applicationId, input.activityType, context.source, 1, 0, candidate.name, actor.username, actor.name, input.summary, input.nextActionAt, actor.username, actor.name, now, now);
      db.prepare(`INSERT INTO candidate_activities
        (id,candidate_id,application_id,recruiting_activity_id,activity_date,activity_type,stage_after,outcome,summary,next_activity,next_action_at,target_date,previous_state_json,created_by_username,created_by_name,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, candidateId, applicationId, recruitingActivityId, input.activityDate, input.activityType, input.stageAfter, input.outcome, input.summary, input.nextActivity, input.nextActionAt, input.targetDate, JSON.stringify(previousState), actor.username, actor.name, now, now);
      applyApplicationActivity(application, input, now);
      logActivity("candidate_activity_created", `${candidate.name} 후보자 활동 등록`, actor, { candidateId, applicationId, candidateActivityId: id, activityType: input.activityType, stageAfter: input.stageAfter });
    })();
    return sendJson(res, 201, { ok: true, id });
  }

  const candidateActivityMatch = url.pathname.match(/^\/api\/candidate-activities\/([^/]+)$/);
  if (candidateActivityMatch && req.method === "PATCH") {
    requireWrite(actor);
    const id = decodeURIComponent(candidateActivityMatch[1]);
    const current = db.prepare("SELECT * FROM candidate_activities WHERE id=?").get(id);
    if (!current) throw httpError(404, "후보자 활동을 찾을 수 없습니다.");
    const application = db.prepare("SELECT * FROM applications WHERE id=?").get(current.application_id);
    if (!application) throw httpError(404, "후보자 지원이력을 찾을 수 없습니다.");
    const input = normalizeCandidateActivityInput(await readJson(req), application, current);
    const context = recruitingContext(application);
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`UPDATE candidate_activities SET activity_date=?,activity_type=?,stage_after=?,outcome=?,summary=?,next_activity=?,next_action_at=?,target_date=?,updated_at=? WHERE id=?`)
        .run(input.activityDate, input.activityType, input.stageAfter, input.outcome, input.summary, input.nextActivity, input.nextActionAt, input.targetDate, now, id);
      if (current.recruiting_activity_id) {
        db.prepare(`UPDATE recruiting_activities SET activity_date=?,department=?,position=?,requisition_id=?,candidate_id=?,application_id=?,activity_type=?,source=?,details=?,next_action_at=?,owner_username=?,owner_name=?,updated_at=? WHERE id=?`)
          .run(input.activityDate, context.department, context.position, application.requisition_id, current.candidate_id, current.application_id, input.activityType, context.source, input.summary, input.nextActionAt, actor.username, actor.name, now, current.recruiting_activity_id);
      }
      const latest = latestCandidateActivity(current.application_id);
      if (latest) applyApplicationActivity(application, candidateActivityRecord(latest), now);
      logActivity("candidate_activity_updated", "후보자 활동 수정", actor, { candidateId: current.candidate_id, applicationId: current.application_id, candidateActivityId: id });
    })();
    return sendJson(res, 200, { ok: true });
  }
  if (candidateActivityMatch && req.method === "DELETE") {
    requireWrite(actor);
    const id = decodeURIComponent(candidateActivityMatch[1]);
    const current = db.prepare("SELECT * FROM candidate_activities WHERE id=?").get(id);
    if (!current) throw httpError(404, "후보자 활동을 찾을 수 없습니다.");
    const application = current.application_id ? db.prepare("SELECT * FROM applications WHERE id=?").get(current.application_id) : null;
    const wasLatest = current.application_id ? candidateActivityIsLatest(current) : false;
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare("DELETE FROM candidate_activities WHERE id=?").run(id);
      if (current.recruiting_activity_id) db.prepare("DELETE FROM recruiting_activities WHERE id=?").run(current.recruiting_activity_id);
      if (application && wasLatest) {
        const previous = latestCandidateActivity(current.application_id);
        if (previous) applyApplicationActivity(application, candidateActivityRecord(previous), now);
        else applyApplicationActivity(application, parseJson(current.previous_state_json), now);
      }
      logActivity("candidate_activity_deleted", "후보자 활동 삭제", actor, { candidateId: current.candidate_id, applicationId: current.application_id, candidateActivityId: id });
    })();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/job-postings") {
    requireAdmin(actor);
    const input = normalizeJobPostingInput(await readJson(req));
    const id = `posting-${randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();
    try {
      db.prepare(`INSERT INTO job_postings
        (id,saramin_id,title,department,location,experience,job_type,education,opening_date,expiration_date,close_type,url,status,view_count,apply_count,requisition_id,source,last_synced_at,created_by_username,created_by_name,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? ,NULL,?,?,?,?)`)
        .run(id, input.saraminId, input.title, input.department, input.location, input.experience, input.jobType, input.education, input.openingDate, input.expirationDate, input.closeType, input.url, input.status, input.viewCount, input.applyCount, input.requisitionId, "manual", actor.username, actor.name, now, now);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw httpError(409, "이미 등록된 사람인 공고번호입니다.");
      throw error;
    }
    logActivity("job_posting_created", `${input.title} 채용공고 등록`, actor, { postingId: id, requisitionId: input.requisitionId });
    return sendJson(res, 201, { ok: true, id });
  }

  const jobPostingMatch = url.pathname.match(/^\/api\/job-postings\/([^/]+)$/);
  if (jobPostingMatch && req.method === "PATCH") {
    requireAdmin(actor);
    const id = decodeURIComponent(jobPostingMatch[1]);
    const current = db.prepare("SELECT * FROM job_postings WHERE id=?").get(id);
    if (!current) throw httpError(404, "채용공고를 찾을 수 없습니다.");
    const input = normalizeJobPostingInput(await readJson(req), current);
    const now = new Date().toISOString();
    try {
      db.prepare(`UPDATE job_postings SET saramin_id=?,title=?,department=?,location=?,experience=?,job_type=?,education=?,opening_date=?,expiration_date=?,close_type=?,url=?,status=?,view_count=?,apply_count=?,requisition_id=?,updated_at=? WHERE id=?`)
        .run(input.saraminId, input.title, input.department, input.location, input.experience, input.jobType, input.education, input.openingDate, input.expirationDate, input.closeType, input.url, input.status, input.viewCount, input.applyCount, input.requisitionId, now, id);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw httpError(409, "이미 등록된 사람인 공고번호입니다.");
      throw error;
    }
    logActivity("job_posting_updated", `${input.title} 채용공고 수정`, actor, { postingId: id, status: input.status, requisitionId: input.requisitionId });
    return sendJson(res, 200, { ok: true });
  }
  if (jobPostingMatch && req.method === "DELETE") {
    requireAdmin(actor);
    const id = decodeURIComponent(jobPostingMatch[1]);
    const current = db.prepare("SELECT * FROM job_postings WHERE id=?").get(id);
    if (!current) throw httpError(404, "채용공고를 찾을 수 없습니다.");
    db.transaction(() => {
      db.prepare("DELETE FROM job_postings WHERE id=?").run(id);
      logActivity("job_posting_deleted", `${current.title} 채용공고 삭제`, actor, { postingId: id, saraminId: current.saramin_id });
    })();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/recruiting-activities") {
    requireWrite(actor);
    const input = normalizeActivityInput(await readJson(req), actor);
    const id = `act-${randomBytes(9).toString("hex")}`;
    const now = new Date().toISOString();
    const previousState = input.applicationId ? applicationPreviousState(db.prepare("SELECT * FROM applications WHERE id=?").get(input.applicationId)) : {};
    db.transaction(() => {
      db.prepare(`INSERT INTO recruiting_activities
        (id,activity_date,department,position,requisition_id,candidate_id,application_id,activity_type,source,count,accepted_count,candidate_name,owner_username,owner_name,details,next_action_at,interview_location,interviewer_names,interview_round,interview_duration,interview_status,interview_result,rejection_reason,result_notes,previous_state_json,created_by_username,created_by_name,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.activityDate, input.department, input.position, input.requisitionId, input.candidateId, input.applicationId, input.activityType, input.source, input.count, input.acceptedCount, input.candidateName, actor.username, input.ownerName, input.details, input.nextActionAt, input.interviewLocation, input.interviewerNames, input.interviewRound, input.interviewDuration, input.interviewStatus, input.interviewResult, input.rejectionReason, input.resultNotes, JSON.stringify(previousState), actor.username, actor.name, now, now);
      syncInterviewApplication(input, now);
      logActivity("recruiting_activity_created", `${input.ownerName} 채용활동 등록: ${input.position} ${input.count}건`, actor, { activityId: id, activityType: input.activityType, applicationId: input.applicationId, interviewResult: input.interviewResult });
    })();
    return sendJson(res, 201, { ok: true, id });
  }

  const recruitingActivityMatch = url.pathname.match(/^\/api\/recruiting-activities\/([^/]+)$/);
  if (recruitingActivityMatch && req.method === "PATCH") {
    requireWrite(actor);
    const id = decodeURIComponent(recruitingActivityMatch[1]);
    const current = db.prepare("SELECT * FROM recruiting_activities WHERE id=?").get(id);
    if (!current) throw httpError(404, "채용활동을 찾을 수 없습니다.");
    assertActivityOwnership(actor, current);
    const input = normalizeActivityInput(await readJson(req), actor, current);
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`UPDATE recruiting_activities SET activity_date=?,department=?,position=?,requisition_id=?,candidate_id=?,application_id=?,activity_type=?,source=?,count=?,accepted_count=?,candidate_name=?,owner_name=?,details=?,next_action_at=?,interview_location=?,interviewer_names=?,interview_round=?,interview_duration=?,interview_status=?,interview_result=?,rejection_reason=?,result_notes=?,updated_at=? WHERE id=?`)
        .run(input.activityDate, input.department, input.position, input.requisitionId, input.candidateId, input.applicationId, input.activityType, input.source, input.count, input.acceptedCount, input.candidateName, input.ownerName, input.details, input.nextActionAt, input.interviewLocation, input.interviewerNames, input.interviewRound, input.interviewDuration, input.interviewStatus, input.interviewResult, input.rejectionReason, input.resultNotes, now, id);
      syncInterviewApplication(input, now);
      logActivity("recruiting_activity_updated", `${input.ownerName} 채용활동 수정`, actor, { activityId: id, applicationId: input.applicationId, interviewResult: input.interviewResult });
    })();
    return sendJson(res, 200, { ok: true });
  }
  if (recruitingActivityMatch && req.method === "DELETE") {
    requireWrite(actor);
    const id = decodeURIComponent(recruitingActivityMatch[1]);
    const current = db.prepare("SELECT * FROM recruiting_activities WHERE id=?").get(id);
    if (!current) throw httpError(404, "채용활동을 찾을 수 없습니다.");
    assertActivityOwnership(actor, current);
    db.transaction(() => {
      db.prepare("DELETE FROM recruiting_activities WHERE id=?").run(id);
      if (current.application_id && ["interview_scheduled", "reinterview_scheduled", "interview_conducted"].includes(current.activity_type)) {
        const application = db.prepare("SELECT * FROM applications WHERE id=?").get(current.application_id);
        if (application) {
          const latestCandidate = latestCandidateActivity(current.application_id);
          const laterInterview = db.prepare(`SELECT * FROM recruiting_activities WHERE application_id=? AND activity_type IN ('interview_scheduled','reinterview_scheduled','interview_conducted') ORDER BY COALESCE(next_action_at,activity_date) DESC,updated_at DESC LIMIT 1`).get(current.application_id);
          if (latestCandidate && String(latestCandidate.activity_date) >= String(current.activity_date)) applyApplicationActivity(application, candidateActivityRecord(latestCandidate), new Date().toISOString());
          else if (laterInterview) syncInterviewApplication(activityRecord(laterInterview), new Date().toISOString());
          else applyApplicationActivity(application, parseJson(current.previous_state_json), new Date().toISOString());
        }
      }
      logActivity("recruiting_activity_deleted", `${current.owner_name} 채용활동 삭제`, actor, { activityId: id, activityType: current.activity_type, activityDate: current.activity_date });
    })();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/workforce-plans") {
    requireWrite(actor);
    const input = normalizeWorkforceInput(await readJson(req));
    const id = `workforce-${randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workforce_plans
      (id,department,position,approved_headcount,current_headcount,recruiting_to,joining_planned,leaving_planned,as_of_date,note,current_members,recruit_plan,as_is_tasks,to_be_tasks,future_plan,created_by_username,created_by_name,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.department, input.position, input.approvedHeadcount, input.currentHeadcount, input.recruitingTo, input.joiningPlanned, input.leavingPlanned, input.asOfDate, input.note, input.currentMembers, input.recruitPlan, input.asIsTasks, input.toBeTasks, input.futurePlan, actor.username, actor.name, now, now);
    logActivity("workforce_created", `${input.department} ${input.position} 인원·TO 등록`, actor, { workforceId: id });
    return sendJson(res, 201, { ok: true, id });
  }

  const workforceMatch = url.pathname.match(/^\/api\/workforce-plans\/([^/]+)$/);
  if (workforceMatch && req.method === "PATCH") {
    requireWrite(actor);
    const id = decodeURIComponent(workforceMatch[1]);
    const current = db.prepare("SELECT * FROM workforce_plans WHERE id=?").get(id);
    if (!current) throw httpError(404, "인원·TO 항목을 찾을 수 없습니다.");
    const input = normalizeWorkforceInput(await readJson(req), current);
    const now = new Date().toISOString();
    db.prepare(`UPDATE workforce_plans SET department=?,position=?,approved_headcount=?,current_headcount=?,recruiting_to=?,joining_planned=?,leaving_planned=?,as_of_date=?,note=?,current_members=?,recruit_plan=?,as_is_tasks=?,to_be_tasks=?,future_plan=?,updated_at=? WHERE id=?`)
      .run(input.department, input.position, input.approvedHeadcount, input.currentHeadcount, input.recruitingTo, input.joiningPlanned, input.leavingPlanned, input.asOfDate, input.note, input.currentMembers, input.recruitPlan, input.asIsTasks, input.toBeTasks, input.futurePlan, now, id);
    logActivity("workforce_updated", `${input.department} ${input.position} 인원·TO 수정`, actor, { workforceId: id });
    return sendJson(res, 200, { ok: true });
  }
  if (workforceMatch && req.method === "DELETE") {
    requireWrite(actor);
    const id = decodeURIComponent(workforceMatch[1]);
    const current = db.prepare("SELECT * FROM workforce_plans WHERE id=?").get(id);
    if (!current) throw httpError(404, "인원·TO 항목을 찾을 수 없습니다.");
    db.transaction(() => {
      db.prepare("DELETE FROM workforce_plans WHERE id=?").run(id);
      logActivity("workforce_deleted", `${current.department} ${current.position} 인원·TO 삭제`, actor, { workforceId: id });
    })();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/hr-meetings/analyze") {
    requireWrite(actor);
    const analysis = analyzeMeetingText(await readJson(req));
    logActivity("hr_meeting_analyzed", "HR 회의록 자동 분석 실행", actor, { actionCount: analysis.actions.length });
    return sendJson(res, 200, { ok: true, analysis });
  }

  if (req.method === "POST" && url.pathname === "/api/hr-meetings") {
    requireWrite(actor);
    const input = normalizeMeetingInput(await readJson(req));
    const id = `meeting-${randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO hr_meetings
      (id,meeting_date,title,agenda,minutes,key_discussions,participants,transcript,decisions,issues,analysis_json,analysis_status,analysis_confirmed_at,analysis_confirmed_by,status,created_by_username,created_by_name,updated_by_username,updated_by_name,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.meetingDate, input.title, input.agenda, input.minutes, input.keyDiscussions, input.participants, input.transcript, input.decisions, input.issues, input.analysisJson, input.analysisStatus, input.analysisStatus === "reviewed" ? now : null, input.analysisStatus === "reviewed" ? actor.name : null, input.status, actor.username, actor.name, actor.username, actor.name, now, now);
    logActivity("hr_meeting_created", `${input.title} HR 회의 등록`, actor, { meetingId: id, meetingDate: input.meetingDate });
    return sendJson(res, 201, { ok: true, id });
  }

  const meetingMatch = url.pathname.match(/^\/api\/hr-meetings\/([^/]+)$/);
  if (meetingMatch && req.method === "PATCH") {
    requireWrite(actor);
    const id = decodeURIComponent(meetingMatch[1]);
    const current = db.prepare("SELECT * FROM hr_meetings WHERE id=?").get(id);
    if (!current) throw httpError(404, "HR 회의를 찾을 수 없습니다.");
    const input = normalizeMeetingInput(await readJson(req), current);
    const now = new Date().toISOString();
    db.prepare(`UPDATE hr_meetings SET meeting_date=?,title=?,agenda=?,minutes=?,key_discussions=?,participants=?,transcript=?,decisions=?,issues=?,analysis_json=?,analysis_status=?,analysis_confirmed_at=?,analysis_confirmed_by=?,status=?,updated_by_username=?,updated_by_name=?,updated_at=? WHERE id=?`)
      .run(input.meetingDate, input.title, input.agenda, input.minutes, input.keyDiscussions, input.participants, input.transcript, input.decisions, input.issues, input.analysisJson, input.analysisStatus, input.analysisStatus === "reviewed" ? (current.analysis_confirmed_at || now) : null, input.analysisStatus === "reviewed" ? actor.name : null, input.status, actor.username, actor.name, now, id);
    logActivity("hr_meeting_updated", `${input.title} HR 회의 수정`, actor, { meetingId: id });
    return sendJson(res, 200, { ok: true, id });
  }
  if (meetingMatch && req.method === "DELETE") {
    requireWrite(actor);
    const id = decodeURIComponent(meetingMatch[1]);
    const current = db.prepare("SELECT * FROM hr_meetings WHERE id=?").get(id);
    if (!current) throw httpError(404, "HR 회의를 찾을 수 없습니다.");
    db.transaction(() => {
      db.prepare("DELETE FROM hr_meetings WHERE id=?").run(id);
      logActivity("hr_meeting_deleted", `${current.title} HR 회의 삭제`, actor, { meetingId: id });
    })();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/action-items") {
    requireWrite(actor);
    const input = normalizeActionItemInput(await readJson(req));
    const id = `action-${randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO action_items
      (id,meeting_id,title,details,assignee_username,assignee_name,due_date,priority,status,notification_scope,created_by_username,created_by_name,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.meetingId, input.title, input.details, input.assigneeUsername, input.assigneeName, input.dueDate, input.priority, input.status, input.notificationScope, actor.username, actor.name, now, now);
    logActivity("action_item_created", `${input.assigneeName || "전체"} 액션플랜 등록: ${input.title}`, actor, { actionItemId: id, meetingId: input.meetingId, dueDate: input.dueDate });
    return sendJson(res, 201, { ok: true, id });
  }

  const actionItemMatch = url.pathname.match(/^\/api\/action-items\/([^/]+)$/);
  if (actionItemMatch && req.method === "PATCH") {
    requireWrite(actor);
    const id = decodeURIComponent(actionItemMatch[1]);
    const current = db.prepare("SELECT * FROM action_items WHERE id=?").get(id);
    if (!current) throw httpError(404, "액션플랜을 찾을 수 없습니다.");
    const input = normalizeActionItemInput(await readJson(req), current);
    const now = new Date().toISOString();
    db.prepare(`UPDATE action_items SET meeting_id=?,title=?,details=?,assignee_username=?,assignee_name=?,due_date=?,priority=?,status=?,notification_scope=?,updated_at=? WHERE id=?`)
      .run(input.meetingId, input.title, input.details, input.assigneeUsername, input.assigneeName, input.dueDate, input.priority, input.status, input.notificationScope, now, id);
    logActivity("action_item_updated", `${input.title} 액션플랜 수정`, actor, { actionItemId: id, status: input.status, dueDate: input.dueDate });
    return sendJson(res, 200, { ok: true });
  }
  if (actionItemMatch && req.method === "DELETE") {
    requireWrite(actor);
    const id = decodeURIComponent(actionItemMatch[1]);
    const current = db.prepare("SELECT * FROM action_items WHERE id=?").get(id);
    if (!current) throw httpError(404, "액션플랜을 찾을 수 없습니다.");
    db.transaction(() => {
      db.prepare("DELETE FROM action_items WHERE id=?").run(id);
      logActivity("action_item_deleted", `${current.title} 액션플랜 삭제`, actor, { actionItemId: id });
    })();
    return sendJson(res, 200, { ok: true });
  }

  const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
  if (goalMatch && req.method === "PATCH") {
    requireWrite(actor);
    const id = decodeURIComponent(goalMatch[1]);
    const current = getRequisitions().find((goal) => goal.id === id);
    if (!current) throw httpError(404, "채용목표를 찾을 수 없습니다.");
    const input = normalizeGoalInput(await readJson(req), current);
    const data = goalDataPayload(id, input, current);
    const now = new Date().toISOString();
    db.prepare(`UPDATE requisitions SET status=?,priority=?,target_date=?,original_target_date=?,checkpoint_date=?,revised_target_date=?,backup_plan=?,goal_status=?,data_json=?,updated_at=? WHERE id=?`)
      .run(data.status, input.priority, input.targetDate, input.originalTargetDate, input.checkpointDate, input.revisedTargetDate, input.backupPlan, input.goalStatus, JSON.stringify(data), now, id);
    logActivity("goal_updated", `${input.title} 채용목표 수정`, actor, { requisitionId: id, targetDate: input.targetDate, checkpointDate: input.checkpointDate });
    return sendJson(res, 200, { ok: true });
  }
  if (goalMatch && req.method === "DELETE") {
    requireWrite(actor);
    const id = decodeURIComponent(goalMatch[1]);
    const current = getRequisitions().find((goal) => goal.id === id);
    if (!current) throw httpError(404, "채용목표를 찾을 수 없습니다.");
    const linked = {
      activities: db.prepare("SELECT COUNT(*) AS value FROM recruiting_activities WHERE requisition_id=?").get(id).value,
      applications: db.prepare("SELECT COUNT(*) AS value FROM applications WHERE requisition_id=?").get(id).value,
      checkpoints: db.prepare("SELECT COUNT(*) AS value FROM goal_checkpoints WHERE requisition_id=?").get(id).value
    };
    db.transaction(() => {
      db.prepare("DELETE FROM requisitions WHERE id=?").run(id);
      logActivity("goal_deleted", `${current.title} 채용목표 삭제`, actor, { requisitionId: id, ...linked });
    })();
    return sendJson(res, 200, { ok: true, unlinkedActivities: linked.activities, unlinkedApplications: linked.applications, deletedCheckpoints: linked.checkpoints });
  }

  const checkpointMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/checkpoints$/);
  if (checkpointMatch && req.method === "POST") {
    requireWrite(actor);
    const requisitionId = decodeURIComponent(checkpointMatch[1]);
    const current = getRequisitions().find((goal) => goal.id === requisitionId);
    if (!current) throw httpError(404, "채용목표를 찾을 수 없습니다.");
    const body = await readJson(req);
    const summary = textValue(body.summary, 1800);
    if (!summary) throw httpError(400, "중간점검 내용을 입력하세요.");
    const checkpointDate = dateValue(body.checkpointDate || isoToday(), true);
    const progressPercent = integer(body.progressPercent, buildGoals().find((goal) => goal.id === requisitionId)?.progress || 0, 100);
    const newTargetDate = dateValue(body.newTargetDate);
    const backupPlan = textValue(body.backupPlan ?? current.backupPlan, 1800);
    const risks = textValue(body.risks, 1800);
    const previousTargetDate = current.targetDate;
    const id = `check-${randomBytes(9).toString("hex")}`;
    const now = new Date().toISOString();
    const data = { ...current, backupPlan, lastCheckpointAt: checkpointDate, lastCheckpointSummary: summary };
    if (newTargetDate && newTargetDate !== previousTargetDate) {
      data.revisedTargetDate = newTargetDate;
      data.currentTargetDate = newTargetDate;
      data.targetDate = newTargetDate;
    }
    db.transaction(() => {
      db.prepare(`INSERT INTO goal_checkpoints
        (id,requisition_id,checkpoint_date,progress_percent,review_status,summary,risks,backup_plan,previous_target_date,revised_target_date,created_by_username,created_by_name,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, requisitionId, checkpointDate, progressPercent, risks || backupPlan ? "action_required" : "reviewed", summary, risks || null, backupPlan || null, previousTargetDate, newTargetDate || null, actor.username, actor.name, now);
      db.prepare("UPDATE requisitions SET target_date=?,revised_target_date=?,backup_plan=?,data_json=?,updated_at=? WHERE id=?")
        .run(newTargetDate || previousTargetDate, newTargetDate || current.revisedTargetDate || null, backupPlan, JSON.stringify(data), now, requisitionId);
      logActivity("goal_checkpoint", `${current.title} 중간점검 완료`, actor, { requisitionId, progressPercent, previousTargetDate, newTargetDate });
    })();
    return sendJson(res, 201, { ok: true, id });
  }

  const checkpointRecordMatch = url.pathname.match(/^\/api\/checkpoints\/([^/]+)$/);
  if (checkpointRecordMatch && req.method === "PATCH") {
    requireWrite(actor);
    const id = decodeURIComponent(checkpointRecordMatch[1]);
    const current = db.prepare("SELECT * FROM goal_checkpoints WHERE id=?").get(id);
    if (!current) throw httpError(404, "중간점검 기록을 찾을 수 없습니다.");
    const goal = getRequisitions().find((item) => item.id === current.requisition_id);
    if (!goal) throw httpError(404, "연결된 채용목표를 찾을 수 없습니다.");
    const body = await readJson(req);
    const checkpointDate = dateValue(body.checkpointDate ?? current.checkpoint_date, true);
    const progressPercent = integer(body.progressPercent ?? current.progress_percent, current.progress_percent, 100);
    const summary = textValue(body.summary ?? current.summary, 1800);
    const risks = textValue(body.risks ?? current.risks, 1800);
    const backupPlan = textValue(body.backupPlan ?? current.backup_plan, 1800);
    const newTargetDate = dateValue(body.newTargetDate ?? current.revised_target_date);
    if (!summary) throw httpError(400, "중간점검 내용을 입력하세요.");
    const latestId = db.prepare("SELECT id FROM goal_checkpoints WHERE requisition_id=? ORDER BY checkpoint_date DESC,created_at DESC LIMIT 1").get(current.requisition_id)?.id;
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`UPDATE goal_checkpoints SET checkpoint_date=?,progress_percent=?,review_status=?,summary=?,risks=?,backup_plan=?,revised_target_date=? WHERE id=?`)
        .run(checkpointDate, progressPercent, risks || backupPlan ? "action_required" : "reviewed", summary, risks || null, backupPlan || null, newTargetDate || null, id);
      if (latestId === id) {
        const targetDate = newTargetDate || goal.originalTargetDate || goal.targetDate || null;
        const data = { ...goal, backupPlan, lastCheckpointAt: checkpointDate, lastCheckpointSummary: summary, revisedTargetDate: newTargetDate, currentTargetDate: targetDate, targetDate };
        db.prepare("UPDATE requisitions SET target_date=?,revised_target_date=?,backup_plan=?,data_json=?,updated_at=? WHERE id=?")
          .run(targetDate, newTargetDate || null, backupPlan || null, JSON.stringify(data), now, current.requisition_id);
      }
      logActivity("goal_checkpoint_updated", `${goal.title} 중간점검 수정`, actor, { checkpointId: id, requisitionId: current.requisition_id, progressPercent });
    })();
    return sendJson(res, 200, { ok: true });
  }
  if (checkpointRecordMatch && req.method === "DELETE") {
    requireWrite(actor);
    const id = decodeURIComponent(checkpointRecordMatch[1]);
    const current = db.prepare("SELECT * FROM goal_checkpoints WHERE id=?").get(id);
    if (!current) throw httpError(404, "중간점검 기록을 찾을 수 없습니다.");
    const goal = getRequisitions().find((item) => item.id === current.requisition_id);
    db.transaction(() => {
      db.prepare("DELETE FROM goal_checkpoints WHERE id=?").run(id);
      logActivity("goal_checkpoint_deleted", `${goal?.title || "채용목표"} 중간점검 삭제`, actor, { checkpointId: id, requisitionId: current.requisition_id });
    })();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/reports/close") {
    requireWrite(actor);
    const body = await readJson(req);
    const allowedReportTypes = new Set(["daily", "week", "month", "performance_1", "performance_2", "performance_3"]);
    const periodType = allowedReportTypes.has(body.periodType) ? body.periodType : null;
    if (!periodType) throw httpError(400, "보고서 유형을 확인하세요.");
    const from = dateValue(body.from, true);
    const to = dateValue(body.to, true);
    if (from > to || daysBetween(from, to) > 40) throw httpError(400, "마감 기간을 확인하세요.");
    const goals = buildGoals();
    const reportActivities = getRecruitingActivities(from, to);
    const report = buildReport(reportActivities, goals, from, to);
    report.executive = buildExecutiveReport(reportActivities, goals, candidatePipelineRows(), from, to);
    const id = `report-${periodType}-${from}-${to}`;
    const now = new Date().toISOString();
    db.transaction(() => {
      const previousReportId = textValue(body.previousReportId, 180);
      if (previousReportId && previousReportId !== id) db.prepare("DELETE FROM report_snapshots WHERE id=?").run(previousReportId);
      db.prepare(`INSERT INTO report_snapshots (id,period_type,period_start,period_end,summary_json,note,closed_by_username,closed_by_name,closed_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(period_type,period_start,period_end) DO UPDATE SET summary_json=excluded.summary_json,note=excluded.note,closed_by_username=excluded.closed_by_username,closed_by_name=excluded.closed_by_name,closed_at=excluded.closed_at`)
        .run(id, periodType, from, to, JSON.stringify(report), textValue(body.note, 1800) || null, actor.username, actor.name, now);
    })();
    const reportTypeLabels = { daily: "일일 HR 활동", week: "주간 마감", month: "월간 마감", performance_1: "1차 실적회의", performance_2: "2차 실적회의", performance_3: "3차 실적회의" };
    logActivity("report_closed", `${reportTypeLabels[periodType]} 보고 저장`, actor, { from, to, reportId: id });
    return sendJson(res, 201, { ok: true, id });
  }

  const reportMatch = url.pathname.match(/^\/api\/reports\/([^/]+)$/);
  if (reportMatch && req.method === "DELETE") {
    requireWrite(actor);
    const id = decodeURIComponent(reportMatch[1]);
    const current = db.prepare("SELECT * FROM report_snapshots WHERE id=?").get(id);
    if (!current) throw httpError(404, "마감 보고를 찾을 수 없습니다.");
    db.transaction(() => {
      db.prepare("DELETE FROM report_snapshots WHERE id=?").run(id);
      logActivity("report_deleted", `${current.period_type} HR 보고 삭제`, actor, { reportId: id, from: current.period_start, to: current.period_end });
    })();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/candidates") {
    requireWrite(actor);
    const body = await readJson(req);
    const name = textValue(body.name, 80);
    if (!name) throw httpError(400, "후보자 이름은 필수입니다.");
    const now = new Date().toISOString();
    const candidateId = `cand-${randomBytes(8).toString("hex")}`;
    const applicationId = `app-${randomBytes(8).toString("hex")}`;
    const requisitionId = textValue(body.requisitionId, 100) || null;
    const sourceChannel = textValue(body.sourceChannel || "기타", 80);
    const candidate = { id: candidateId, name, gender: body.gender || null, age: integer(body.age, 0, 100) || null, experienceText: textValue(body.experienceText, 120), phone: textValue(body.phone, 40) || null, email: normalizeEmail(body.email), mergeReview: false };
    const targetDate = dateValue(body.targetDate);
    const nextActionAt = dateTimeValue(body.nextActionAt);
    const application = { id: applicationId, candidateId, requisitionId, sourceChannel, stage: "sourced", outcome: null, ownerName: actor.name, nextActivity: textValue(body.nextActivity, 300) || null, nextActionAt, targetDate, memo: textValue(body.memo, 1200), isTalentPool: false, sourceSheet: "프로그램 직접등록", archivedAt: null, lastActivityAt: now };
    const goal = requisitionId ? getRequisitions().find((item) => item.id === requisitionId) : null;
    const source = sourceChannel.includes("사람인") ? "saramin" : sourceChannel.includes("DM") ? "dm" : sourceChannel.includes("과거") ? "past_pool" : "other";
    const recruitingActivityId = `act-${randomBytes(9).toString("hex")}`;
    const candidateActivityId = `cact-${randomBytes(9).toString("hex")}`;
    db.transaction(() => {
      db.prepare("INSERT INTO candidates (id,name,data_json,created_at,updated_at) VALUES (?,?,?,?,?)").run(candidateId, name, JSON.stringify(candidate), now, now);
      db.prepare("INSERT INTO applications (id,candidate_id,requisition_id,stage,outcome,is_talent_pool,archived_at,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(applicationId, candidateId, requisitionId, "sourced", null, 0, null, JSON.stringify(application), now, now);
      db.prepare(`INSERT INTO recruiting_activities
        (id,activity_date,department,position,requisition_id,candidate_id,application_id,activity_type,source,count,accepted_count,candidate_name,owner_username,owner_name,details,next_action_at,created_by_username,created_by_name,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(recruitingActivityId, isoToday(), goal?.division || actor.department || "미지정", goal?.functionName || textValue(body.position || "미지정", 100), requisitionId, candidateId, applicationId, "application_received", source, 1, 0, name, actor.username, actor.name, "후보자 직접 등록", nextActionAt, actor.username, actor.name, now, now);
      db.prepare(`INSERT INTO candidate_activities
        (id,candidate_id,application_id,recruiting_activity_id,activity_date,activity_type,stage_after,outcome,summary,next_activity,next_action_at,target_date,previous_state_json,created_by_username,created_by_name,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(candidateActivityId, candidateId, applicationId, recruitingActivityId, isoToday(), "application_received", "sourced", null, "후보자 직접 등록", application.nextActivity, nextActionAt, targetDate, JSON.stringify({ stage: "sourced", outcome: null, isTalentPool: false, archivedAt: null, nextActivity: null, nextActionAt: null, targetDate: null, lastActivityAt: null }), actor.username, actor.name, now, now);
      logActivity("candidate_created", `${name} 후보자 등록`, actor, { candidateId, applicationId });
    })();
    return sendJson(res, 201, { ok: true, candidateId, applicationId });
  }

  const applicationMatch = url.pathname.match(/^\/api\/applications\/([^/]+)$/);
  if (applicationMatch && req.method === "PATCH") {
    requireWrite(actor);
    const id = decodeURIComponent(applicationMatch[1]);
    const body = await readJson(req);
    const stage = textValue(body.stage, 40);
    if (!STAGES.has(stage)) throw httpError(400, "유효한 진행단계를 선택하세요.");
    const current = db.prepare("SELECT * FROM applications WHERE id=?").get(id);
    if (!current) throw httpError(404, "후보자 지원이력을 찾을 수 없습니다.");
    const currentData = parseJson(current.data_json);
    const data = { ...currentData, stage, outcome: body.outcome || null, ownerName: textValue(body.ownerName ?? currentData.ownerName, 80), nextActionAt: body.nextActionAt || null, memo: textValue(body.memo ?? currentData.memo, 1200), isTalentPool: stage === "talent_pool", archivedAt: stage === "closed" ? new Date().toISOString() : null };
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare("UPDATE applications SET stage=?,outcome=?,is_talent_pool=?,archived_at=?,data_json=?,updated_at=? WHERE id=?")
        .run(stage, data.outcome, data.isTalentPool ? 1 : 0, data.archivedAt, JSON.stringify(data), now, id);
      logActivity("stage_changed", `후보자 단계 변경: ${current.stage} → ${stage}`, actor, { applicationId: id });
    })();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/requisitions") {
    requireWrite(actor);
    const input = normalizeGoalInput(await readJson(req));
    const id = `req-${randomBytes(8).toString("hex")}`;
    const data = goalDataPayload(id, input);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO requisitions
      (id,status,priority,target_date,data_json,created_at,updated_at,original_target_date,checkpoint_date,revised_target_date,backup_plan,goal_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, data.status, input.priority, input.targetDate, JSON.stringify(data), now, now, input.originalTargetDate, input.checkpointDate, input.revisedTargetDate, input.backupPlan, input.goalStatus);
    logActivity("requisition_created", `${input.title} 채용목표 등록`, actor, { requisitionId: id });
    return sendJson(res, 201, { ok: true, id });
  }

  if (req.method === "POST" && url.pathname === "/api/interviews") {
    requireWrite(actor);
    const body = await readJson(req);
    const applicationId = textValue(body.applicationId, 100);
    const application = db.prepare("SELECT * FROM applications WHERE id=? AND archived_at IS NULL").get(applicationId);
    if (!application || !body.scheduledAt) throw httpError(400, "진행 중인 후보자와 면접일시를 선택하세요.");
    const candidate = db.prepare("SELECT name FROM candidates WHERE id=?").get(application.candidate_id);
    const goal = application.requisition_id ? getRequisitions().find((item) => item.id === application.requisition_id) : null;
    const id = `int-${randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();
    const row = { id, applicationId, round: Math.max(1, integer(body.round, 1, 10)), mode: textValue(body.mode || "대면", 40), scheduledAt: body.scheduledAt, scheduledRaw: body.scheduledAt, status: "scheduled", interviewersJson: JSON.stringify(textValue(body.interviewers, 500).split(",").map((item) => item.trim()).filter(Boolean)), result: "", evaluation: "" };
    const applicationData = { ...parseJson(application.data_json), stage: "interview", firstInterviewRaw: body.scheduledAt };
    db.transaction(() => {
      db.prepare("INSERT INTO interviews (id,application_id,scheduled_at,status,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(id, applicationId, body.scheduledAt, "scheduled", JSON.stringify(row), now, now);
      db.prepare("UPDATE applications SET stage='interview',data_json=?,updated_at=? WHERE id=?").run(JSON.stringify(applicationData), now, applicationId);
      db.prepare(`INSERT INTO recruiting_activities
        (id,activity_date,department,position,requisition_id,activity_type,source,count,accepted_count,candidate_name,owner_username,owner_name,details,next_action_at,created_by_username,created_by_name,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(`act-${randomBytes(9).toString("hex")}`, isoToday(), goal?.division || actor.department || "미지정", goal?.functionName || "미지정", application.requisition_id, "interview_scheduled", "other", 1, 0, candidate?.name || null, actor.username, actor.name, `${row.round}차 ${row.mode} 면접`, body.scheduledAt, actor.username, actor.name, now, now);
      logActivity("interview_scheduled", `${row.round}차 면접 일정 등록`, actor, { interviewId: id, applicationId });
    })();
    return sendJson(res, 201, { ok: true, id });
  }

  if (req.method === "GET" && url.pathname === "/api/users") {
    requireAdmin(actor);
    return sendJson(res, 200, { users: listUsers() });
  }
  if (req.method === "POST" && url.pathname === "/api/users") {
    requireAdmin(actor);
    const body = await readJson(req);
    const username = normalizeUsername(body.username);
    const displayName = textValue(body.displayName, 80);
    const role = textValue(body.role || "recruiter", 20);
    if (!displayName || !ROLES.has(role)) throw httpError(400, "사용자 이름과 권한을 확인하세요.");
    validatePassword(body.password);
    const { salt, hash } = hashPassword(body.password);
    const now = new Date().toISOString();
    try {
      db.prepare("INSERT INTO users (username,display_name,email,department,role,password_hash,password_salt,active,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,0,?,?)")
        .run(username, displayName, normalizeEmail(body.email), textValue(body.department, 80) || null, role, hash, salt, now, now);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw httpError(409, "이미 등록된 아이디 또는 이메일입니다.");
      throw error;
    }
    logActivity("user_created", `${displayName} 사용자 등록 (${role})`, actor, { username, role });
    return sendJson(res, 201, { ok: true, username });
  }
  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === "PATCH") {
    requireAdmin(actor);
    const username = decodeURIComponent(userMatch[1]).toLowerCase();
    const current = db.prepare("SELECT * FROM users WHERE username=?").get(username);
    if (!current) throw httpError(404, "사용자를 찾을 수 없습니다.");
    const body = await readJson(req);
    const displayName = textValue(body.displayName ?? current.display_name, 80);
    const role = textValue(body.role ?? current.role, 20);
    const active = body.active === false || body.active === "false" ? 0 : 1;
    if (!displayName || !ROLES.has(role)) throw httpError(400, "사용자 정보가 올바르지 않습니다.");
    if (username === actor.username && (!active || role !== "admin")) throw httpError(400, "현재 관리자 계정은 비활성화하거나 권한을 낮출 수 없습니다.");
    if (current.role === "admin" && current.active && (!active || role !== "admin")) {
      const adminCount = db.prepare("SELECT COUNT(*) AS value FROM users WHERE role='admin' AND active=1").get().value;
      if (adminCount <= 1) throw httpError(400, "활성 관리자 계정은 최소 1개가 필요합니다.");
    }
    const now = new Date().toISOString();
    const password = String(body.password || "");
    if (password) {
      validatePassword(password);
      const { salt, hash } = hashPassword(password);
      db.prepare("UPDATE users SET display_name=?,email=?,department=?,role=?,active=?,password_hash=?,password_salt=?,must_change_password=1,updated_at=? WHERE username=?")
        .run(displayName, normalizeEmail(body.email), textValue(body.department, 80) || null, role, active, hash, salt, now, username);
    } else {
      db.prepare("UPDATE users SET display_name=?,email=?,department=?,role=?,active=?,updated_at=? WHERE username=?")
        .run(displayName, normalizeEmail(body.email), textValue(body.department, 80) || null, role, active, now, username);
    }
    if (!active) db.prepare("DELETE FROM sessions WHERE username=?").run(username);
    logActivity("user_updated", `${displayName} 사용자 권한·상태 수정`, actor, { username, role, active: Boolean(active) });
    return sendJson(res, 200, { ok: true });
  }
  if (userMatch && req.method === "DELETE") {
    requireAdmin(actor);
    const username = decodeURIComponent(userMatch[1]).toLowerCase();
    const current = db.prepare("SELECT * FROM users WHERE username=?").get(username);
    if (!current) throw httpError(404, "사용자를 찾을 수 없습니다.");
    if (username === actor.username) throw httpError(400, "현재 로그인한 관리자 계정은 삭제할 수 없습니다.");
    if (current.role === "admin" && current.active) {
      const adminCount = db.prepare("SELECT COUNT(*) AS value FROM users WHERE role='admin' AND active=1").get().value;
      if (adminCount <= 1) throw httpError(400, "활성 관리자 계정은 최소 1개가 필요합니다.");
    }
    db.transaction(() => {
      logActivity("user_deleted", `${current.display_name} 사용자 삭제`, actor, { username, role: current.role });
      db.prepare("DELETE FROM users WHERE username=?").run(username);
    })();
    return sendJson(res, 200, { ok: true });
  }

  throw httpError(404, "요청한 기능을 찾을 수 없습니다.");
}

function securityHeaders(res) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}

function sendJson(res, status, payload) {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function sendHealth(res) {
  let database = "ok";
  try {
    db.prepare("SELECT 1 AS ok").get();
  } catch (error) {
    database = "error";
    console.error("healthcheck_database_error", error);
  }
  const healthy = database === "ok";
  return sendJson(res, healthy ? 200 : 503, {
    status: healthy ? "ok" : "degraded",
    service: "medpark-hr-maps",
    database,
    timestamp: new Date().toISOString()
  });
}

function sendFile(res, filePath) {
  const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
  securityHeaders(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypes[extname(filePath)] || "application/octet-stream");
  res.setHeader("Cache-Control", extname(filePath) === ".html" ? "no-store" : "public, max-age=300");
  res.end(readFileSync(filePath));
}

function setSessionCookie(res, session) {
  const maxAge = Math.max(0, Math.floor((session.expires.getTime() - Date.now()) / 1000));
  res.setHeader("Set-Cookie", `hr_session=${encodeURIComponent(session.token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "hr_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!origin || !host) throw httpError(403, "요청 출처를 확인할 수 없습니다.");
  let originHost = "";
  try { originHost = new URL(origin).host; } catch { throw httpError(403, "잘못된 요청 출처입니다."); }
  if (originHost !== host) throw httpError(403, "허용되지 않은 요청 출처입니다.");
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 1024 * 1024) throw httpError(413, "요청 데이터가 너무 큽니다.");
  }
  try { return body ? JSON.parse(body) : {}; } catch { throw httpError(400, "JSON 형식이 올바르지 않습니다."); }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function enforceLoginRate(ip) {
  const state = loginAttempts.get(ip);
  if (!state) return;
  if (state.resetAt <= Date.now()) return loginAttempts.delete(ip);
  if (state.count >= 5) throw httpError(429, "로그인 시도가 너무 많습니다. 10분 후 다시 시도하세요.");
}

function recordLoginFailure(ip) {
  const state = loginAttempts.get(ip);
  if (!state || state.resetAt <= Date.now()) loginAttempts.set(ip, { count: 1, resetAt: Date.now() + 10 * 60 * 1000 });
  else state.count += 1;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/health") return sendHealth(res);
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true, service: "medpark-hr-maps", version: "operations-v10-contextual-meeting-summary" });
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") throw httpError(405, "허용되지 않은 요청 방식입니다.");
    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const resolvedAsset = ASSET_ALIASES.get(requested) || requested;
    const safe = normalize(resolvedAsset).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = join(PUBLIC_DIR, safe);
    if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) return sendFile(res, join(PUBLIC_DIR, "index.html"));
    return sendFile(res, filePath);
  } catch (error) {
    console.error("request_error", error);
    return sendJson(res, Number(error.status || 500), { error: error.status ? error.message : "서버 오류가 발생했습니다." });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`인재확보 및 인사기획 operations v5 listening on ${PORT}`);
  console.log(`Data directory: ${dataDir}`);
  if (setupToken) console.log(`ONE_TIME_SETUP_PATH=/?setup=${setupToken}`);
});

const initialSaraminSync = setTimeout(() => {
  void maybeSyncSaraminPostings().catch((error) => console.error("saramin_initial_sync_error", error.message));
}, 5000);
initialSaraminSync.unref();
const saraminSyncTimer = setInterval(() => {
  void maybeSyncSaraminPostings().catch((error) => console.error("saramin_interval_sync_error", error.message));
}, SARAMIN_SYNC_INTERVAL_MS);
saraminSyncTimer.unref();
