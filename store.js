'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'requests.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
}

function readFile() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function writeFile(list) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// --- PostgreSQL реализация ---
let pg = null;
let pool = null;
let dbReady = false;

async function initPg() {
  try {
    pg = require('pg');
  } catch (e) {
    return false;
  }
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT NOT NULL,
        work_type TEXT DEFAULT '',
        subject TEXT NOT NULL,
        course TEXT DEFAULT '',
        volume TEXT DEFAULT '',
        topic TEXT NOT NULL,
        deadline TEXT DEFAULT '',
        file_name TEXT DEFAULT '',
        file_original TEXT DEFAULT '',
        status TEXT DEFAULT 'new'
      )
    `);
    dbReady = true;
    return true;
  } catch (e) {
    console.error('PG init failed, falling back to file:', e.message);
    pool = null;
    return false;
  }
}

function toPgRow(r) {
  return [
    r.id, r.createdAt, r.name, r.phone, r.email,
    r.workType || '', r.subject, r.course || '', r.volume || '', r.topic,
    r.deadline || '', r.fileName || '', r.fileOriginal || '', r.status || 'new',
  ];
}

function fromPgRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    name: row.name,
    phone: row.phone,
    email: row.email,
    workType: row.work_type || '',
    subject: row.subject,
    course: row.course || '',
    volume: row.volume || '',
    topic: row.topic,
    deadline: row.deadline || '',
    fileName: row.file_name || '',
    fileOriginal: row.file_original || '',
    status: row.status || 'new',
  };
}

async function pgAll() {
  const { rows } = await pool.query('SELECT * FROM requests ORDER BY created_at ASC');
  return rows.map(fromPgRow);
}
async function pgAdd(r) {
  await pool.query(
    `INSERT INTO requests (id, created_at, name, phone, email, work_type, subject, course, volume, topic, deadline, file_name, file_original, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    toPgRow(r)
  );
}
async function pgSetStatuses(updates) {
  for (const u of updates) {
    await pool.query('UPDATE requests SET status=$2 WHERE id=$1', [u.id, u.status]);
  }
}
async function pgRemove(ids) {
  if (!ids.length) return 0;
  const res = await pool.query('DELETE FROM requests WHERE id = ANY($1::text[])', [ids]);
  return res.rowCount;
}

function usePg() {
  return dbReady && pool;
}

// --- Публичное API (значения совпадают с прежними полями) ---
const store = {
  async init() {
    if (process.env.DATABASE_URL) {
      const ok = await initPg();
      if (ok) console.log('Хранилище: PostgreSQL');
      else console.log('Хранилище: файл (PG недоступен)');
      return;
    }
    console.log('Хранилище: файл');
  },
  async getAll() {
    return usePg() ? pgAll() : readFile();
  },
  async add(record) {
    if (usePg()) {
      await pgAdd(record);
    } else {
      const list = readFile();
      list.push(record);
      writeFile(list);
    }
  },
  async setStatuses(updates) {
    if (usePg()) {
      await pgSetStatuses(updates);
    } else {
      const all = readFile();
      const valid = ['new', 'inprogress', 'done', 'rejected'];
      for (const u of updates) {
        const rec = all.find((r) => r.id === u.id);
        if (rec && valid.includes(u.status)) rec.status = u.status;
      }
      writeFile(all);
    }
  },
  async remove(ids) {
    if (usePg()) return pgRemove(ids);
    const all = readFile();
    const next = all.filter((r) => !ids.includes(r.id));
    writeFile(next);
    return all.length - next.length;
  },
};

module.exports = store;