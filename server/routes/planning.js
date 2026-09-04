const express = require('express');

const BLOCKED_STATUSES = new Set(['ERROR', 'OFFLINE', 'UNKNOWN']);
const MAX_PLANNED_PLATES = 5000;

function parseGroups(value) {
  if (!value) return null;
  try {
    const groups = JSON.parse(value);
    return Array.isArray(groups) && groups.length ? groups : null;
  } catch (_) {
    return [];
  }
}

function matchesPrinter(printer, gcode, project) {
  if (printer.model !== gcode.printer_model) return false;
  const groups = parseGroups(gcode.allowed_groups ?? project.allowed_groups);
  if (groups && !groups.includes(printer.group_name)) return false;
  const material = gcode.required_material ?? project.required_material;
  const color = gcode.required_color ?? project.required_color;
  if (material && printer.loaded_material !== material) return false;
  if (color && printer.loaded_color !== color) return false;
  return true;
}

module.exports = (db) => {
  const router = express.Router();

  router.get('/', (_req, res) => {
    const now = Date.now();
    const printers = db.prepare(`
      SELECT * FROM printers
      WHERE is_active=1 AND type!='manual'
      ORDER BY name
    `).all();
    const eligible = printers.filter(p => !p.is_held && !BLOCKED_STATUSES.has(p.status));
    const lanes = new Map(eligible.map(p => [p.id, {
      printer_id: p.id,
      printer_name: p.name,
      model: p.model,
      available_at: now,
      tasks: [],
    }]));

    // Put active work at the beginning of each lane and delay subsequent work
    // until the live remaining-time estimate (or G-code fallback) has elapsed.
    const activeJobs = db.prepare(`
      SELECT j.*, pa.name part_name, pr.id project_id, pr.name project_name,
             g.est_print_secs, p.job_time_remaining
      FROM jobs j
      JOIN printers p ON p.id=j.printer_id
      JOIN parts pa ON pa.id=j.part_id
      JOIN projects pr ON pr.id=pa.project_id
      LEFT JOIN gcodes g ON g.id=j.gcode_id
      WHERE j.status IN ('uploading','printing')
    `).all();
    for (const job of activeJobs) {
      const lane = lanes.get(job.printer_id);
      if (!lane) continue;
      const startedAt = Number(job.started_at || now);
      const fallbackEnd = startedAt + Math.max(60, Number(job.est_print_secs || 0)) * 1000;
      const endAt = Number(job.job_time_remaining) > 0
        ? now + Number(job.job_time_remaining) * 1000 : Math.max(now, fallbackEnd);
      lane.available_at = endAt;
      lane.tasks.push({
        id: `active-${job.id}`, job_id: job.id, status: job.status,
        project_id: job.project_id, project_name: job.project_name,
        part_id: job.part_id, part_name: job.part_name,
        quantity: job.parts_per_plate, start_at: startedAt, end_at: endAt,
      });
    }

    const projects = db.prepare(`
      SELECT * FROM projects WHERE status='active'
      ORDER BY priority ASC, created_at ASC, id ASC
    `).all();
    const partStmt = db.prepare(`
      SELECT pa.*, COALESCE((SELECT SUM(j.parts_per_plate) FROM jobs j
        WHERE j.part_id=pa.id AND j.status IN ('uploading','printing')),0) active_qty
      FROM parts pa
      WHERE pa.project_id=? AND pa.status='open' AND pa.completed_qty < pa.target_qty
      ORDER BY pa.sort_order, pa.created_at, pa.id
    `);
    const gcodeStmt = db.prepare('SELECT * FROM gcodes WHERE part_id=? ORDER BY id');
    const unscheduled = [];
    let plannedPlates = 0;
    let plannedParts = 0;

    for (const project of projects) {
      for (const part of partStmt.all(project.id)) {
        let remaining = Math.max(0, Number(part.target_qty) - Number(part.completed_qty) - Number(part.active_qty));
        if (!remaining) continue;
        const gcodes = gcodeStmt.all(part.id).filter(g => Number(g.parts_per_plate) > 0 && Number(g.est_print_secs) > 0);
        if (!gcodes.length) {
          unscheduled.push({ project_id:project.id, project_name:project.name, part_id:part.id,
            part_name:part.name, quantity:remaining, reason:'Missing G-code or print duration' });
          continue;
        }

        while (remaining > 0 && plannedPlates < MAX_PLANNED_PLATES) {
          let best = null;
          for (const gcode of gcodes) {
            for (const printer of eligible) {
              if (!matchesPrinter(printer, gcode, project)) continue;
              const lane = lanes.get(printer.id);
              const finish = lane.available_at + Number(gcode.est_print_secs) * 1000;
              if (!best || finish < best.finish) best = { gcode, lane, finish };
            }
          }
          if (!best) {
            unscheduled.push({ project_id:project.id, project_name:project.name, part_id:part.id,
              part_name:part.name, quantity:remaining, reason:'No currently eligible printer' });
            break;
          }
          const quantity = Math.min(remaining, Number(best.gcode.parts_per_plate));
          const startAt = best.lane.available_at;
          best.lane.tasks.push({
            id:`planned-${plannedPlates + 1}`, status:'planned',
            project_id:project.id, project_name:project.name,
            part_id:part.id, part_name:part.name, quantity,
            plate_capacity:Number(best.gcode.parts_per_plate), gcode_id:best.gcode.id,
            start_at:startAt, end_at:best.finish,
          });
          best.lane.available_at = best.finish;
          remaining -= Number(best.gcode.parts_per_plate);
          plannedParts += quantity;
          plannedPlates++;
        }
        if (remaining > 0 && plannedPlates >= MAX_PLANNED_PLATES) {
          unscheduled.push({ project_id:project.id, project_name:project.name, part_id:part.id,
            part_name:part.name, quantity:remaining, reason:'Planning limit reached' });
        }
      }
    }

    const laneList = [...lanes.values()];
    const endAt = laneList.reduce((latest, lane) => Math.max(latest, lane.available_at), now);
    res.json({
      generated_at: now,
      start_at: now,
      end_at: endAt,
      duration_seconds: Math.ceil((endAt - now) / 1000),
      planned_plates: plannedPlates,
      planned_parts: plannedParts,
      printers_total: printers.length,
      printers_available: eligible.length,
      lanes: laneList,
      unscheduled,
    });
  });

  return router;
};
