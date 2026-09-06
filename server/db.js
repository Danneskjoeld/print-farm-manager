const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const gcodeDir = path.join(__dirname, 'gcode');
if (!fs.existsSync(gcodeDir)) {
  fs.mkdirSync(gcodeDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'farm.db'));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS printers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    ip          TEXT NOT NULL,
    api_key     TEXT NOT NULL,
    group_name  TEXT,
    type        TEXT DEFAULT 'prusa',
    model       TEXT NOT NULL,
    status      TEXT DEFAULT 'UNKNOWN',
    is_held     INTEGER DEFAULT 1,
    is_active   INTEGER DEFAULT 1,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    status      TEXT DEFAULT 'draft',
    priority    INTEGER DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS parts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id     INTEGER NOT NULL REFERENCES projects(id),
    name           TEXT NOT NULL,
    target_qty     INTEGER NOT NULL,
    completed_qty  INTEGER DEFAULT 0,
    status         TEXT DEFAULT 'open',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gcodes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id          INTEGER NOT NULL REFERENCES parts(id),
    printer_model    TEXT NOT NULL,
    filename         TEXT NOT NULL,
    filepath         TEXT NOT NULL,
    parts_per_plate  INTEGER NOT NULL,
    est_print_secs   INTEGER,
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id          INTEGER NOT NULL REFERENCES parts(id),
    printer_id       INTEGER NOT NULL REFERENCES printers(id),
    gcode_id         INTEGER NOT NULL REFERENCES gcodes(id),
    parts_per_plate  INTEGER NOT NULL,
    status           TEXT DEFAULT 'queued',
    started_at       INTEGER,
    finished_at      INTEGER,
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS printer_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id  INTEGER NOT NULL,
    event_type  TEXT NOT NULL,
    note        TEXT,
    created_at  INTEGER NOT NULL
  );
`);

// Migrations for existing installs
try { db.exec('ALTER TABLE printers ADD COLUMN is_active INTEGER DEFAULT 1'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN decommissioned_at INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN decommission_note TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE parts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN job_name TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN job_progress REAL'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN job_time_remaining INTEGER'); } catch (_) {}
try { db.exec("ALTER TABLE printers ADD COLUMN serial_number TEXT DEFAULT ''"); } catch (_) {}
try { db.exec('ALTER TABLE gcodes ADD COLUMN ams_slot INTEGER'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_printer_started ON jobs(printer_id, started_at DESC)'); } catch (_) {}
try { db.exec('ALTER TABLE parts ADD COLUMN print_time_seconds INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE parts ADD COLUMN material_grams REAL'); } catch (_) {}
try { db.exec('ALTER TABLE gcodes ADD COLUMN material_grams REAL'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN loaded_material TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN loaded_color TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE gcodes ADD COLUMN allowed_groups TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE gcodes ADD COLUMN required_material TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE gcodes ADD COLUMN required_color TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE projects ADD COLUMN required_material TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE projects ADD COLUMN required_color TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE projects ADD COLUMN sale_price REAL NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE projects ADD COLUMN customer_name TEXT'); } catch (_) {}
try { db.exec("ALTER TABLE projects ADD COLUMN technology TEXT CHECK (technology IN ('FDM','SLA'))"); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN hourly_cost REAL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE printers ADD COLUMN power_watts REAL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE jobs ADD COLUMN material_cost REAL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE jobs ADD COLUMN machine_cost REAL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE jobs ADD COLUMN energy_cost REAL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE jobs ADD COLUMN maintenance_cost REAL DEFAULT 0'); } catch (_) {}

// Inventory, maintenance and cost accounting. Transactions are append-only so
// automatic consumption and later operator corrections remain auditable.
db.exec(`
  CREATE TABLE IF NOT EXISTS filament_rolls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    material TEXT NOT NULL,
    color TEXT,
    manufacturer TEXT,
    lot_number TEXT,
    location TEXT,
    initial_weight_g REAL NOT NULL,
    remaining_weight_g REAL NOT NULL,
    spool_weight_g REAL DEFAULT 0,
    purchase_price REAL DEFAULT 0,
    min_weight_g REAL DEFAULT 100,
    status TEXT DEFAULT 'available',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS printer_filament_slots (
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL DEFAULT 0,
    roll_id INTEGER REFERENCES filament_rolls(id) ON DELETE SET NULL,
    PRIMARY KEY (printer_id, slot),
    UNIQUE (roll_id)
  );
  CREATE TABLE IF NOT EXISTS filament_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roll_id INTEGER NOT NULL REFERENCES filament_rolls(id) ON DELETE CASCADE,
    job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    amount_g REAL NOT NULL,
    balance_after_g REAL NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_filament_job_consumption
    ON filament_transactions(job_id) WHERE job_id IS NOT NULL AND type = 'consumption';

  CREATE TABLE IF NOT EXISTS maintenance_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    interval_days INTEGER,
    interval_print_hours REAL,
    last_completed_at INTEGER,
    last_completed_print_hours REAL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS maintenance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    plan_id INTEGER REFERENCES maintenance_plans(id) ON DELETE SET NULL,
    performed_at INTEGER NOT NULL,
    print_hours REAL DEFAULT 0,
    cost REAL DEFAULT 0,
    notes TEXT,
    performed_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_maintenance_printer ON maintenance_records(printer_id, performed_at DESC);

  CREATE TABLE IF NOT EXISTS project_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    category TEXT NOT NULL DEFAULT 'other',
    amount REAL NOT NULL,
    note TEXT,
    incurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_project_costs_project
    ON project_costs(project_id, incurred_at DESC);

  CREATE TABLE IF NOT EXISTS maintenance_model_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    interval_days INTEGER,
    interval_print_hours REAL,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_maintenance_model_plans_model
    ON maintenance_model_plans(model_id, is_active);
  CREATE TABLE IF NOT EXISTS maintenance_model_states (
    model_plan_id INTEGER NOT NULL REFERENCES maintenance_model_plans(id) ON DELETE CASCADE,
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    last_completed_at INTEGER,
    last_completed_print_hours REAL DEFAULT 0,
    PRIMARY KEY (model_plan_id, printer_id)
  );
