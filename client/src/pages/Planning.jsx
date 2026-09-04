import { useEffect, useMemo, useState } from 'react';

const panel={background:'#1e2433',border:'1px solid #2d3748',borderRadius:8,padding:16};
const colors=['#2563eb','#7c3aed','#0891b2','#c2410c','#4f46e5','#0f766e'];
const fmtDuration=seconds=>{
  const minutes=Math.max(0,Math.ceil(Number(seconds||0)/60));
  const days=Math.floor(minutes/1440),hours=Math.floor((minutes%1440)/60),mins=minutes%60;
  return [days&&`${days}d`,hours&&`${hours}h`,mins&&`${mins}m`].filter(Boolean).join(' ')||'0m';
};
const fmtTime=value=>new Date(value).toLocaleString(undefined,{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});

export default function Planning(){
  const [data,setData]=useState(null),[error,setError]=useState(''),[pxPerHour,setPxPerHour]=useState(90);
  const load=()=>fetch('/api/planning').then(async response=>{
    const body=await response.json();if(!response.ok)throw new Error(body.error||'Could not calculate production plan');return body;
  }).then(body=>{setData(body);setError('')}).catch(e=>setError(e.message));
  useEffect(()=>{load();const timer=setInterval(load,30000);return()=>clearInterval(timer)},[]);
  const chart=useMemo(()=>{
    if(!data)return null;
    const hours=Math.max(1,data.duration_seconds/3600),width=Math.max(900,Math.ceil(hours*pxPerHour));
    const tickHours=hours>168?24:hours>72?12:hours>24?6:hours>8?2:1;
    const ticks=[];for(let h=0;h<=hours+tickHours;h+=tickHours)ticks.push({h,x:h*pxPerHour,time:data.start_at+h*3600000});
    return{width,ticks};
  },[data,pxPerHour]);
  if(error)return <div><h1>Production planning</h1><p style={{color:'#f87171'}}>{error}</p></div>;
  if(!data||!chart)return <p>Calculating production plan…</p>;
  const projectColor=new Map();let colorIndex=0;
  data.lanes.flatMap(l=>l.tasks).forEach(task=>{if(!projectColor.has(task.project_id))projectColor.set(task.project_id,colors[colorIndex++%colors.length])});
  const taskStyle=task=>{
    const start=Math.max(data.start_at,Number(task.start_at));
    const left=(start-data.start_at)/3600000*pxPerHour;
    const width=Math.max(18,(Number(task.end_at)-start)/3600000*pxPerHour);
    return{position:'absolute',left,top:8,height:34,width,background:task.status==='printing'?'#16a34a':task.status==='uploading'?'#d97706':projectColor.get(task.project_id),borderRadius:5,color:'#fff',padding:'3px 7px',overflow:'hidden',whiteSpace:'nowrap',fontSize:11,fontWeight:600,boxSizing:'border-box'};
  };
  return <div>
    <div style={{display:'flex',justifyContent:'space-between',gap:12,alignItems:'start',flexWrap:'wrap'}}><div><h1 style={{marginBottom:4}}>Production planning</h1><p style={{color:'#94a3b8',marginTop:0}}>Forecast based on open quantities, active jobs, G-code durations and currently eligible printers.</p></div><button onClick={load} style={{background:'#2563eb',color:'#fff',border:0,borderRadius:5,padding:'8px 14px',cursor:'pointer'}}>Recalculate</button></div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))',gap:10}}>
      {[['Estimated duration',fmtDuration(data.duration_seconds)],['Expected finish',fmtTime(data.end_at)],['Planned plates',data.planned_plates],['Planned parts',data.planned_parts],['Available printers',`${data.printers_available} / ${data.printers_total}`]].map(([label,value])=><div key={label} style={panel}><div style={{color:'#64748b',fontSize:12}}>{label}</div><div style={{fontSize:21,fontWeight:700,marginTop:4}}>{value}</div></div>)}
    </div>
    <div style={{display:'flex',alignItems:'center',gap:10,margin:'20px 0 8px'}}><label style={{color:'#94a3b8'}}>Zoom <input type="range" min="35" max="180" value={pxPerHour} onChange={e=>setPxPerHour(Number(e.target.value))}/></label><span style={{color:'#64748b',fontSize:12}}>Generated {new Date(data.generated_at).toLocaleTimeString()}</span></div>
    <div style={{...panel,padding:0,overflowX:'auto'}}>
      <div style={{display:'grid',gridTemplateColumns:`170px ${chart.width}px`,minWidth:1070}}>
        <div style={{padding:'10px 12px',color:'#64748b',borderBottom:'1px solid #334155'}}>Printer</div>
        <div style={{position:'relative',height:42,borderBottom:'1px solid #334155'}}>{chart.ticks.map(t=><div key={t.h} style={{position:'absolute',left:t.x,top:0,bottom:0,borderLeft:'1px solid #334155',padding:'6px 0 0 5px',color:'#64748b',fontSize:11,whiteSpace:'nowrap'}}>{fmtTime(t.time)}</div>)}</div>
        {data.lanes.map(lane=><div key={`row-${lane.printer_id}`} style={{display:'contents'}}>
          <div style={{padding:'13px 12px',borderBottom:'1px solid #2d3748'}}><strong>{lane.printer_name}</strong><div style={{color:'#64748b',fontSize:11}}>{lane.model}</div></div>
          <div style={{position:'relative',height:50,borderBottom:'1px solid #2d3748',backgroundImage:`repeating-linear-gradient(to right,transparent 0,transparent ${pxPerHour-1}px,#263143 ${pxPerHour}px)`}}>
            {lane.tasks.map(task=><div key={task.id} style={taskStyle(task)} title={`${task.project_name} / ${task.part_name}\n${task.quantity} parts\n${fmtTime(task.start_at)} – ${fmtTime(task.end_at)}`}>{task.status!=='planned'?'● ':''}{task.project_name} · {task.part_name} · {task.quantity}</div>)}
          </div>
        </div>)}
        {data.lanes.length===0&&<><div style={{padding:12,color:'#64748b'}}>No available printers</div><div/></>}
      </div>
    </div>
    {data.unscheduled.length>0&&<><h2 style={{marginTop:24}}>Not schedulable</h2><div style={{...panel,overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr>{['Project','Part','Quantity','Reason'].map(x=><th key={x} style={{textAlign:'left',padding:8,color:'#64748b'}}>{x}</th>)}</tr></thead><tbody>{data.unscheduled.map((item,index)=><tr key={`${item.part_id}-${index}`} style={{borderTop:'1px solid #2d3748'}}><td style={{padding:8}}>{item.project_name}</td><td>{item.part_name}</td><td>{item.quantity}</td><td style={{color:'#f59e0b'}}>{item.reason}</td></tr>)}</tbody></table></div></>}
  </div>;
}
