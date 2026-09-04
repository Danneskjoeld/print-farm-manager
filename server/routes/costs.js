const express = require('express');

module.exports = (db) => {
  const router = express.Router();
  const categories = new Set(['material', 'machine', 'energy', 'maintenance', 'other']);

  router.post('/projects/:projectId/manual', (req, res) => {
    const project = db.prepare('SELECT id FROM projects WHERE id=?').get(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const amount = Number(req.body?.amount);
    const category = String(req.body?.category || 'other').toLowerCase();
    const incurredAt = req.body?.incurred_at == null ? Date.now() : Number(req.body.incurred_at);
    if (!Number.isFinite(amount) || amount <= 0)
      return res.status(400).json({ error: 'amount must be greater than zero' });
    if (!categories.has(category))
      return res.status(400).json({ error: 'invalid category' });
    if (!Number.isFinite(incurredAt) || incurredAt <= 0)
      return res.status(400).json({ error: 'invalid incurred_at' });
    const info = db.prepare(`INSERT INTO project_costs
      (project_id,category,amount,note,incurred_at,created_at) VALUES (?,?,?,?,?,?)`)
      .run(project.id, category, amount, req.body?.note?.trim() || null, incurredAt, Date.now());
    res.status(201).json(db.prepare('SELECT * FROM project_costs WHERE id=?').get(info.lastInsertRowid));
  });

  router.delete('/manual/:id', (req, res) => {
    const result = db.prepare('DELETE FROM project_costs WHERE id=?').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Manual project cost not found' });
    res.json({ ok: true });
  });

  router.get('/', (req, res) => {
    const from = Number(req.query.from) || 0;
    const to = Number(req.query.to) || Date.now();
    const jobs = db.prepare(`
      SELECT j.id,j.status,j.started_at,j.finished_at,j.parts_per_plate,
        j.material_cost,j.machine_cost,j.energy_cost,j.maintenance_cost,
        p.name printer_name,pa.name part_name,pr.id project_id,pr.name project_name,
        (COALESCE(j.material_cost,0)+COALESCE(j.machine_cost,0)+
         COALESCE(j.energy_cost,0)+COALESCE(j.maintenance_cost,0)) total_cost
      FROM jobs j
      JOIN printers p ON p.id=j.printer_id
      JOIN parts pa ON pa.id=j.part_id
      JOIN projects pr ON pr.id=pa.project_id
      WHERE j.status IN ('finished','failed') AND j.finished_at BETWEEN ? AND ?
      ORDER BY j.finished_at DESC
    `).all(from, to);

    const projects = db.prepare(`
      SELECT pr.id,pr.name,pr.status,COALESCE(pr.sale_price,0) sale_price,
        CASE WHEN pr.status='completed' THEN COALESCE(pr.sale_price,0) ELSE 0 END revenue,
        COUNT(j.id) jobs,COALESCE(SUM(j.parts_per_plate),0) parts,
        COALESCE(SUM(j.material_cost),0) material_cost,
        COALESCE(SUM(j.machine_cost),0) machine_cost,
        COALESCE(SUM(j.energy_cost),0) energy_cost,
        COALESCE(SUM(j.maintenance_cost),0) maintenance_cost,
        COALESCE((SELECT SUM(pc.amount) FROM project_costs pc
          WHERE pc.project_id=pr.id AND pc.incurred_at BETWEEN ? AND ?),0) manual_cost
      FROM projects pr
      LEFT JOIN parts pa ON pa.project_id=pr.id
      LEFT JOIN jobs j ON j.part_id=pa.id AND j.status IN ('finished','failed')
        AND j.finished_at BETWEEN ? AND ?
      GROUP BY pr.id ORDER BY pr.name
    `).all(from, to, from, to).map(project => {
      const production_cost = project.material_cost + project.machine_cost +
        project.energy_cost + project.maintenance_cost + project.manual_cost;
      return { ...project, production_cost, profit: project.revenue - production_cost };
    });

    const manualCosts = db.prepare(`
      SELECT pc.*, pr.name project_name FROM project_costs pc
      JOIN projects pr ON pr.id=pc.project_id
      WHERE pc.incurred_at BETWEEN ? AND ?
      ORDER BY pc.incurred_at DESC, pc.id DESC
    `).all(from, to);

    const generalMaintenance = Number(db.prepare(`
      SELECT COALESCE(SUM(cost),0) total FROM maintenance_records
      WHERE performed_at BETWEEN ? AND ?
    `).get(from, to).total);
    const jobTotals = jobs.reduce((total, job) => {
      total.material += Number(job.material_cost || 0);
      total.machine += Number(job.machine_cost || 0);
      total.energy += Number(job.energy_cost || 0);
      total.job_maintenance += Number(job.maintenance_cost || 0);
      total.production += Number(job.total_cost || 0);
      return total;
    }, { material:0, machine:0, energy:0, job_maintenance:0, production:0 });
    const revenue = projects.reduce((sum, project) => sum + Number(project.revenue || 0), 0);
    const manualTotal = manualCosts.reduce((sum, cost) => sum + Number(cost.amount || 0), 0);
    const totalCost = jobTotals.production + generalMaintenance + manualTotal;

    res.json({
      jobs,
      projects,
      manual_costs: manualCosts,
      maintenance_cost: generalMaintenance,
      totals: {
        ...jobTotals,
        manual: manualTotal,
        total: totalCost,
        revenue,
        profit: revenue - totalCost,
      },
    });
  });
  return router;
};