`);

try { db.exec('ALTER TABLE maintenance_records ADD COLUMN model_plan_id INTEGER REFERENCES maintenance_model_plans(id) ON DELETE SET NULL'); } catch (_) {}

// Printer models — source of truth for which models this farm supports.
// New installs start empty; operator adds models in Settings.
// Existing installs auto-seed from models already referenced in the live DB.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS printer_models (
    model_id   TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    connector  TEXT NOT NULL
  )`);
} catch (_) {}

try {
  const KNOWN_MODEL_META = {
    'mk4':             { label: 'MK4',            connector: 'prusa' },
    'mk4s':            { label: 'MK4S',           connector: 'prusa' },
    'c1':              { label: 'Core One',        connector: 'prusa' },
    'c1l':             { label: 'Core 1L',         connector: 'prusa' },
    'xl':              { label: 'XL',              connector: 'prusa' },
    'centauri-carbon': { label: 'Centauri Carbon', connector: 'elegoo-centauri' },
    'x1c':             { label: 'X1 Carbon',       connector: 'bambu' },
    'p1s':             { label: 'P1S',             connector: 'bambu' },
    'p1p':             { label: 'P1P',             connector: 'bambu' },
    'a1':              { label: 'A1',              connector: 'bambu' },
    'a1-mini':         { label: 'A1 Mini',         connector: 'bambu' },
    'form-3':          { label: 'Formlabs Form 3', connector: 'manual' },
    'form-3l':         { label: 'Formlabs Form 3L', connector: 'manual' },
    'form-4':          { label: 'Formlabs Form 4', connector: 'manual' },
    'form-4l':         { label: 'Formlabs Form 4L', connector: 'manual' },
  };
  // Collect every distinct model already in use across printers + gcodes
  const inUse = db.prepare(`
    SELECT DISTINCT model AS m FROM printers WHERE model IS NOT NULL AND model != ''
    UNION
    SELECT DISTINCT printer_model AS m FROM gcodes WHERE printer_model IS NOT NULL AND printer_model != ''
  `).all().map(r => r.m);

  const insertModel = db.prepare(
    'INSERT OR IGNORE INTO printer_models (model_id, label, connector) VALUES (?, ?, ?)'
  );
  for (const modelId of inUse) {
    const meta = KNOWN_MODEL_META[modelId];
    insertModel.run(modelId, meta?.label || modelId, meta?.connector || 'prusa');
  }
  // Manual Formlabs models are available out of the box because they need no
  // network discovery and are the primary use case for the manual connector.
  for (const modelId of ['form-3', 'form-3l', 'form-4', 'form-4l']) {
    const meta = KNOWN_MODEL_META[modelId];
    insertModel.run(modelId, meta.label, meta.connector);
  }
} catch (_) {}

// Filament library — canonical lists managed in Settings
try {
  db.exec(`CREATE TABLE IF NOT EXISTS filament_types (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE
  )`);
} catch (_) {}

try {
  db.exec(`CREATE TABLE IF NOT EXISTS filament_colors (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type_id   INTEGER NOT NULL REFERENCES filament_types(id),
    name      TEXT NOT NULL,
    hex_color TEXT,
    UNIQUE(type_id, name)
  )`);
} catch (_) {}

