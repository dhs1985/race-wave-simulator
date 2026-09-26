import { useEffect, useLayoutEffect, useState, useRef } from 'react';
import Papa from 'papaparse';
import GPXParser from 'gpxparser';
import * as XLSX from 'xlsx';
import './App.css';


const normalizeHeader = (k) => String(k ?? '').replace(/^\uFEFF/, '').trim().toLowerCase();
const getRowValue = (row, keys) => {
  if (!row) return undefined;
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  const normalizedToKey = {};
  Object.keys(row).forEach((k) => {
    normalizedToKey[normalizeHeader(k)] = k;
  });
  for (const key of keys) {
    const matchedKey = normalizedToKey[normalizeHeader(key)];
    if (!matchedKey) continue;
    const val = row[matchedKey];
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return undefined;
};

// Convert string duration (1:47:05) OR Excel fraction (0.07436) to total seconds
const parseDuration = (val) => {
  if (val === null || val === undefined) return null;

  // Handle Excel fraction of a day (e.g. 0.07436)
  if (typeof val === 'number') {
    return Math.round(val * 86400); // 86400 seconds in a day
  }

  // Handle string formats ("1:47:05" or "47:05")
  const parts = String(val).trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return null;
};

// Convert string start time ("7:00:00 AM") OR Excel fraction (0.29166) to seconds from midnight
const parseStartTimeOfDay = (val) => {
  if (val === null || val === undefined) return null;

  // Handle Excel fraction of a day (e.g. 0.29166)
  if (typeof val === 'number') {
    return Math.round(val * 86400);
  }

  const str = String(val).trim();
  
  // Basic string time parsing (e.g., "7:00:00 AM", "07:00:00")
  const match = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return null;

  let hrs = parseInt(match[1], 10);
  const mins = parseInt(match[2], 10);
  const secs = match[3] ? parseInt(match[3], 10) : 0;
  const ampm = match[4] ? match[4].toUpperCase() : null;

  if (ampm === 'PM' && hrs < 12) hrs += 12;
  if (ampm === 'AM' && hrs === 12) hrs = 0;

  return hrs * 3600 + mins * 60 + secs;
};

const haversine = (a, b) => {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000; // meters
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const c = 2 * Math.asin(Math.sqrt(sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon));
  return R * c;
};

const processGpxTrack = (gpxObj) => {
  if (!gpxObj || !gpxObj.tracks || !gpxObj.tracks[0]) return null;
  const raw = (gpxObj.tracks[0].points || []).map((p) => ({
    lat: parseFloat(p.lat),
    lon: parseFloat(p.lon)
  }));
  if (!raw.length) return null;
  const targetMax = 5000;
  const sample = Math.max(1, Math.ceil(raw.length / targetMax));
  const sampled = raw.filter((_, i) => i % sample === 0);
  if (sampled[sampled.length - 1] !== raw[raw.length - 1]) sampled.push(raw[raw.length - 1]);
  const cum = [0];
  let total = 0;
  for (let i = 1; i < sampled.length; i++) {
    const d = haversine(sampled[i - 1], sampled[i]);
    total += d;
    cum.push(total);
  }
  const lats = sampled.map((p) => p.lat);
  const lons = sampled.map((p) => p.lon);
  const bbox = {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons),
  };
  return { points: sampled, cum, total, bbox };
};


