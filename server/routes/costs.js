const express = require('express');

module.exports = (db) => {
  const router = express.Router();
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
        COALESCE(SUM(j.maintenance_cost),0) maintenance_cost
      FROM projects pr
      LEFT JOIN parts pa ON pa.project_id=pr.id
      LEFT JOIN jobs j ON j.part_id=pa.id AND j.status IN ('finished','failed')
        AND j.finished_at BETWEEN ? AND ?
      GROUP BY pr.id ORDER BY pr.name
    `).all(from, to).map(project => {
      const production_cost = project.material_cost + project.machine_cost +
        project.energy_cost + project.maintenance_cost;
      return { ...project, production_cost, profit: project.revenue - production_cost };
    });

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
    const totalCost = jobTotals.production + generalMaintenance;

    res.json({
      jobs,
      projects,
      maintenance_cost: generalMaintenance,
      totals: {
        ...jobTotals,
        total: totalCost,
        revenue,
        profit: revenue - totalCost,
      },
    });
  });
  return router;
};