// Add type_id to filament_colors if missing (existing installs that predate this column)
try {
  const hasTypeId = db.prepare("PRAGMA table_info(filament_colors)").all().some(c => c.name === 'type_id');
  if (!hasTypeId) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE filament_colors_new (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        type_id   INTEGER NOT NULL REFERENCES filament_types(id),
        name      TEXT NOT NULL,
        hex_color TEXT,
        UNIQUE(type_id, name)
      );
      DROP TABLE filament_colors;
      ALTER TABLE filament_colors_new RENAME TO filament_colors;
      PRAGMA foreign_keys = ON;
    `);
    console.log('[db] Migrated filament_colors — added type_id (existing colors cleared)');
  }
} catch (_) {}

// Connect physical inventory rolls to the canonical Filament Library. The old
// text columns remain as readable snapshots for backup compatibility, while the
// IDs are now the source of truth for all new and edited rolls.
try { db.exec('ALTER TABLE filament_rolls ADD COLUMN filament_type_id INTEGER REFERENCES filament_types(id)'); } catch (_) {}
try { db.exec('ALTER TABLE filament_rolls ADD COLUMN filament_color_id INTEGER REFERENCES filament_colors(id)'); } catch (_) {}
try { db.exec('ALTER TABLE filament_rolls ADD COLUMN roll_count INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
try {
  db.exec(`
    UPDATE filament_rolls
    SET filament_type_id = (
      SELECT id FROM filament_types WHERE lower(name) = lower(filament_rolls.material) LIMIT 1
    )
    WHERE filament_type_id IS NULL;

    UPDATE filament_rolls
    SET filament_color_id = (
      SELECT fc.id FROM filament_colors fc
      WHERE fc.type_id = filament_rolls.filament_type_id
        AND lower(fc.name) = lower(filament_rolls.color)
      LIMIT 1
    )
    WHERE filament_color_id IS NULL;
  `);
} catch (_) {}
// Names identify inventory stock items. Existing installations with duplicates
// are left untouched and handled by the API until the operator renames them;
// clean databases receive an additional case-insensitive database constraint.
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_filament_rolls_name_nocase ON filament_rolls(name COLLATE NOCASE)'); } catch (_) {}

// Settings table — key/value store for operator-configurable options
try {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
} catch (_) {}
// Seed defaults (INSERT OR IGNORE so existing values are never overwritten)
try {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('dispatch_batch_size', '10')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('electricity_price_kwh', '0.30')").run();
} catch (_) {}

// Make jobs.gcode_id nullable so gcodes can be deleted after jobs have run
const gcodeIdCol = db.prepare("PRAGMA table_info(jobs)").all().find(c => c.name === 'gcode_id');
if (gcodeIdCol && gcodeIdCol.notnull === 1) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    -- A previous interrupted migration may have left this staging table behind.
    -- The authoritative jobs table is still present at this point, so rebuilding
    -- the staging table is safe and makes the migration restartable.
    DROP TABLE IF EXISTS jobs_migrated;
    CREATE TABLE jobs_migrated (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id          INTEGER NOT NULL REFERENCES parts(id),
      printer_id       INTEGER NOT NULL REFERENCES printers(id),
      gcode_id         INTEGER REFERENCES gcodes(id),
      parts_per_plate  INTEGER NOT NULL,
      status           TEXT DEFAULT 'queued',
      started_at       INTEGER,
      finished_at      INTEGER,
      created_at       INTEGER NOT NULL,
      material_cost    REAL DEFAULT 0,
      machine_cost     REAL DEFAULT 0,
      energy_cost      REAL DEFAULT 0,
      maintenance_cost REAL DEFAULT 0
    );
    INSERT INTO jobs_migrated
      (id, part_id, printer_id, gcode_id, parts_per_plate, status,
       started_at, finished_at, created_at, material_cost, machine_cost,
       energy_cost, maintenance_cost)
    SELECT id, part_id, printer_id, gcode_id, parts_per_plate, status,
           started_at, finished_at, created_at,
           COALESCE(material_cost, 0), COALESCE(machine_cost, 0),
           COALESCE(energy_cost, 0), COALESCE(maintenance_cost, 0)
    FROM jobs;
    DROP TABLE jobs;
    ALTER TABLE jobs_migrated RENAME TO jobs;
    CREATE INDEX IF NOT EXISTS idx_jobs_printer_started ON jobs(printer_id, started_at DESC);
    PRAGMA foreign_keys = ON;
  `);
}

// Backfill decommission events for printers that were decommissioned before the
// printer_events table existed. Runs once per printer (checked via event absence).
// Uses decommissioned_at as the event timestamp so the timeline is accurate.
try {
  const decomms = db.prepare(`
    SELECT id, name, decommissioned_at, decommission_note
    FROM printers
    WHERE is_active = 0 AND decommissioned_at IS NOT NULL
  `).all();

  const hasEvent = db.prepare(
    `SELECT 1 FROM printer_events WHERE printer_id = ? AND event_type = 'decommission' LIMIT 1`
  );
  const insertBackfill = db.prepare(
    `INSERT INTO printer_events (printer_id, event_type, note, created_at) VALUES (?, 'decommission', ?, ?)`
  );

  for (const p of decomms) {
    if (!hasEvent.get(p.id)) {
      insertBackfill.run(p.id, p.decommission_note ?? null, p.decommissioned_at);
      console.log(`[db] Backfilled decommission event for ${p.name}`);
    }
  }
} catch (_) {}

module.exports = db;
