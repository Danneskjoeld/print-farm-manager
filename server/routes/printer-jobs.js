const express = require('express');

const PAGE_SIZE = 100;

module.exports = (db) => {
  const router = express.Router({ mergeParams: true });
  const logEvent = (printerId, eventType, note) => db.prepare(
    'INSERT INTO printer_events (printer_id,event_type,note,created_at) VALUES (?,?,?,?)'
  ).run(printerId, eventType, note || null, Date.now());
  const manualPrinter = (id) => db.prepare(
    "SELECT * FROM printers WHERE id=? AND is_active=1 AND type='manual'"
  ).get(id);

  const activeManualJob = (printerId) => db.prepare(`
    SELECT j.*, p.name part_name, pr.name project_name
    FROM jobs j JOIN parts p ON p.id=j.part_id JOIN projects pr ON pr.id=p.project_id
    WHERE j.printer_id=? AND j.status='printing' ORDER BY j.started_at DESC LIMIT 1
  `).get(printerId);

  const setManualCosts = (job, printer, finishedAt, materialCost) => {
    const hours = Math.max(0, (finishedAt - job.started_at) / 3600000);
    let electricity = 0;
    try {
      electricity = Number(db.prepare("SELECT value FROM settings WHERE key='electricity_price_kwh'").get()?.value || 0);
    } catch (_) {}
    const machineCost = hours * Number(printer.hourly_cost || 0);
    const energyCost = hours * Number(printer.power_watts || 0) / 1000 * electricity;
    db.prepare('UPDATE jobs SET material_cost=?, machine_cost=?, energy_cost=? WHERE id=?')
      .run(materialCost, machineCost, energyCost, job.id);
  };

  // Manual printers never receive scheduler jobs. Operators select an open part here.
  router.get('/manual-options', (req, res) => {
    if (!manualPrinter(req.params.id)) return res.status(404).json({ error: 'Manual printer not found' });
    const parts = db.prepare(`
      SELECT p.id, p.name, p.target_qty, p.completed_qty, pr.id project_id, pr.name project_name
      FROM parts p JOIN projects pr ON pr.id=p.project_id
      WHERE p.status='open' AND pr.status='active' AND p.completed_qty < p.target_qty
      ORDER BY pr.priority DESC, pr.created_at, p.sort_order, p.id
    `).all();
    res.json({ parts, active_job: activeManualJob(req.params.id) || null });
  });

  router.post('/manual-start', (req, res) => {
    const printer = manualPrinter(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Manual printer not found' });
    if (activeManualJob(printer.id)) return res.status(409).json({ error: 'This printer already has an active manual job' });
    const partId = Number(req.body?.part_id);
    const qty = Number(req.body?.parts_per_plate);
    const durationMinutes = Number(req.body?.estimated_duration_minutes);
    const part = db.prepare(`SELECT p.*, pr.status project_status FROM parts p JOIN projects pr ON pr.id=p.project_id WHERE p.id=?`).get(partId);
    if (!part || part.status !== 'open' || part.project_status !== 'active') {
      return res.status(400).json({ error: 'Select an open part from an active project' });
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > part.target_qty - part.completed_qty) {
      return res.status(400).json({ error: 'Quantity must be between 1 and the remaining target quantity' });
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      return res.status(400).json({ error: 'Estimated duration must be greater than zero' });
    }
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO jobs (part_id,printer_id,gcode_id,parts_per_plate,status,started_at,created_at,material_cost)
      VALUES (?,?,NULL,?,'printing',?,?,?)
    `).run(part.id, printer.id, qty, now, now, Math.max(0, Number(req.body?.material_cost) || 0));
    db.prepare("UPDATE printers SET status='PRINTING', job_name=?, job_progress=0, job_time_remaining=? WHERE id=?")
      .run(`${part.name} (manual)`, Math.round(durationMinutes * 60), printer.id);
    logEvent(printer.id, 'job_started', `Manual job ${result.lastInsertRowid} — ${part.name} (${qty} parts, planned ${durationMinutes} min)`);
    res.status(201).json(activeManualJob(printer.id));
  });

  router.post('/manual-complete', (req, res) => {
    const printer = manualPrinter(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Manual printer not found' });
    const job = activeManualJob(printer.id);
    if (!job) return res.status(409).json({ error: 'No active manual job' });
    const qty = req.body?.confirmed_qty == null ? job.parts_per_plate : Number(req.body.confirmed_qty);
    if (!Number.isInteger(qty) || qty < 0 || qty > job.parts_per_plate) {
      return res.status(400).json({ error: 'Confirmed quantity is invalid' });
    }
    const actualMinutes = req.body?.actual_duration_minutes == null ? null : Number(req.body.actual_duration_minutes);
    if (actualMinutes != null && (!Number.isFinite(actualMinutes) || actualMinutes <= 0)) {
      return res.status(400).json({ error: 'Actual duration must be greater than zero' });
    }
    const finishedAt = actualMinutes == null ? Date.now() : job.started_at + Math.round(actualMinutes * 60000);
    const materialCost = req.body?.material_cost == null ? Number(job.material_cost || 0) : Math.max(0, Number(req.body.material_cost) || 0);
    const tx = db.transaction(() => {
      db.prepare("UPDATE jobs SET status='finished', finished_at=? WHERE id=?").run(finishedAt, job.id);
      setManualCosts(job, printer, finishedAt, materialCost);
      db.prepare('UPDATE parts SET completed_qty=completed_qty+?, updated_at=? WHERE id=?').run(qty, Date.now(), job.part_id);
      const part = db.prepare('SELECT * FROM parts WHERE id=?').get(job.part_id);
      if (part.completed_qty >= part.target_qty) {
        db.prepare("UPDATE parts SET status='closed', updated_at=? WHERE id=?").run(Date.now(), part.id);
        db.prepare("UPDATE jobs SET status='cancelled' WHERE part_id=? AND status='queued'").run(part.id);
        const open = db.prepare("SELECT COUNT(*) count FROM parts WHERE project_id=? AND status='open'").get(part.project_id).count;
        if (open === 0) db.prepare("UPDATE projects SET status='completed', updated_at=? WHERE id=?").run(Date.now(), part.project_id);
      }
      db.prepare("UPDATE printers SET status='IDLE', job_name=NULL, job_progress=NULL, job_time_remaining=NULL WHERE id=?").run(printer.id);
    });
    tx();
    logEvent(printer.id, 'job_finished', `Manual job ${job.id} — ${job.part_name} (${qty} good parts)`);
    res.json(db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id));
  });

  router.post('/manual-fail', (req, res) => {
    const printer = manualPrinter(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Manual printer not found' });
    const job = activeManualJob(printer.id);
    if (!job) return res.status(409).json({ error: 'No active manual job' });
    const actualMinutes = req.body?.actual_duration_minutes == null ? null : Number(req.body.actual_duration_minutes);
    if (actualMinutes != null && (!Number.isFinite(actualMinutes) || actualMinutes <= 0)) {
      return res.status(400).json({ error: 'Actual duration must be greater than zero' });
    }
    const finishedAt = actualMinutes == null ? Date.now() : job.started_at + Math.round(actualMinutes * 60000);
    const materialCost = req.body?.material_cost == null ? Number(job.material_cost || 0) : Math.max(0, Number(req.body.material_cost) || 0);
    db.transaction(() => {
      db.prepare("UPDATE jobs SET status='failed', finished_at=? WHERE id=?").run(finishedAt, job.id);
      setManualCosts(job, printer, finishedAt, materialCost);
      db.prepare("UPDATE printers SET status='IDLE', job_name=NULL, job_progress=NULL, job_time_remaining=NULL WHERE id=?").run(printer.id);
    })();
    logEvent(printer.id, 'job_failed', `Manual job ${job.id} — ${job.part_name}${req.body?.note ? ` — ${req.body.note}` : ''}`);
    res.json(db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id));
  });

  // GET /api/printers/:id/jobs/stats
  // Lifetime aggregate for this printer — total jobs, parts produced, success rate, print hours.
  // Only 'finished' jobs contribute to parts and hours; 'failed' jobs count toward totals.
  router.get('/stats', (req, res) => {
    const printer = db.prepare('SELECT id FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const row = db.prepare(`
      SELECT
        COUNT(*)                                                        AS total_jobs,
        COUNT(CASE WHEN status = 'finished' THEN 1 END)                AS finished_jobs,
        COUNT(CASE WHEN status = 'failed'   THEN 1 END)                AS failed_jobs,
        COALESCE(SUM(CASE WHEN status = 'finished' THEN parts_per_plate ELSE 0 END), 0)
                                                                        AS total_parts,
        COALESCE(SUM(CASE WHEN status = 'finished' AND started_at IS NOT NULL AND finished_at IS NOT NULL
                          THEN finished_at - started_at ELSE 0 END), 0) AS total_print_ms
      FROM jobs
      WHERE printer_id = ? AND status IN ('finished', 'failed')
    `).get(req.params.id);

    const totalTracked = row.finished_jobs + row.failed_jobs;
    res.json({
      total_jobs:      row.total_jobs,
      finished_jobs:   row.finished_jobs,
      failed_jobs:     row.failed_jobs,
      total_parts:     row.total_parts,
      success_rate:    totalTracked > 0 ? Math.round((row.finished_jobs / totalTracked) * 100) : null,
      total_print_ms:  row.total_print_ms,
    });
  });

  // GET /api/printers/:id/jobs?page=1
  // Paginated job history, 100 per page, newest first.
  // Joins to parts, projects, gcodes for display context.
  router.get('/', (req, res) => {
    const printer = db.prepare('SELECT id FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const totalRow = db.prepare(`
      SELECT COUNT(*) AS count FROM jobs WHERE printer_id = ?
    `).get(req.params.id);
    const total      = totalRow.count;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const jobs = db.prepare(`
      SELECT
        j.id, j.status, j.parts_per_plate, j.started_at, j.finished_at,
        j.finished_at - j.started_at   AS duration_ms,
        p.name                          AS part_name,
        pr.name                         AS project_name,
        g.filename                      AS gcode_filename
      FROM jobs j
      LEFT JOIN parts    p  ON p.id  = j.part_id
      LEFT JOIN projects pr ON pr.id = p.project_id
      LEFT JOIN gcodes   g  ON g.id  = j.gcode_id
      WHERE j.printer_id = ?
      ORDER BY j.started_at DESC
      LIMIT ? OFFSET ?
    `).all(req.params.id, PAGE_SIZE, offset);

    res.json({ page, total_pages: totalPages, total, jobs });
  });

  return router;
};
