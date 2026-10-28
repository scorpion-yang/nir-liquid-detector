export const escapeHTML = (value = '') => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));

const paths = {
  analysis:'<path d="M4 20V13h3v7M10 20V8h3v12M16 20V3h3v17"/>',
  history:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  model:'<circle cx="12" cy="5" r="3"/><circle cx="5" cy="18" r="3"/><circle cx="19" cy="18" r="3"/><path d="m10.5 7.5-4 8m7-8 4 8M8 18h8"/>',
  settings:'<path d="m10 3-1 3-3 1-3 3 2 3-1 4 3 2 3-1 3 3 3-2 3-1 1-4-2-3 1-3-3-2-3 1Z"/><circle cx="12" cy="12" r="3"/>',
  safety:'<path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z" fill="currentColor" stroke="none"/><path d="m12 6 1.5 3 3.5.5-2.5 2.5.5 3.5-3-1.5L9 15l.5-3L7 9.5l3.5-.5Z" fill="white" stroke="none"/>',
  food:'<path d="M12 7C5 1-1 13 7 21c2 2 3-1 5-1s3 3 5 1C25 13 19 1 12 7Z" fill="currentColor" stroke="none"/><path d="M12 7V3m0 0c2-3 5-2 5-2-1 3-3 3-5 2" stroke="#27a64d"/>',
  pharma:'<path d="M4 20a6 6 0 0 1 0-8l8-8a6 6 0 0 1 8 8l-8 8a6 6 0 0 1-8 0Z"/><path d="m8 8 8 8M4 12l8 8"/>',
  water:'<path d="M12 2S3 12 3 16a9 7 0 0 0 18 0C21 12 12 2 12 2Z" fill="currentColor" stroke="none"/>',
  bluetooth:'<path d="m7 7 10 10-5 5V2l5 5L7 17"/>',
  back:'<path d="m15 5-7 7 7 7"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  more:'<circle cx="12" cy="4" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="20" r="1"/>',
  play:'<path d="m7 3 15 9-15 9Z" fill="currentColor" stroke="none"/>',
  stop:'<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none"/>',
  download:'<path d="M12 2v13m-5-5 5 5 5-5M3 16v5h18v-5"/>',
  reload:'<path d="M20 8a8 8 0 1 0 0 8M20 2v6h-6"/>',
  home:'<path d="m2 11 10-9 10 9M5 9v13h5v-7h4v7h5V9"/>',
  warning:'<path d="m12 3 10 18H2Z"/><path d="M12 8v6m0 3v1"/>',
  check:'<path d="m5 12 5 5 10-11"/>',
  leaf:'<path d="M20 3C8 3 1 9 6 16s14 1 14-13Z"/><path d="M4 22 16 8"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/>',
  link:'<path d="m9 8 3-3a5 5 0 0 1 7 7l-3 3M15 16l-3 3a5 5 0 0 1-7-7l3-3m0 7 8-8"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
};
export function icon(name, className = '') {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
}
export function plot(canvas, points = [], {mini = false} = {}) {
  if (!canvas) return;
  const box = canvas.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(box.width * ratio); canvas.height = Math.round(box.height * ratio);
  const c = canvas.getContext('2d'); c.scale(ratio, ratio);
  const w = box.width, h = box.height;
  const m = mini ? {l:3,r:3,t:5,b:5} : {l:63,r:14,t:16,b:57};
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const maxX = Math.max(1.5, ...points.map(p => p.timeSeconds));
  let minY = 0, maxY = 100;
  if (mini && points.length) {
    minY = Math.min(...points.map(p => p.concentration)) - 2;
    maxY = Math.max(...points.map(p => p.concentration)) + 2;
  }
  if (!mini) {
    c.font = '11px Arial, sans-serif'; c.textBaseline = 'middle';
    for (let i=0;i<=5;i++) {
      const y=m.t+ph*(1-i/5);
      c.strokeStyle='#e2e8ef'; c.beginPath(); c.moveTo(m.l,y); c.lineTo(w-m.r,y); c.stroke();
      c.fillStyle='#66768b'; c.textAlign='right'; c.fillText(String(i*20),m.l-9,y);
      const x=m.l+pw*i/5; c.textAlign=i===0?'left':i===5?'right':'center';
      c.fillText(String(Number((maxX*i/5).toFixed(1))),x,m.t+ph+17);
    }
    c.strokeStyle='#405064'; c.beginPath(); c.moveTo(m.l,m.t); c.lineTo(m.l,m.t+ph); c.lineTo(w-m.r,m.t+ph); c.stroke();
    c.fillStyle='#344255'; c.textAlign='center'; c.font='12px Arial, sans-serif';
    c.fillText('Cumulative time (s)',m.l+pw/2,h-10);
    c.save(); c.translate(14,m.t+ph/2); c.rotate(-Math.PI/2); c.fillText('Predicted concentration (%)',0,0); c.restore();
    if (!points.length) { c.fillStyle='#8a97a7'; c.font='12px Arial, sans-serif'; c.fillText('Waiting for data',m.l+pw/2,m.t+ph/2); }
  }
  if (!points.length) return;
  const xy = p => [m.l+pw*p.timeSeconds/maxX,m.t+ph*(1-(p.concentration-minY)/(maxY-minY))];
  c.strokeStyle='#087dff'; c.lineWidth=mini?1.7:2.1; c.lineJoin='round'; c.beginPath();
  points.forEach((p,i)=>{ const [x,y]=xy(p); if(i)c.lineTo(x,y);else c.moveTo(x,y); }); c.stroke();
  c.fillStyle='#087dff'; for(const p of points){ const [x,y]=xy(p); c.beginPath();c.arc(x,y,mini?1.7:2.6,0,Math.PI*2);c.fill(); }
}
export function download(name, content, type='text/csv;charset=utf-8') {
  const url=URL.createObjectURL(new Blob([content],{type})); const a=document.createElement('a');
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function csvCell(value) { return '"'+String(value??'').replace(/"/g,'""')+'"'; }
