const express=require('express');
module.exports=(db)=>{const router=express.Router();
  router.get('/',(req,res)=>{const from=Number(req.query.from)||0,to=Number(req.query.to)||Date.now();
    const jobs=db.prepare(`SELECT j.id,j.status,j.started_at,j.finished_at,j.parts_per_plate,j.material_cost,j.machine_cost,j.energy_cost,j.maintenance_cost,
      p.name printer_name,pa.name part_name,pr.id project_id,pr.name project_name,
      (COALESCE(j.material_cost,0)+COALESCE(j.machine_cost,0)+COALESCE(j.energy_cost,0)+COALESCE(j.maintenance_cost,0)) total_cost
      FROM jobs j JOIN printers p ON p.id=j.printer_id JOIN parts pa ON pa.id=j.part_id JOIN projects pr ON pr.id=pa.project_id
      WHERE j.status='finished' AND j.finished_at BETWEEN ? AND ? ORDER BY j.finished_at DESC`).all(from,to);
    const projects=db.prepare(`SELECT pr.id,pr.name,COUNT(j.id) jobs,SUM(j.parts_per_plate) parts,
      SUM(COALESCE(j.material_cost,0)) material_cost,SUM(COALESCE(j.machine_cost,0)) machine_cost,SUM(COALESCE(j.energy_cost,0)) energy_cost,SUM(COALESCE(j.maintenance_cost,0)) maintenance_cost
      FROM projects pr LEFT JOIN parts pa ON pa.project_id=pr.id LEFT JOIN jobs j ON j.part_id=pa.id AND j.status='finished' AND j.finished_at BETWEEN ? AND ? GROUP BY pr.id ORDER BY pr.name`).all(from,to);
    const maintenance=db.prepare('SELECT COALESCE(SUM(cost),0) total FROM maintenance_records WHERE performed_at BETWEEN ? AND ?').get(from,to).total;
    res.json({jobs,projects,maintenance_cost:maintenance,totals:jobs.reduce((a,j)=>{a.material+=j.material_cost||0;a.machine+=j.machine_cost||0;a.energy+=j.energy_cost||0;a.total+=j.total_cost||0;return a;},{material:0,machine:0,energy:0,total:maintenance})});});
  return router;};
