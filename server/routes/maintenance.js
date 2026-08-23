const express = require('express');
const { printHours } = require('../production-accounting');

function positiveOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function withDueState(db, row, now) {
  const hours = printHours(db, row.printer_id, now);
  const dayBaseline = row.last_completed_at || row.created_at;
  const dueAt = row.interval_days && dayBaseline
    ? dayBaseline + row.interval_days * 86400000 : null;
  const dueHours = row.interval_print_hours != null
    ? Number(row.last_completed_print_hours || 0) + Number(row.interval_print_hours) : null;
  return { ...row, current_print_hours: hours, due_at: dueAt, due_print_hours: dueHours,
    is_due: Boolean((dueAt && now >= dueAt) || (dueHours != null && hours >= dueHours)) };
}

function logMaintenance(db, printerId, plan, body, cost, now) {
  const details = [plan.name, body?.notes, body?.performed_by && `by ${body.performed_by}`,
    cost ? `cost €${cost.toFixed(2)}` : null].filter(Boolean).join(' · ');
  db.prepare(`INSERT INTO printer_events (printer_id, event_type, note, created_at)
    VALUES (?, 'maintenance', ?, ?)`).run(printerId, details, now);
}

module.exports = (db) => {
  const router = express.Router();

  router.get('/', (_req, res) => {
    const now = Date.now();
    const legacy = db.prepare(`
      SELECT m.*, p.name printer_name, p.model model_id, 'printer' plan_scope
      FROM maintenance_plans m JOIN printers p ON p.id = m.printer_id
      ORDER BY p.name, m.name
    `).all();
    const modelPlans = db.prepare(`
      SELECT mp.*, p.id printer_id, p.name printer_name, pm.label model_label,
             s.last_completed_at, COALESCE(s.last_completed_print_hours, 0) last_completed_print_hours,
             'model' plan_scope
      FROM maintenance_model_plans mp
      JOIN printers p ON p.model = mp.model_id AND p.is_active = 1
      LEFT JOIN printer_models pm ON pm.model_id = mp.model_id
      LEFT JOIN maintenance_model_states s ON s.model_plan_id = mp.id AND s.printer_id = p.id
      ORDER BY COALESCE(pm.label, mp.model_id), mp.name, p.name
    `).all();
    res.json([...modelPlans, ...legacy].map(row => withDueState(db, row, now)));
  });

  router.post('/', (req, res) => {
    const body = req.body || {};
    if (!body.name?.trim() || !body.model_id?.trim())
      return res.status(400).json({ error: 'name and model_id required' });
    const modelId = body.model_id.trim().toLowerCase();
    if (!db.prepare('SELECT 1 FROM printer_models WHERE model_id = ?').get(modelId))
      return res.status(400).json({ error: `Unknown model "${modelId}"` });
    const info = db.prepare(`
      INSERT INTO maintenance_model_plans
        (model_id, name, description, interval_days, interval_print_hours, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(modelId, body.name.trim(), body.description || null,
      positiveOrNull(body.interval_days), positiveOrNull(body.interval_print_hours), Date.now());
    res.status(201).json({ id: Number(info.lastInsertRowid), plan_scope: 'model' });
  });

  router.put('/model/:id', (req, res) => {
    const body = req.body || {};
    const old = db.prepare('SELECT * FROM maintenance_model_plans WHERE id = ?').get(req.params.id);
    if (!old) return res.status(404).json({ error: 'Model plan not found' });
    const modelId = body.model_id == null ? old.model_id : String(body.model_id).trim().toLowerCase();
    if (!db.prepare('SELECT 1 FROM printer_models WHERE model_id = ?').get(modelId))
      return res.status(400).json({ error: `Unknown model "${modelId}"` });
    db.prepare(`UPDATE maintenance_model_plans
      SET model_id=?, name=?, description=?, interval_days=?, interval_print_hours=?, is_active=?
      WHERE id=?`).run(modelId, body.name ?? old.name, body.description ?? old.description,
      body.interval_days === undefined ? old.interval_days : positiveOrNull(body.interval_days),
      body.interval_print_hours === undefined ? old.interval_print_hours : positiveOrNull(body.interval_print_hours),
      body.is_active == null ? old.is_active : Number(Boolean(body.is_active)), old.id);
    res.json({ ok: true });
  });

  router.post('/model/:id/complete', (req, res) => {
    const plan = db.prepare('SELECT * FROM maintenance_model_plans WHERE id = ? AND is_active = 1').get(req.params.id);
    const printerId = Number(req.body?.printer_id);
    if (!plan) return res.status(404).json({ error: 'Model plan not found' });
    const printer = db.prepare('SELECT * FROM printers WHERE id = ? AND is_active = 1').get(printerId);
    if (!printer || printer.model !== plan.model_id)
      return res.status(400).json({ error: 'Printer does not belong to this maintenance plan model' });
    const now = Date.now(), hours = printHours(db, printerId, now), cost = Number(req.body?.cost || 0);
    db.transaction(() => {
      db.prepare(`INSERT INTO maintenance_records
        (printer_id, plan_id, model_plan_id, performed_at, print_hours, cost, notes, performed_by)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`).run(printerId, plan.id, now, hours, cost,
          req.body?.notes || null, req.body?.performed_by || null);
      db.prepare(`INSERT INTO maintenance_model_states
        (model_plan_id, printer_id, last_completed_at, last_completed_print_hours)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(model_plan_id, printer_id) DO UPDATE SET
          last_completed_at=excluded.last_completed_at,
          last_completed_print_hours=excluded.last_completed_print_hours
      `).run(plan.id, printerId, now, hours);
      logMaintenance(db, printerId, plan, req.body, cost, now);
    })();
    res.json({ ok: true });
  });

  router.post('/:id/complete', (req, res) => {
    const plan = db.prepare('SELECT * FROM maintenance_plans WHERE id=?').get(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const now = Date.now(), hours = printHours(db, plan.printer_id, now), cost = Number(req.body?.cost || 0);
    db.transaction(() => {
      db.prepare(`INSERT INTO maintenance_records
        (printer_id,plan_id,performed_at,print_hours,cost,notes,performed_by)
        VALUES (?,?,?,?,?,?,?)`).run(plan.printer_id, plan.id, now, hours, cost,
          req.body?.notes || null, req.body?.performed_by || null);
      db.prepare('UPDATE maintenance_plans SET last_completed_at=?,last_completed_print_hours=? WHERE id=?')
        .run(now, hours, plan.id);
      logMaintenance(db, plan.printer_id, plan, req.body, cost, now);
    })();
    res.json({ ok: true });
  });

  router.get('/history/all', (req, res) => res.json(db.prepare(`
    SELECT r.*, p.name printer_name, p.model model_id, COALESCE(m.name, mp.name) plan_name,
           CASE WHEN r.model_plan_id IS NOT NULL THEN 'model' ELSE 'printer' END plan_scope
    FROM maintenance_records r JOIN printers p ON p.id=r.printer_id
    LEFT JOIN maintenance_plans m ON m.id=r.plan_id
    LEFT JOIN maintenance_model_plans mp ON mp.id=r.model_plan_id
    ORDER BY performed_at DESC LIMIT ?
  `).all(Math.min(1000, Number(req.query.limit) || 200))));

  router.delete('/model/:id', (req, res) => {
    const result = db.prepare('UPDATE maintenance_model_plans SET is_active=0 WHERE id=?').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Model plan not found' });
    res.json({ ok: true });
  });
  router.delete('/:id', (req, res) => {
    db.prepare('UPDATE maintenance_plans SET is_active=0 WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });
  return router;
};
