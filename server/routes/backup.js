const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const router   = express.Router();
const GCODE_DIR = path.join(__dirname, '..', 'gcode');

// Multer for restore uploads — write to data/ dir, clean up after processing
const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'data'),
    filename: (_req, _file, cb) => cb(null, `restore-upload-${Date.now()}.json`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    restoreUpload.single('file')(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = (db) => {
  // GET /api/backup — export full farm as a downloadable JSON bundle
  router.get('/', (req, res) => {
    const printers        = db.prepare('SELECT * FROM printers').all();
    const projects        = db.prepare('SELECT * FROM projects').all();
    const parts           = db.prepare('SELECT * FROM parts').all();
    const gcodes          = db.prepare('SELECT * FROM gcodes').all();
    const jobs            = db.prepare('SELECT * FROM jobs').all();
    const printer_events  = db.prepare('SELECT * FROM printer_events').all();
    const filament_rolls = db.prepare('SELECT * FROM filament_rolls').all();
    const filament_types = db.prepare('SELECT * FROM filament_types').all();
    const filament_colors = db.prepare('SELECT * FROM filament_colors').all();
    const printer_filament_slots = db.prepare('SELECT * FROM printer_filament_slots').all();
    const filament_transactions = db.prepare('SELECT * FROM filament_transactions').all();
    const maintenance_plans = db.prepare('SELECT * FROM maintenance_plans').all();
    const maintenance_records = db.prepare('SELECT * FROM maintenance_records').all();
    const project_costs = db.prepare('SELECT * FROM project_costs').all();
    const settings = db.prepare('SELECT * FROM settings').all();

    // Embed gcode files as base64, keyed by their on-disk basename
    const gcodeFiles = {};
    for (const g of gcodes) {
      const fullPath = path.join(GCODE_DIR, g.filepath);
      if (g.filepath && fs.existsSync(fullPath)) {
        gcodeFiles[g.filepath] = fs.readFileSync(fullPath).toString('base64');
      }
    }

    const backup = {
      version: 2,
      exported_at: Date.now(),
      printers,
      projects,
      parts,
      gcodes,
      jobs,
      printer_events,
      filament_types, filament_colors, filament_rolls,
      printer_filament_slots, filament_transactions,
      maintenance_plans, maintenance_records, project_costs, settings,
      gcode_files: gcodeFiles,
    };

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="farm-backup-${date}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);
  });

  // POST /api/backup/restore — replace all farm data from a backup JSON file
  router.post('/restore', async (req, res) => {
    let tmpPath = null;
    try {
      await runUpload(req, res);
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      tmpPath = req.file.path;
      let backup;
      try {
        backup = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
      } catch {
        return res.status(400).json({ error: 'Invalid JSON in backup file' });
      }

      if (!backup.version || !Array.isArray(backup.printers)) {
        return res.status(400).json({ error: 'Unrecognised backup format' });
      }

      // Write gcode files to disk before the DB transaction
      for (const [basename, b64] of Object.entries(backup.gcode_files || {})) {
        fs.writeFileSync(path.join(GCODE_DIR, basename), Buffer.from(b64, 'base64'));
      }

      const restore = db.transaction(() => {
        // Delete in FK dependency order
        db.prepare('DELETE FROM filament_transactions').run();
        db.prepare('DELETE FROM printer_filament_slots').run();
        db.prepare('DELETE FROM maintenance_records').run();
        db.prepare('DELETE FROM project_costs').run();
        db.prepare('DELETE FROM maintenance_plans').run();
        db.prepare('DELETE FROM filament_rolls').run();
        // Version 1 backups did not contain the Filament Library. Preserve the
        // destination library for those older bundles rather than clearing it.
        if (Array.isArray(backup.filament_types) && Array.isArray(backup.filament_colors)) {
          db.prepare('DELETE FROM filament_colors').run();
          db.prepare('DELETE FROM filament_types').run();
        }
        db.prepare('DELETE FROM printer_events').run();
        db.prepare('DELETE FROM jobs').run();
        db.prepare('DELETE FROM gcodes').run();
        db.prepare('DELETE FROM parts').run();
        db.prepare('DELETE FROM projects').run();
        db.prepare('DELETE FROM printers').run();

        // Reinsert with original IDs so FK relationships are preserved
        const stmts = {
          printer: db.prepare(`
            INSERT INTO printers
              (id, name, ip, api_key, group_name, type, model, status,
               is_held, is_active, created_at,
               decommissioned_at, decommission_note,
               job_name, job_progress, job_time_remaining, serial_number,
               loaded_material, loaded_color, hourly_cost, power_watts)
            VALUES
              (@id, @name, @ip, @api_key, @group_name, @type, @model, @status,
               @is_held, @is_active, @created_at,
               @decommissioned_at, @decommission_note,
               @job_name, @job_progress, @job_time_remaining, @serial_number,
               @loaded_material, @loaded_color, @hourly_cost, @power_watts)
          `),
          project: db.prepare(`
            INSERT INTO projects (id, name, description, status, priority, sale_price, created_at, updated_at, required_material, required_color)
            VALUES (@id, @name, @description, @status, @priority, @sale_price, @created_at, @updated_at, @required_material, @required_color)
          `),
          part: db.prepare(`
            INSERT INTO parts
              (id, project_id, name, target_qty, completed_qty, status, created_at, updated_at, sort_order)
            VALUES
              (@id, @project_id, @name, @target_qty, @completed_qty, @status, @created_at, @updated_at, @sort_order)
          `),
          gcode: db.prepare(`
            INSERT INTO gcodes
              (id, part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, created_at, ams_slot, material_grams, allowed_groups, required_material, required_color)
            VALUES
              (@id, @part_id, @printer_model, @filename, @filepath, @parts_per_plate, @est_print_secs, @created_at, @ams_slot, @material_grams, @allowed_groups, @required_material, @required_color)
          `),
          job: db.prepare(`
            INSERT INTO jobs
              (id, part_id, printer_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at, material_cost, machine_cost, energy_cost, maintenance_cost)
            VALUES
              (@id, @part_id, @printer_id, @gcode_id, @parts_per_plate, @status, @started_at, @finished_at, @created_at, @material_cost, @machine_cost, @energy_cost, @maintenance_cost)
          `),
          printer_event: db.prepare(`
            INSERT INTO printer_events (id, printer_id, event_type, note, created_at)
            VALUES (@id, @printer_id, @event_type, @note, @created_at)
          `),
        };

        for (const p of (backup.printers || [])) stmts.printer.run({serial_number:'',loaded_material:null,loaded_color:null,hourly_cost:0,power_watts:0,...p});
        for (const p of (backup.projects || [])) stmts.project.run({sale_price:0,required_material:null,required_color:null,...p});
        for (const p of (backup.parts    || [])) stmts.part.run(p);
        for (const g of (backup.gcodes   || [])) {
          // filepath stores just the filename — no path rewriting needed
          stmts.gcode.run({ams_slot:null,material_grams:null,allowed_groups:null,required_material:null,required_color:null,...g, filepath: path.basename(g.filepath) });
        }
        for (const j of (backup.jobs || [])) stmts.job.run({material_cost:0,machine_cost:0,energy_cost:0,maintenance_cost:0,...j});
        for (const e of (backup.printer_events || [])) stmts.printer_event.run(e);

        // Version 2 additions use column-aware inserts so future nullable columns
        // remain backward compatible with older backup bundles.
        const insertRows = (table, rows) => {
          const allowed = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
          for (const row of rows || []) {
            const cols = Object.keys(row).filter(k => allowed.has(k));
            if (!cols.length) continue;
            db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(c=>'@'+c).join(',')})`).run(row);
          }
        };
        insertRows('filament_types', backup.filament_types);
        insertRows('filament_colors', backup.filament_colors);
        insertRows('filament_rolls', backup.filament_rolls);
        insertRows('printer_filament_slots', backup.printer_filament_slots);
        insertRows('filament_transactions', backup.filament_transactions);
        insertRows('maintenance_plans', backup.maintenance_plans);
        insertRows('maintenance_records', backup.maintenance_records);
        insertRows('project_costs', backup.project_costs);
        if (Array.isArray(backup.settings)) {
          for (const s of backup.settings) db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(s.key,s.value);
        }

        // Sync auto-increment counters so new inserts don't collide
        for (const [table, col] of [
          ['printers', 'printers'], ['projects', 'projects'],
          ['parts', 'parts'], ['gcodes', 'gcodes'], ['jobs', 'jobs'],
          ['printer_events', 'printer_events'],
          ['filament_rolls', 'filament_rolls'], ['filament_transactions', 'filament_transactions'],
          ['filament_types', 'filament_types'], ['filament_colors', 'filament_colors'],
          ['maintenance_plans', 'maintenance_plans'], ['maintenance_records', 'maintenance_records'],
          ['project_costs', 'project_costs'],
        ]) {
          db.prepare(`
            INSERT OR REPLACE INTO sqlite_sequence (name, seq)
            VALUES (?, (SELECT COALESCE(MAX(id), 0) FROM ${table}))
          `).run(col);
        }
      });

      restore();

      console.log(`[backup] Farm restored — ${backup.printers.length} printers, ${backup.projects.length} projects, ${backup.gcodes.length} gcodes, ${backup.jobs.length} jobs, ${(backup.printer_events || []).length} events`);

      res.json({
        ok: true,
        printers:       (backup.printers       || []).length,
        projects:       (backup.projects       || []).length,
        parts:          (backup.parts          || []).length,
        gcodes:         (backup.gcodes         || []).length,
        jobs:           (backup.jobs           || []).length,
        printer_events: (backup.printer_events || []).length,
      });
    } catch (err) {
      console.error('[backup] restore error:', err);
      res.status(500).json({ error: err.message });
    } finally {
      if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  return router;
};
