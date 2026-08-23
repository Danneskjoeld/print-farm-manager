const express = require('express');

module.exports = (db) => {
  const router = express.Router();
  router.get('/summary', (_req, res) => res.json(db.prepare(`
    SELECT ft.id AS filament_type_id, ft.name AS material,
           fc.id AS filament_color_id, fc.name AS color, fc.hex_color,
           COALESCE(SUM(CASE WHEN r.remaining_weight_g > 0 THEN r.roll_count ELSE 0 END),0) AS roll_count,
           COALESCE(SUM(r.remaining_weight_g),0) AS remaining_weight_g,
           COALESCE(SUM(r.initial_weight_g),0) AS received_weight_g,
           COALESCE(SUM(CASE WHEN r.initial_weight_g > 0
             THEN r.purchase_price * r.remaining_weight_g / r.initial_weight_g ELSE 0 END),0) AS remaining_value
    FROM filament_colors fc
    JOIN filament_types ft ON ft.id=fc.type_id
    LEFT JOIN filament_rolls r ON r.filament_color_id=fc.id AND r.status != 'archived'
    GROUP BY ft.id,fc.id ORDER BY ft.name,fc.name
  `).all()));

  router.get('/', (_req, res) => res.json(db.prepare(`
    SELECT r.*, COALESCE(ft.name,r.material) AS material,
           COALESCE(fc.name,r.color) AS color, fc.hex_color,
           p.id AS printer_id, p.name AS printer_name, s.slot
    FROM filament_rolls r LEFT JOIN printer_filament_slots s ON s.roll_id=r.id
    LEFT JOIN printers p ON p.id=s.printer_id
    LEFT JOIN filament_types ft ON ft.id=r.filament_type_id
    LEFT JOIN filament_colors fc ON fc.id=r.filament_color_id
    ORDER BY r.status, ft.name, fc.name, r.name
  `).all()));

  router.post('/', (req, res) => {
    const b=req.body||{}, weight=Number(b.initial_weight_g), now=Date.now();
    const typeId=Number(b.filament_type_id), colorId=Number(b.filament_color_id);
    if (!b.name?.trim() || !typeId || !colorId || !(weight>0)) return res.status(400).json({error:'name, library material/color and positive initial_weight_g required'});
    const libraryMaterial=db.prepare(`SELECT ft.name AS material,fc.name AS color FROM filament_colors fc JOIN filament_types ft ON ft.id=fc.type_id WHERE fc.id=? AND ft.id=?`).get(colorId,typeId);
    if(!libraryMaterial)return res.status(400).json({error:'Selected color does not belong to the selected filament type'});
    const existing=db.prepare('SELECT * FROM filament_rolls WHERE name = ? COLLATE NOCASE').get(b.name.trim());
    if(existing){
      if(Number(existing.filament_type_id)!==typeId || Number(existing.filament_color_id)!==colorId){
        return res.status(409).json({error:'Diese Bezeichnung wird bereits für ein anderes Material verwendet.'});
      }
      const addedPrice=Number(b.purchase_price||0), balance=Number(existing.remaining_weight_g)+weight, now=Date.now();
      const restock=db.transaction(()=>{
        db.prepare(`UPDATE filament_rolls SET initial_weight_g=initial_weight_g+?,remaining_weight_g=?,purchase_price=purchase_price+?,roll_count=roll_count+1,location=COALESCE(?,location),status='available',updated_at=? WHERE id=?`)
          .run(weight,balance,addedPrice,b.location||null,now,existing.id);
        db.prepare(`INSERT INTO filament_transactions (roll_id,type,amount_g,balance_after_g,note,created_at) VALUES (?,'restock',?,?,?,?)`)
          .run(existing.id,weight,balance,`Wareneingang: ${weight} g`,now);
      });restock();
      return res.json({id:existing.id,restocked:true,added_weight_g:weight,remaining_weight_g:balance});
    }
    const info=db.prepare(`INSERT INTO filament_rolls
      (name,material,color,filament_type_id,filament_color_id,manufacturer,lot_number,location,initial_weight_g,remaining_weight_g,spool_weight_g,purchase_price,min_weight_g,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.name.trim(),libraryMaterial.material,libraryMaterial.color,typeId,colorId,b.manufacturer||null,b.lot_number||null,b.location||null,
      weight,Number(b.remaining_weight_g??weight),Number(b.spool_weight_g||0),Number(b.purchase_price||0),Number(b.min_weight_g??100),'available',now,now);
    res.status(201).json({id:Number(info.lastInsertRowid)});
  });

  router.put('/:id', (req,res) => {
    const old=db.prepare('SELECT * FROM filament_rolls WHERE id=?').get(req.params.id); if(!old)return res.status(404).json({error:'Roll not found'});
    const b=req.body||{};
    let typeId=Number(b.filament_type_id??old.filament_type_id),colorId=Number(b.filament_color_id??old.filament_color_id);
    const libraryMaterial=db.prepare(`SELECT ft.name AS material,fc.name AS color FROM filament_colors fc JOIN filament_types ft ON ft.id=fc.type_id WHERE fc.id=? AND ft.id=?`).get(colorId,typeId);
    if(!libraryMaterial)return res.status(400).json({error:'A valid Filament Library material and color are required'});
    db.prepare(`UPDATE filament_rolls SET name=?,material=?,color=?,filament_type_id=?,filament_color_id=?,manufacturer=?,lot_number=?,location=?,purchase_price=?,min_weight_g=?,status=?,updated_at=? WHERE id=?`)
      .run(b.name??old.name,libraryMaterial.material,libraryMaterial.color,typeId,colorId,b.manufacturer??old.manufacturer,b.lot_number??old.lot_number,b.location??old.location,
        Number(b.purchase_price??old.purchase_price),Number(b.min_weight_g??old.min_weight_g),b.status??old.status,Date.now(),old.id);
    res.json(db.prepare('SELECT * FROM filament_rolls WHERE id=?').get(old.id));
  });

  router.post('/:id/adjust', (req,res) => {
    const roll=db.prepare('SELECT * FROM filament_rolls WHERE id=?').get(req.params.id); if(!roll)return res.status(404).json({error:'Roll not found'});
    const balance=Number(req.body?.remaining_weight_g); if(!Number.isFinite(balance)||balance<0)return res.status(400).json({error:'valid remaining_weight_g required'});
    const now=Date.now(), delta=balance-roll.remaining_weight_g;
    const tx=db.transaction(()=>{db.prepare('UPDATE filament_rolls SET remaining_weight_g=?,status=?,updated_at=? WHERE id=?').run(balance,balance<=0?'empty':'available',now,roll.id);
      db.prepare(`INSERT INTO filament_transactions (roll_id,type,amount_g,balance_after_g,note,created_at) VALUES (?,'adjustment',?,?,?,?)`)
        .run(roll.id,delta,balance,req.body?.note||'Manual correction',now);}); tx();
    res.json(db.prepare('SELECT * FROM filament_rolls WHERE id=?').get(roll.id));
  });

  // Remove one physical roll from a pooled inventory position. The operator
  // supplies its actual remaining net weight. Received weight and purchase cost
  // remain historical totals, preserving the weighted-average cost per gram.
  router.post('/:id/remove-roll', (req,res) => {
    const roll=db.prepare('SELECT * FROM filament_rolls WHERE id=?').get(req.params.id);
    if(!roll)return res.status(404).json({error:'Lagerposition nicht gefunden'});
    const count=Math.max(1,Number(roll.roll_count||1));
    let removed=Number(req.body?.remaining_weight_g);
    if(!Number.isFinite(removed)||removed<0||removed>Number(roll.remaining_weight_g))return res.status(400).json({error:'Gültiges Restgewicht der entfernten Rolle erforderlich'});
    if(count===1)removed=Number(roll.remaining_weight_g);
    const balance=Math.max(0,Number(roll.remaining_weight_g)-removed);
    const newCount=count-1,now=Date.now();
    const remove=db.transaction(()=>{
      db.prepare(`UPDATE filament_rolls SET roll_count=?,remaining_weight_g=?,status=?,updated_at=? WHERE id=?`)
        .run(newCount,balance,newCount===0?'empty':'available',now,roll.id);
      db.prepare(`INSERT INTO filament_transactions (roll_id,type,amount_g,balance_after_g,note,created_at) VALUES (?,'removal',?,?,?,?)`)
        .run(roll.id,-removed,balance,req.body?.note||'Physische Rolle aus Bestand entfernt',now);
    });remove();
    res.json({ok:true,removed_weight_g:removed,remaining_weight_g:balance,roll_count:newCount});
  });

  router.post('/:id/assign', (req,res) => {
    const roll=db.prepare('SELECT id FROM filament_rolls WHERE id=?').get(req.params.id); if(!roll)return res.status(404).json({error:'Roll not found'});
    const printerId=Number(req.body?.printer_id), slot=Number(req.body?.slot||0);
    if(!db.prepare('SELECT id FROM printers WHERE id=?').get(printerId))return res.status(400).json({error:'valid printer_id required'});
    const assign=db.transaction(()=>{db.prepare('DELETE FROM printer_filament_slots WHERE roll_id=? OR (printer_id=? AND slot=?)').run(roll.id,printerId,slot);
      db.prepare('INSERT INTO printer_filament_slots (printer_id,slot,roll_id) VALUES (?,?,?)').run(printerId,slot,roll.id);}); assign(); res.json({ok:true});
  });
  router.delete('/:id/assign', (req,res)=>{db.prepare('DELETE FROM printer_filament_slots WHERE roll_id=?').run(req.params.id);res.json({ok:true});});
  router.get('/:id/transactions',(req,res)=>res.json(db.prepare('SELECT * FROM filament_transactions WHERE roll_id=? ORDER BY created_at DESC').all(req.params.id)));
  router.delete('/:id',(req,res)=>{const used=db.prepare('SELECT 1 FROM filament_transactions WHERE roll_id=? LIMIT 1').get(req.params.id);if(used)return res.status(409).json({error:'Roll has transaction history; archive it instead'});db.prepare('DELETE FROM filament_rolls WHERE id=?').run(req.params.id);res.json({ok:true});});
  return router;
};
