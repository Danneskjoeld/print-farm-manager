import { useEffect, useState } from 'react';
const box={background:'#1e2433',border:'1px solid #2d3748',borderRadius:8,padding:16};
const eur=n=>new Intl.NumberFormat(undefined,{style:'currency',currency:'EUR'}).format(Number(n)||0);
const input={background:'#0f172a',color:'#e2e8f0',border:'1px solid #334155',borderRadius:4,padding:'6px 8px',width:90};

export default function Costs(){
  const [data,setData]=useState(null),[printers,setPrinters]=useState([]),[electricity,setElectricity]=useState('0.30');
  const load=()=>Promise.all([
    fetch('/api/costs').then(r=>r.json()),fetch('/api/printers').then(r=>r.json()),fetch('/api/settings').then(r=>r.json())
  ]).then(([a,b,c])=>{setData(a);setPrinters(b);setElectricity(c.electricity_price_kwh||'0.30')});
  useEffect(()=>{load()},[]);
  const savePrinter=async(p,k,v)=>{await fetch(`/api/printers/${p.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({[k]:Number(v)})});load()};
  const saveElectricity=()=>fetch('/api/settings/electricity_price_kwh',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:electricity})});
  if(!data)return <p>Loading…</p>;
  const t=data.totals;
  const cards=[
    ['Revenue',t.revenue,'#22c55e'],['Total cost',t.total,'#f59e0b'],['Profit',t.profit,t.profit>=0?'#22c55e':'#ef4444'],
    ['Material',t.material],['Machine',t.machine],['Energy',t.energy],['Maintenance',data.maintenance_cost],
  ];
  return <div><h1>Financials & Cost Accounting</h1>
    <p style={{color:'#94a3b8'}}>Revenue is recognized when a project is completed. Profit equals revenue minus recorded production and general maintenance costs.</p>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))',gap:10}}>
      {cards.map(([label,value,color])=><div style={box} key={label}><div style={{color:'#64748b',fontSize:12}}>{label}</div><div style={{fontSize:24,fontWeight:700,color}}>{eur(value)}</div></div>)}
    </div>
    <h2 style={{marginTop:24}}>Rates</h2><div style={box}>
      <label>Electricity €/kWh <input style={input} type="number" step="0.01" value={electricity} onChange={e=>setElectricity(e.target.value)} onBlur={saveElectricity}/></label>
      {printers.map(p=><div key={p.id} style={{display:'flex',gap:10,alignItems:'center',marginTop:10}}><strong style={{width:160}}>{p.name}</strong><label>€/hour <input style={input} type="number" step="0.01" defaultValue={p.hourly_cost||0} onBlur={e=>savePrinter(p,'hourly_cost',e.target.value)}/></label><label>Watts <input style={input} type="number" defaultValue={p.power_watts||0} onBlur={e=>savePrinter(p,'power_watts',e.target.value)}/></label></div>)}
    </div>
    <h2 style={{marginTop:24}}>Project profitability</h2>
    <div style={{...box,overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
      <thead><tr>{['Project','Status','Jobs / parts','Project price','Recognized revenue','Production cost','Profit'].map(x=><th key={x} style={{textAlign:'left',padding:8,color:'#64748b'}}>{x}</th>)}</tr></thead>
      <tbody>{data.projects.map(p=><tr key={p.id} style={{borderTop:'1px solid #2d3748'}}>
        <td style={{padding:8,fontWeight:600}}>{p.name}</td><td>{p.status}</td><td>{p.jobs||0} / {p.parts||0}</td>
        <td>{eur(p.sale_price)}</td><td>{eur(p.revenue)}</td><td>{eur(p.production_cost)}</td>
        <td style={{color:p.profit>=0?'#22c55e':'#ef4444',fontWeight:700}}>{eur(p.profit)}</td>
      </tr>)}</tbody>
    </table></div>
    <h2 style={{marginTop:24}}>Recent jobs</h2><div style={{...box,overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr>{['Job','Project / part','Printer','Finished','Cost'].map(x=><th key={x} style={{textAlign:'left',padding:8,color:'#64748b'}}>{x}</th>)}</tr></thead><tbody>{data.jobs.map(j=><tr key={j.id}><td style={{padding:8}}>#{j.id}</td><td>{j.project_name} / {j.part_name}</td><td>{j.printer_name}</td><td>{new Date(j.finished_at).toLocaleString()}</td><td>{eur(j.total_cost)}</td></tr>)}</tbody></table></div>
  </div>;
}
