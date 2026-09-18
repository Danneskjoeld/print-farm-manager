import { useEffect, useState } from 'react';

const formatMoney = value => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' }).format(Number(value) || 0);

function monthsForRange(monthlyRevenue = [], range) {
  const revenueByMonth = new Map(monthlyRevenue.map(row => [row.month, Number(row.revenue) || 0]));
  const months = [];
  const cursor = new Date();
  cursor.setDate(1);
  cursor.setHours(12, 0, 0, 0);
  const count = range === '3months' ? 3 : range === 'year' ? cursor.getMonth() + 1 : 12;
  for (let index = count - 1; index >= 0; index--) {
    const date = new Date(cursor.getFullYear(), cursor.getMonth() - index, 1, 12);
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    months.push({ month, date, revenue: revenueByMonth.get(month) || 0 });
  }
  return months;
}

function MonthlyRevenueChart({ monthlyRevenue, range, onRangeChange }) {
  const points = monthsForRange(monthlyRevenue, range);
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const trend = points.map((_, index) => {
    const count = points.length;
    const meanX = (count - 1) / 2;
    const meanY = points.reduce((sum, point) => sum + point.revenue, 0) / count;
    const numerator = points.reduce((sum, point, x) => sum + (x - meanX) * (point.revenue - meanY), 0);
    const denominator = points.reduce((sum, _, x) => sum + (x - meanX) ** 2, 0);
    return Math.max(0, meanY + (denominator ? numerator / denominator : 0) * (index - meanX));
  });
  const width = 900, height = 310, left = 56, right = 18, top = 24, bottom = 52;
  const chartWidth = width - left - right, chartHeight = height - top - bottom;
  const highestValue = Math.max(0, ...points.map(point => point.revenue), ...trend);
  const maximum = Math.max(1000, Math.ceil(highestValue / 1000) * 1000);
  const ticks = Array.from({ length: maximum / 1000 + 1 }, (_, index) => index * 1000);
  const x = index => left + chartWidth * (index + 0.5) / points.length;
  const y = value => top + chartHeight * (1 - value / maximum);
  const barWidth = Math.min(48, chartWidth / points.length * 0.58);
  const trendPath = trend.map((value, index) => `${index ? 'L' : 'M'} ${x(index)} ${y(value)}`).join(' ');
  const label = date => new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' }).format(date);
  const axisMoney = value => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);
  const hovered = hoveredIndex === null ? null : points[hoveredIndex];

  return <div style={{background:'#111827',borderRadius:10,padding:'16px 20px',overflowX:'auto',marginBottom:20}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:12,marginBottom:4}}>
      <div style={{fontSize:14,fontWeight:700}}>Monthly revenue</div>
      <div style={{display:'flex',alignItems:'center',gap:12,fontSize:11,color:'#94a3b8',flexWrap:'wrap',justifyContent:'flex-end'}}>
        <span><span style={{display:'inline-block',width:9,height:9,background:'#38bdf8',borderRadius:2,marginRight:4}} />Revenue</span>
        <span><span style={{display:'inline-block',width:16,borderTop:'2px solid #fbbf24',verticalAlign:'middle',marginRight:4}} />Trend</span>
        <label style={{display:'flex',alignItems:'center',gap:5}}>Period
          <select value={range} onChange={event => onRangeChange(event.target.value)} style={{background:'#0f172a',color:'#e2e8f0',border:'1px solid #475569',borderRadius:4,padding:'4px 6px',fontSize:11}}>
            <option value="3months">Last 3 months</option>
            <option value="year">This year</option>
            <option value="12months">Last 12 months</option>
          </select>
        </label>
      </div>
    </div>
    <p style={{fontSize:12,color:'#94a3b8',margin:'0 0 10px'}}>Revenue is allocated to the project completion date.</p>
    <div style={{position:'relative',minWidth:680}}>
    <svg viewBox={`0 0 ${width} ${height}`} style={{display:'block',width:'100%',height:'auto'}} role="img" aria-label="Monthly revenue with trend line">
      {ticks.map(tick => <g key={tick}>
        <line x1={left} x2={width-right} y1={y(tick)} y2={y(tick)} stroke="#334155" strokeWidth="1" />
        <text x={left-8} y={y(tick)+4} fill="#94a3b8" fontSize="11" textAnchor="end">{axisMoney(tick)}</text>
      </g>)}
      {points.map((point, index) => <g key={point.month}>
        <rect x={x(index)-barWidth/2} y={y(point.revenue)} width={barWidth} height={Math.max(0, top + chartHeight - y(point.revenue))} rx="3" fill="#38bdf8">
          <title>{`${label(point.date)}: ${formatMoney(point.revenue)}`}</title>
        </rect>
        <rect x={left + chartWidth * index / points.length} y={top} width={chartWidth / points.length} height={chartHeight}
          fill="transparent" style={{cursor:'crosshair'}}
          onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)}
          onFocus={() => setHoveredIndex(index)} onBlur={() => setHoveredIndex(null)} tabIndex="0"
          aria-label={`${label(point.date)}: revenue ${formatMoney(point.revenue)}, trend ${formatMoney(trend[index])}`} />
        <text x={x(index)} y={height-22} fill="#94a3b8" fontSize="11" textAnchor="middle">{label(point.date)}</text>
      </g>)}
      <path d={trendPath} fill="none" stroke="#fbbf24" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
      {hovered !== null && <line x1={x(hoveredIndex)} x2={x(hoveredIndex)} y1={top} y2={top+chartHeight} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="3 3" pointerEvents="none" />}
    </svg>
    {hovered && <div style={{position:'absolute',left:`${(hoveredIndex + 0.5) / points.length * 100}%`,top:6,transform:'translateX(-50%)',pointerEvents:'none',background:'#020617',border:'1px solid #475569',borderRadius:6,padding:'7px 9px',fontSize:11,whiteSpace:'nowrap',boxShadow:'0 4px 12px rgba(0,0,0,.35)'}}>
      <div style={{fontWeight:700,marginBottom:3}}>{label(hovered.date)}</div>
      <div style={{color:'#7dd3fc'}}>Revenue: {formatMoney(hovered.revenue)}</div>
      <div style={{color:'#fde68a'}}>Trend: {formatMoney(trend[hoveredIndex])}</div>
    </div>}
    </div>
  </div>;
}

export default function Profit() {
  const [financials, setFinancials] = useState(null);
  const [error, setError] = useState('');
  const [revenueRange, setRevenueRange] = useState('12months');
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
    <MonthlyRevenueChart monthlyRevenue={financials.monthly_revenue} range={revenueRange} onRangeChange={setRevenueRange} />
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

