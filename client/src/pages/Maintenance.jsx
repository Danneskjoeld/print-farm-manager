import { useEffect, useMemo, useState } from 'react';

const box = { background:'#1e2433', border:'1px solid #2d3748', borderRadius:8, padding:16 };
const input = { background:'#0f172a', color:'#e2e8f0', border:'1px solid #334155', borderRadius:4, padding:'7px 9px' };

export default function Maintenance() {
  const [plans, setPlans] = useState([]), [history, setHistory] = useState([]), [models, setModels] = useState([]);
  const [form, setForm] = useState({ model_id:'', name:'', description:'', interval_days:'', interval_print_hours:'' });
  const load = () => Promise.all([
    fetch('/api/maintenance').then(r => r.json()),
    fetch('/api/maintenance/history/all').then(r => r.json()),
    fetch('/api/models').then(r => r.json()),
  ]).then(([a,b,c]) => { setPlans(a); setHistory(b); setModels(c); });
  useEffect(() => { load(); }, []);

  const groups = useMemo(() => {
    const result = new Map();
    plans.filter(p => p.is_active).forEach(plan => {
      const key = plan.plan_scope === 'model' ? `model-${plan.id}` : `printer-${plan.id}`;
      if (!result.has(key)) result.set(key, { ...plan, machines:[] });
      result.get(key).machines.push(plan);
    });
    return [...result.values()];
  }, [plans]);

  const add = async () => {
    const response = await fetch('/api/maintenance', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(form) });
    if (!response.ok) return alert((await response.json()).error);
    setForm({ ...form, name:'', description:'' }); load();
  };
  const done = async plan => {
    const notes = prompt(`Work performed on ${plan.printer_name}: ${plan.name}`, 'Completed');
    if (notes == null) return;
    const cost = prompt('Maintenance cost (€)', '0');
    const url = plan.plan_scope === 'model' ? `/api/maintenance/model/${plan.id}/complete` : `/api/maintenance/${plan.id}/complete`;
    await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ printer_id:plan.printer_id, notes, cost:Number(cost || 0) }) });
    load();
  };

  return <div><h1>Maintenance</h1>
    <p style={{color:'#94a3b8'}}>Define service plans once per printer model. Completion and history remain individual for every machine.</p>
    <div style={{...box,display:'flex',gap:8,flexWrap:'wrap',marginBottom:18}}>
      <select style={input} value={form.model_id} onChange={e=>setForm({...form,model_id:e.target.value})}>
        <option value="">Printer model</option>{models.map(m=><option value={m.model_id} key={m.model_id}>{m.label}</option>)}
      </select>
      <input style={input} placeholder="Task" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/>
      <input style={input} placeholder="Description" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/>
      <input style={input} type="number" min="1" placeholder="Every N days" value={form.interval_days} onChange={e=>setForm({...form,interval_days:e.target.value})}/>
      <input style={input} type="number" min="1" placeholder="Every N print hours" value={form.interval_print_hours} onChange={e=>setForm({...form,interval_print_hours:e.target.value})}/>
      <button onClick={add}>Add model plan</button>
    </div>
    <h2>Plans by printer model</h2>
    <div style={{display:'grid',gap:14}}>{groups.map(group=><section key={`${group.plan_scope}-${group.id}`} style={box}>
      <div style={{marginBottom:10}}><strong>{group.model_label || group.model_id} · {group.name}</strong>
        {group.description && <div style={{color:'#94a3b8',fontSize:13,marginTop:3}}>{group.description}</div>}
        <div style={{color:'#64748b',fontSize:12,marginTop:3}}>{group.machines.length} machine{group.machines.length===1?'':'s'} covered</div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:8}}>
        {group.machines.map(machine=><div key={`${machine.plan_scope}-${machine.id}-${machine.printer_id}`} style={{...box,padding:12,borderColor:machine.is_due?'#ef4444':'#334155'}}>
          <strong>{machine.printer_name}</strong>
          <div style={{margin:'6px 0',color:machine.is_due?'#f87171':'#94a3b8'}}>{machine.is_due?'Due now':'On schedule'}</div>
          <div style={{fontSize:12,color:'#64748b'}}>{Number(machine.current_print_hours).toFixed(1)} print hours{machine.due_print_hours!=null?` · due at ${Number(machine.due_print_hours).toFixed(1)} h`:''}{machine.due_at?` · ${new Date(machine.due_at).toLocaleDateString()}`:''}</div>
          <button style={{marginTop:10}} onClick={()=>done(machine)}>Mark completed</button>
        </div>)}
      </div>
    </section>)}</div>
    <h2 style={{marginTop:24}}>Machine history</h2>
    <div style={box}>{history.length===0?'No maintenance recorded.':history.map(h=><div key={h.id} style={{padding:'8px 0',borderBottom:'1px solid #2d3748'}}>
      <strong>{h.printer_name}</strong> · {h.plan_name||'Maintenance'} · {new Date(h.performed_at).toLocaleString()} · €{Number(h.cost).toFixed(2)}
      <div style={{color:'#64748b',fontSize:12}}>{h.notes}</div>
    </div>)}</div>
  </div>;
}
