const GPXParser = require('gpxparser');
const fs = require('fs');
['public/tbtr_28.gpx','public/tbtr_56.gpx'].forEach(f=>{
  try {
    const txt = fs.readFileSync(f,'utf8');
    const g = new GPXParser(); g.parse(txt);
    const pts = g.tracks[0].points.map(p=>({lat:parseFloat(p.lat),lon:parseFloat(p.lon)}));
    console.log(f,'points',pts.length);
    let tot=0;
    const toRad=v=>v*Math.PI/180;
    const hav=(a,b)=>{const R=6371000;const dLat=toRad(b.lat-a.lat);const dLon=toRad(b.lon-a.lon);const lat1=toRad(a.lat);const lat2=toRad(b.lat);const sinDLat=Math.sin(dLat/2);const sinDLon=Math.sin(dLon/2);const c=2*Math.asin(Math.sqrt(sinDLat*sinDLat+Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon));return R*c;};
    for(let i=1;i<pts.length;i++) tot+=hav(pts[i-1],pts[i]);
    console.log('total meters',tot);
  } catch(e) { console.error('error',f,e.message); }
});
