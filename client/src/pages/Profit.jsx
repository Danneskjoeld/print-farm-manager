import { useEffect, useState } from 'react';

const formatMoney = value => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' }).format(Number(value) || 0);

export default function Profit() {
  const [financials, setFinancials] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch('/api/dashboard');
        if (!response.ok) throw new Error('Profit data could not be loaded');
        const data = await response.json();
        if (!disposed) { setFinancials(data.financials); setError(''); }
      } catch (err) { if (!disposed) setError(err.message); }
    };
    load();
    const timer = setInterval(load, 15000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  if (!financials) return <p role={error ? 'alert' : 'status'}>{error || 'Loading profit data…'}</p>;
  return <div>
    <h1 style={{fontSize:22,marginBottom:20}}>Profit</h1>
    {error && <p role="alert" style={{color:'#fca5a5'}}>{error}</p>}
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12,marginBottom:20}}>
      {[['Revenue',financials.revenue],['Total costs',financials.total_cost],['Farm profit',financials.profit]].map(([label,value])=>
        <div key={label} style={{background:'#111827',borderRadius:8,padding:16}}>
          <div style={{color:'#94a3b8',fontSize:12}}>{label}</div><div style={{fontWeight:700,fontSize:24,marginTop:6}}>{formatMoney(value)}</div>
        </div>)}
    </div>
        <div style={{background:'#111827',borderRadius:10,padding:'16px 20px',overflowX:'auto'}}>
          <div style={{fontSize:14,fontWeight:700,marginBottom:10}}>Revenue by technology</div>
          <p style={{fontSize:12,color:'#94a3b8'}}>All time · Revenue from completed projects. Costs include all project costs; general farm maintenance is excluded here.</p>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12,marginBottom:24}}>
            <thead><tr>{['Technology','Completed projects','Revenue','Revenue share','Project costs','Profit'].map(h => <th key={h} style={{textAlign:'left',padding:8,color:'#94a3b8'}}>{h}</th>)}</tr></thead>
            <tbody>{(financials?.by_technology || []).map(row => <tr key={row.technology || 'unassigned'} style={{borderTop:'1px solid #334155'}}>
              <td style={{padding:8,fontWeight:700}}>{row.technology || 'Not assigned'}</td><td>{row.completed_projects}</td>
              <td>{formatMoney(row.revenue)}</td><td>{financials.revenue > 0 ? `${(100 * row.revenue / financials.revenue).toFixed(1)} %` : '—'}</td>
              <td>{formatMoney(row.production_cost)}</td><td style={{color:row.profit >= 0 ? '#22c55e' : '#ef4444'}}>{formatMoney(row.profit)}</td>
            </tr>)}</tbody>
          </table>
          <div style={{fontSize:11,color:'#64748b',textTransform:'uppercase',letterSpacing:'0.15em',fontWeight:700,marginBottom:10}}>Project Profitability</div>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}><thead><tr>
            {['Project','Customer','Technology','Status','Price','Revenue','Cost','Profit'].map(h=><th key={h} style={{textAlign:'left',padding:'6px 8px',color:'#475569'}}>{h}</th>)}
          </tr></thead><tbody>{(financials?.projects||[]).map(p=><tr key={p.id} style={{borderTop:'1px solid #1e293b'}}>
            <td style={{padding:'7px 8px',fontWeight:600}}>{p.name}</td><td style={{padding:'7px 8px',color:'#94a3b8'}}>{p.customer_name || '—'}</td><td>{p.technology || 'Not assigned'}</td><td>{p.status}</td><td>{formatMoney(p.sale_price)}</td>
            <td>{formatMoney(p.revenue)}</td><td>{formatMoney(p.production_cost)}</td>
            <td style={{color:p.profit>=0?'#22c55e':'#ef4444',fontWeight:700}}>{formatMoney(p.profit)}</td>
          </tr>)}</tbody></table>
        </div>
    {financials.projects.length === 0 && <p>No projects yet.</p>}
  </div>;
}

