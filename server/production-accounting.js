function printHours(db, printerId, until = Date.now()) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN COALESCE(finished_at, ?) > started_at THEN COALESCE(finished_at, ?) - started_at ELSE 0 END), 0) AS ms
    FROM jobs WHERE printer_id = ? AND started_at IS NOT NULL
  `).get(until, until, printerId);
  return row.ms / 3600000;
}

function accountFinishedJob(db, jobId) {
  let job;
  try {
    job = db.prepare(`
    SELECT j.*, g.material_grams, g.ams_slot, p.hourly_cost, p.power_watts
    FROM jobs j JOIN printers p ON p.id = j.printer_id
    LEFT JOIN gcodes g ON g.id = j.gcode_id WHERE j.id = ?
    `).get(jobId);
  } catch (err) {
    // Unit-test/minimal legacy schemas may not contain the accounting columns.
    // Production db.js always migrates them before the scheduler starts.
    if (/no such (table|column)/i.test(err.message)) return null;
    throw err;
  }
  if (!job) return null;

  const hours = Math.max(0, ((job.finished_at || Date.now()) - (job.started_at || job.created_at)) / 3600000);
  const electricity = Number(db.prepare("SELECT value FROM settings WHERE key='electricity_price_kwh'").get()?.value || 0);
  const machineCost = hours * Number(job.hourly_cost || 0);
  const energyCost = hours * Number(job.power_watts || 0) / 1000 * electricity;
  let materialCost = Number(job.material_cost || 0);

  const grams = Number(job.material_grams || 0);
  if (grams > 0) {
    const existing = db.prepare("SELECT id FROM filament_transactions WHERE job_id=? AND type='consumption'").get(job.id);
    if (!existing) {
      const slot = job.ams_slot == null ? 0 : job.ams_slot;
      const roll = db.prepare(`SELECT r.* FROM printer_filament_slots s JOIN filament_rolls r ON r.id=s.roll_id
        WHERE s.printer_id=? AND s.slot=?`).get(job.printer_id, slot);
      if (roll) {
        const used = Math.min(grams, Math.max(0, roll.remaining_weight_g));
        const balance = Math.max(0, roll.remaining_weight_g - used);
        materialCost = used * (Number(roll.purchase_price || 0) / Math.max(1, Number(roll.initial_weight_g || 1)));
        const now = Date.now();
        db.prepare('UPDATE filament_rolls SET remaining_weight_g=?, status=?, updated_at=? WHERE id=?')
          .run(balance, balance <= 0 ? 'empty' : 'available', now, roll.id);
        db.prepare(`INSERT INTO filament_transactions (roll_id,job_id,type,amount_g,balance_after_g,note,created_at)
          VALUES (?,?,'consumption',?,?,?,?)`).run(roll.id, job.id, -used, balance, `Automatic job ${job.id}`, now);
      }
    }
  }
  db.prepare('UPDATE jobs SET material_cost=?, machine_cost=?, energy_cost=? WHERE id=?')
    .run(materialCost, machineCost, energyCost, job.id);
  return { materialCost, machineCost, energyCost };
}

module.exports = { accountFinishedJob, printHours };