const formatTimeOfDay = (totalSeconds) => {
  if (isNaN(totalSeconds) || totalSeconds < 0) return "00:00:00 AM";
  
  // Keep it within a 24-hour window
  const secInDay = 86400;
  const normalizedSec = totalSeconds % secInDay;
  
  const hrs24 = Math.floor(normalizedSec / 3600);
  const mins = Math.floor((normalizedSec % 3600) / 60);
  const secs = Math.floor(normalizedSec % 60);
  
  const ampm = hrs24 >= 12 ? 'PM' : 'AM';
  let hrs12 = hrs24 % 12;
  hrs12 = hrs12 ? hrs12 : 12; // convert 0 to 12 for 12-hour format
  
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hrs12)}:${pad(mins)}:${pad(secs)} ${ampm}`;
};



const getGlobalBbox = (events) => {
  const tracks = events.map(e => e.track).filter(Boolean);
  if (!tracks.length) return { minLat: -38.5, maxLat: -38.4, minLon: 144.9, maxLon: 145.0 }; // fallback
  return {
    minLat: Math.min(...tracks.map(t => t.bbox.minLat)),
    maxLat: Math.max(...tracks.map(t => t.bbox.maxLat)),
    minLon: Math.min(...tracks.map(t => t.bbox.minLon)),
    maxLon: Math.max(...tracks.map(t => t.bbox.maxLon)),
  };
};

function App() {
  // Dynamic Events Model with 4 Pre-populated Events
  const [events, setEvents] = useState([
      { id: 'ev-1', name: 'Event 1', startTime: '06:00', trackColor: '#555555', runnerColor: '#ff4444', dotRadius: 3, dotOpacity: 0.8, track: null, runners: [] },
      { id: 'ev-2', name: 'Event 2', startTime: '07:00', trackColor: '#446644', runnerColor: '#44ff88', dotRadius: 3, dotOpacity: 0.8, track: null, runners: [] },
      { id: 'ev-3', name: 'Event 3', startTime: '08:00', trackColor: '#445588', runnerColor: '#4488ff', dotRadius: 3, dotOpacity: 0.8, track: null, runners: [] },
      { id: 'ev-4', name: 'Event 4', startTime: '09:00', trackColor: '#886644', runnerColor: '#ffaa44', dotRadius: 3, dotOpacity: 0.8, track: null, runners: [] }
    ]);

  const [simTime, setSimTime] = useState(0);
  const [simRange, setSimRange] = useState([0, 1]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(100); 
  const [canvasStamp, setCanvasStamp] = useState(0);

  const canvasRef = useRef(null);
  const offscreenRef = useRef(null);
  const rafRef = useRef(null);
  const lastTickRef = useRef(0);
  const simTimeRef = useRef(0);

  // Calculate simulation timeline based on all events
  useEffect(() => {
    let minT = Infinity;
    let maxT = -Infinity;

    events.forEach(ev => {
      const start = parseStartTimeOfDay(ev.startTime) || 0;
      if (start < minT) minT = start;
      if (start > maxT) maxT = start; // base track time if no runners
      ev.runners.forEach(r => {
        const finish = start + r.netTime;
        if (finish > maxT) maxT = finish;
      });
    });

    if (minT === Infinity) {
      minT = 21600; // 06:00 AM fallback
      maxT = 25200;
    }

    setSimRange([minT, maxT]);
    if (simTimeRef.current === 0 || simTimeRef.current < minT) {
      setSimTime(minT);
      simTimeRef.current = minT;
    }
  }, [events]);

  const updateEvent = (id, updates) => {
    setEvents(prev => prev.map(ev => ev.id === id ? { ...ev, ...updates } : ev));
  };

  const addEvent = () => {
      const id = `ev-${Date.now()}`;
      setEvents(prev => [...prev, { 
        id, 
        name: `Event ${prev.length + 1}`, 
        startTime: '07:00', 
        trackColor: '#666666', 
        runnerColor: '#ffffff',
        dotRadius: 3,       // <-- Add this
        dotOpacity: 0.8,    // <-- Add this
        track: null, 
        runners: [] 
      }]);
    };

  const removeEvent = (id) => {
    setEvents(prev => prev.filter(ev => ev.id !== id));
  };

  const handleGpxUpload = (eventId, e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    // Grab the file name and remove the ".gpx" extension
    const fileName = file.name.replace(/\.gpx$/i, '');

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const gpx = new GPXParser();
        gpx.parse(event.target.result);
        const processed = processGpxTrack(gpx);
        
        // Update BOTH the track and the name!
        if (processed) {
          updateEvent(eventId, { track: processed, name: fileName });
        }
      } catch (err) {
        console.error("GPX Parse error", err);
      }
    };
    reader.readAsText(file);
  };

  // Unified File Upload Handler (supports CSV and Excel)
  const handleFileUpload = (eventId, e) => {
    const file = e.target.files[0];
    if (!file) return;

    const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');

    if (isExcel) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const data = new Uint8Array(evt.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          
          // Converts sheet directly to JSON objects (matches Papa Parse format)
          const jsonResult = XLSX.utils.sheet_to_json(worksheet);
          processRunnerData(eventId, jsonResult);
        } catch (err) {
          console.error("Excel Parse error", err);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      // Papa Parse logic for CSV files
      Papa.parse(file, {
        header: true,
        dynamicTyping: true,
        complete: (results) => {
          processRunnerData(eventId, results.data);
        }
      });
    }
  };

// Shared runner processing function with debugging
  const processRunnerData = (eventId, rawData) => {
    console.log("Raw imported data:", rawData); // <--- Check your console to see what this outputs!

    const parsedRunners = (rawData || [])
      .map((r, i) => {
        const raceNo = getRowValue(r, ['Race No', 'Raceno', 'No', 'bib']);
        const netTime = parseDuration(getRowValue(r, ['Net Time', 'NetTime', 'time', 'finish', 'net_time']));
        const rawStartTime = getRowValue(r, ['start time', 'starttime', 'start_time', 'wave start']);
        const runnerStartTime = rawStartTime ? parseStartTimeOfDay(rawStartTime) : null;

        if (!netTime) return null;

        const identifier = raceNo !== undefined && raceNo !== null ? String(raceNo) : `${i + 1}`;

        return {
          id: `${eventId}-r-${i}`,
          name: `Runner #${identifier}`,
          raceNo: identifier,
          netTime,
          runnerStartTime,
          raw: r
        };
      })
      .filter(Boolean);
      
    console.log("Parsed runners result:", parsedRunners); // <--- Check what gets parsed
    updateEvent(eventId, { runners: parsedRunners });
  };

  // Canvas drawing helpers
  const latLonToXY = (lat, lon, w, h, globalBbox) => {
    const latPad = (globalBbox.maxLat - globalBbox.minLat) * 0.08 || 0.005;
    const lonPad = (globalBbox.maxLon - globalBbox.minLon) * 0.08 || 0.005;
    const minLat = globalBbox.minLat - latPad;
    const maxLat = globalBbox.maxLat + latPad;
    const minLon = globalBbox.minLon - lonPad;
    const maxLon = globalBbox.maxLon + lonPad;

    const nx = (lon - minLon) / (maxLon - minLon || 1);
    const ny = (maxLat - lat) / (maxLat - minLat || 1);

    const x = (1 - nx) * w;
    const y = (1 - ny) * h;
    return [x, y];
  };

  const getPointAtFraction = (fraction, trackObj) => {
    if (!trackObj) return null;
    const { cum, points, total } = trackObj;
    const target = Math.max(0, Math.min(1, fraction)) * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (cum[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const idx = Math.max(1, lo);
    const d0 = cum[idx - 1], d1 = cum[idx];
    const seg = Math.max(0, Math.min(1, (target - d0) / Math.max(1e-6, d1 - d0)));
    const a = points[idx - 1], b = points[idx];
    return {
      lat: a.lat + (b.lat - a.lat) * seg,
      lon: a.lon + (b.lon - a.lon) * seg
    };
  };

  // Pre-render static paths (uses trackColor)
  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(Math.max(300, rect.height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const off = document.createElement('canvas');
    off.width = w * dpr;
    off.height = h * dpr;
    const offCtx = off.getContext('2d');
    offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    offCtx.fillStyle = '#000';
    offCtx.fillRect(0, 0, w, h);

    const globalBbox = getGlobalBbox(events);

    events.forEach(ev => {
      if (!ev.track) return;
      offCtx.strokeStyle = ev.trackColor; // Using distinct track color
      offCtx.lineWidth = 2;
      offCtx.beginPath();
      ev.track.points.forEach((p, i) => {
        const [x, y] = latLonToXY(p.lat, p.lon, w, h, globalBbox);
        if (i === 0) offCtx.moveTo(x, y);
        else offCtx.lineTo(x, y);
      });
      offCtx.stroke();
    });

    offscreenRef.current = { canvas: off, w, h };
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(off, 0, 0, w, h);
  }, [events, canvasStamp]);

  useEffect(() => { simTimeRef.current = simTime; }, [simTime]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => setCanvasStamp((s) => s + 1));
      ro.observe(canvas);
      return () => ro.disconnect();
    }
    const onWin = () => setCanvasStamp((s) => s + 1);
    window.addEventListener('resize', onWin);
    return () => window.removeEventListener('resize', onWin);
  }, []);

  // Animation Loop (uses runnerColor)
  useEffect(() => {
    if (!canvasRef.current) return;
    let lastDraw = 0;
    const fpsLimit = 30;
    const frameMs = 1000 / fpsLimit;
    const lastUiUpdateRef = { current: 0 };

    const draw = (now) => {
      rafRef.current = requestAnimationFrame(draw);
      if (!lastTickRef.current) lastTickRef.current = now;
      const deltaReal = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;

      if (playing) {
        simTimeRef.current = Math.min(simRange[1], simTimeRef.current + deltaReal * speed);
        if (simTimeRef.current >= simRange[1]) {
          setPlaying(false);
          setSimTime(simRange[1]);
        } else {
          const nowMs = performance.now();
          if (nowMs - lastUiUpdateRef.current > 200) {
            setSimTime(simTimeRef.current);
            lastUiUpdateRef.current = nowMs;
          }
        }
      }

      if (now - lastDraw < frameMs) return;
      lastDraw = now;

      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;

      ctx.clearRect(0, 0, w, h);
      if (offscreenRef.current && offscreenRef.current.canvas) {
        ctx.drawImage(offscreenRef.current.canvas, 0, 0, w, h);
      }

      const time = simTimeRef.current;
      const globalBbox = getGlobalBbox(events);

      // Format the raw seconds into a readable clock string
      const timeString = formatTimeOfDay(time);

      // Draw the clock on your canvas (adjust x, y, and styling to match your canvas setup)
      ctx.fillStyle = '#00ffff';
      ctx.font = '16px "Press Start 2P", monospace';
      ctx.fillText(`TIME: ${timeString}`, 20, 40);

      events.forEach(ev => {
        if (!ev.track || !ev.runners.length) return;
        const waveStart = parseStartTimeOfDay(ev.startTime) || 0;
        
        // Grab custom radius and apply wave opacity
        const radius = ev.dotRadius || 3;
        ctx.save();
        ctx.globalAlpha = ev.dotOpacity !== undefined ? ev.dotOpacity : 0.8;
        ctx.fillStyle = ev.runnerColor;

        ev.runners.forEach(r => {
          const rStart = waveStart; 
          const rFinish = waveStart + r.netTime;
          
          if (time < rStart || time > rFinish) return;
          
          const frac = (time - rStart) / Math.max(1e-6, rFinish - rStart);
          const pt = getPointAtFraction(frac, ev.track);
          if (!pt) return;

          const [x, y] = latLonToXY(pt.lat, pt.lon, w, h, globalBbox);

          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        });
        
        ctx.restore(); // reset opacity for the next wave
      });

    
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [events, playing, speed, simRange]);

  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="retro-bg">

      <div className="retro-panel" style={{ maxWidth: 1700 }}>
        


        {/* Dynamic Events Configuration */}
        <div style={{ marginTop: 24, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {events.map((ev) => (
            <div key={ev.id} style={{ 
              border: `1px solid ${ev.trackColor}`, 
              borderLeftWidth: '6px', 
              borderLeftColor: ev.runnerColor, 
              borderRadius: 8, 
              padding: 12, 
              background: 'rgba(0,0,0,0.4)' 
            }}>
              
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <input 
                  type="text" 
                  value={ev.name} 
                  onChange={(e) => updateEvent(ev.id, { name: e.target.value })}
                  style={{ background: 'transparent', color: '#fff', border: 'none', borderBottom: '1px solid #444', fontSize: '1.1rem', fontWeight: 'bold' }}
                />
                <button onClick={() => removeEvent(ev.id)} style={{ background: 'transparent', color: '#f55', border: 'none', cursor: 'pointer' }}>✕</button>
              </div>
              
              <div style={{ display: 'grid', gap: 8, fontSize: '0.9rem', color: '#ddd' }}>
                <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                  Start Time:
                  <input type="time" value={ev.startTime} onChange={(e) => updateEvent(ev.id, { startTime: e.target.value })} />
                </label>
                
                <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                  Track Colour:
                  <input type="color" value={ev.trackColor} onChange={(e) => updateEvent(ev.id, { trackColor: e.target.value })} />
                </label>

                <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                  Runner Colour:
                  <input type="color" value={ev.runnerColor} onChange={(e) => updateEvent(ev.id, { runnerColor: e.target.value })} />
                </label>
                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  Dot Size:
                  <input
                    type="range" min="1" max="10" step="1"
                    value={ev.dotRadius || 3}
                    onChange={(e) => updateEvent(ev.id, { dotRadius: Number(e.target.value) })}
                    style={{ width: 100 }}
                  />
                </label>

                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  Opacity:
                  <input
                    type="range" min="0.05" max="1.0" step="0.05"
                    value={ev.dotOpacity !== undefined ? ev.dotOpacity : 0.8}
                    onChange={(e) => updateEvent(ev.id, { dotOpacity: parseFloat(e.target.value) })}
                    style={{ width: 100 }}
                  />
                </label>

                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  Course (GPX):
                  <input type="file" accept=".gpx" onChange={(e) => handleGpxUpload(ev.id, e)} style={{ width: 140 }} />
                </label>

                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  Runners (CSV):
                  <input type="file" accept=".csv, .xlsx, .xls" onChange={(e) => handleFileUpload(ev.id, e)} style={{ width: 140 }} />
                </label>
              </div>

              <div style={{ marginTop: 8, fontSize: '0.85rem', color: '#888' }}>
                Status: {ev.track ? 'Track OK' : 'No Track'} | {ev.runners.length} runners
              </div>
            </div>
          ))}
        </div>
        
        <button onClick={addEvent} style={{ marginTop: 16, padding: '8px 16px', background: '#222', color: '#fff', border: '1px solid #444', borderRadius: 4, cursor: 'pointer' }}>
          + Add Event Wave
        </button>
        {/* Main Simulation Controls */}
        <div className="controls-row" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setPlaying(!playing)} className="play-left-search" style={{ padding: '6px 12px' }}>
            {playing ? 'Pause' : 'Play'}
          </button>
          
          <div className="control-pair">
            <label style={{ color: '#fff' }}>Speed</label>
            <select value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))}>
              <option value={1}>1x</option>
              <option value={10}>10x</option>
              <option value={25}>25x</option>
              <option value={50}>50x</option>
              <option value={100}>100x</option>
              <option value={500}>500x</option>
              <option value={1000}>1000x</option>
            </select>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <input
            type="range"
            min={simRange[0]}
            max={simRange[1]}
            step={1}
            value={simTime}
            onChange={(e) => {
              const t = Number(e.target.value);
              setSimTime(t);
              simTimeRef.current = t;
            }}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      <div className="retro-canvas-placeholder" style={{ maxWidth: 1700, marginTop: 20 }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: 'min(48vw, 480px)', maxWidth: '1700px' }} />
      </div>

    </div>
  );
}

export default App;