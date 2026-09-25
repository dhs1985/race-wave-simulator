
import { useEffect, useLayoutEffect, useState, useRef, useMemo } from 'react';
import Papa from 'papaparse';
import GPXParser from 'gpxparser';
import './App.css';

const MIN_DATA_YEAR = 2014;
const MAX_FALLBACK_YEAR = 2026;

const normalizeHeader = (k) => String(k ?? '').replace(/^\uFEFF/, '').trim().toLowerCase();
const normalizeRunnerName = (name) => String(name ?? '').trim().toLowerCase();
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

// Helpers
const parseDuration = (s) => {
  if (!s) return null;
  const parts = String(s).trim().split(':').map((p) => parseInt(p, 10));
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
};

const parseStartTimeOfDay = (s) => {
  if (!s) return null;
  const m = String(s).trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = m[3] ? parseInt(m[3], 10) : 0;
  const ampm = (m[4] || '').toUpperCase();
  if (ampm === 'PM' && hh !== 12) hh += 12;
  if (ampm === 'AM' && hh === 12) hh = 0;
  return hh * 3600 + mm * 60 + ss;
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

function App() {
  const [shortData, setShortData] = useState(null);
  const [longData, setLongData] = useState(null);
  const [availableYears, setAvailableYears] = useState([]);
  const [selectedYear, setSelectedYear] = useState('All');
  const [gpxShortError, setGpxShortError] = useState('');
  const [gpxLongError, setGpxLongError] = useState('');
  const [csvLoading, setCsvLoading] = useState(false);
  const [gpxLoading, setGpxLoading] = useState(false);

  // Visualization state
  const canvasRef = useRef(null);
  const offscreenRef = useRef(null);
  const rafRef = useRef(null);
  const lastTickRef = useRef(0);
  const simTimeRef = useRef(0);

  const [trackShort, setTrackShort] = useState(null); // 28k track
  const [trackLong, setTrackLong] = useState(null); // 56k track
  const track = trackLong || trackShort; // current base track
  const [runners, setRunners] = useState([]); // processed runners
  const [simTime, setSimTime] = useState(0);
  const [simRange, setSimRange] = useState([0, 1]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(100); // default to 100x per request
  const [selectedWaves, setSelectedWaves] = useState([]); // empty = all
  const [filterWave, setFilterWave] = useState('All'); // used for legend color
  const [selectedRunners, setSelectedRunners] = useState([]); // multi-select (highlight)
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGender, setSelectedGender] = useState('All');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [viewMode, setViewMode] = useState('map'); // 'map' or 'elev'
  const [showShort, setShowShort] = useState(true);
  const [showLong, setShowLong] = useState(true);
  const [canvasStamp, setCanvasStamp] = useState(0); // bumps when canvas size changes (forces re-render of offscreen)

  const formatRunnerName = (runner, forceYear = false) => {
    if (!runner) return '';
    const shouldIncludeYear = forceYear || selectedYear === 'All';
    return shouldIncludeYear && runner.year ? `${runner.name} (${runner.year})` : runner.name;
  };

  // Detect available data years from public files.
  useEffect(() => {
    const detectYears = async () => {
      const maxYear = Math.max(MAX_FALLBACK_YEAR, new Date().getFullYear());
      const candidateYears = Array.from({ length: maxYear - MIN_DATA_YEAR + 1 }, (_, i) => MIN_DATA_YEAR + i);

      const checkExists = async (url) => {
        try {
          // Some dev servers or proxies don't support HEAD reliably.
          const res = await fetch(url, { cache: 'no-store' });
          return res.ok;
        } catch {
          return false;
        }
      };

      const checks = await Promise.all(
        candidateYears.map(async (year) => {
          const [shortOk, longOk] = await Promise.all([
            checkExists(`/${year}_28km.csv`),
            checkExists(`/${year}_56km.csv`),
          ]);
          return shortOk || longOk ? year : null;
        })
      );

      const years = checks.filter((y) => Number.isFinite(y)).sort((a, b) => a - b);
      const fallbackYears = Array.from({ length: MAX_FALLBACK_YEAR - MIN_DATA_YEAR + 1 }, (_, i) => MIN_DATA_YEAR + i);
      const finalYears = years.length ? years : fallbackYears;
      setAvailableYears(finalYears);
      setSelectedYear((prev) => {
        if (prev === 'All') return 'All';
        const asNum = Number(prev);
        if (Number.isFinite(asNum) && finalYears.includes(asNum)) return prev;
        return String(finalYears[finalYears.length - 1]);
      });
    };

    detectYears();
  }, []);

  // Load CSVs for selected year(s)
  useEffect(() => {
    if (!availableYears.length) return;
    setCsvLoading(true);

    const loadCsv = (url, year) =>
      fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        })
        .then((txt) =>
          new Promise((resolve) => {
            Papa.parse(txt, {
              header: true,
              dynamicTyping: true,
              worker: true,
              complete: (results) => {
                const rows = (results.data || [])
                  .filter((r) => r && getRowValue(r, ['Name']))
                  .map((r) => ({ ...r, __year: year }));
                resolve(rows);
              },
              error: (err) => resolve({ error: err.message }),
            });
          })
        )
        .catch((e) => ({ error: e.message }));

    const yearsToLoad = selectedYear === 'All' ? availableYears : [Number(selectedYear)];

    Promise.all([
      Promise.all(yearsToLoad.map((y) => loadCsv(`/${y}_28km.csv`, y))),
      Promise.all(yearsToLoad.map((y) => loadCsv(`/${y}_56km.csv`, y))),
    ])
      .then(([shortByYear, longByYear]) => {
        const shortRows = shortByYear.flatMap((res) => (res.error ? [] : res));
        const longRows = longByYear.flatMap((res) => (res.error ? [] : res));
        setShortData(shortRows);
        setLongData(longRows);
      })
      .finally(() => setCsvLoading(false));
  }, [availableYears, selectedYear]);

  // load both GPXs
  // helper to decimate and compute cumulative distances + bbox + elevation
  const processGpxTrack = (gpxObj) => {
    if (!gpxObj || !gpxObj.tracks || !gpxObj.tracks[0]) return null;
    const raw = (gpxObj.tracks[0].points || []).map((p) => ({
      lat: parseFloat(p.lat),
      lon: parseFloat(p.lon),
      ele: parseFloat(p.ele ?? p.elevation ?? 0),
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
    const elevs = sampled.map((p) => Number.isFinite(p.ele) ? p.ele : 0);
    const minElev = Math.min(...elevs);
    const maxElev = Math.max(...elevs);
    return { points: sampled, cum, total, bbox, elevs, minElev, maxElev };
  };

  useEffect(() => {
    setGpxLoading(true);
    const fetchGpx = (url) =>
      fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        })
        .then((txt) => {
          const g = new GPXParser();
          g.parse(txt);
          return g;
        })
        .catch((e) => ({ error: e.message }));

    Promise.all([fetchGpx('/tbtr_28.gpx'), fetchGpx('/tbtr_56.gpx')]).then(([s, l]) => {
      if (!s.error) {
        const processed = processGpxTrack(s);
        if (processed) setTrackShort(processed);
        else setGpxShortError('no points');
      } else setGpxShortError(s.error);

      if (!l.error) {
        const processed = processGpxTrack(l);
        if (processed) setTrackLong(processed);
        else setGpxLongError('no points');
      } else setGpxLongError(l.error);

      // log distances for debugging
      setTimeout(() => {
        if (trackShort) console.log('trackShort total m', trackShort.total, 'points', trackShort.points.length);
        if (trackLong) console.log('trackLong total m', trackLong.total, 'points', trackLong.points.length);
      }, 50);

      setGpxLoading(false);
    });
  }, []);

  // Process runners when CSV loads
  // combine short/long csv entries
  useEffect(() => {
    if (!shortData && !longData) return;
    const list = [];
    const processShort = (rows) => {
      return rows
        .map((r, i) => {
          const year = Number(r.__year) || null;
          const name = getRowValue(r, ['Name']);
          const startVal = getRowValue(r, ['start time', 'start', 'start_time']);
          const parsedStart = parseStartTimeOfDay(startVal);
          const start = parsedStart == null ? 0 : parsedStart;
          const netTime = parseDuration(getRowValue(r, ['Net Time', 'NetTime', 'time']));
          if (!name || !netTime) return null;
          const bib = getRowValue(r, ['Race No', 'RaceNo', 'Bib']);
          const id = `${year || 'na'}-short-${String(bib ?? `${normalizeRunnerName(name)}-${i}`)}`;
          return {
            id,
            name,
            year,
            start,
            finish: start + netTime,
            netTime,
            course: 'short',
            raw: r,
          };
        })
        .filter(Boolean);
    };
    const processLong = (rows) => {
      return rows
        .map((r, i) => {
          const year = Number(r.__year) || null;
          const name = getRowValue(r, ['Name']);
          const startVal = getRowValue(r, ['start time', 'start', 'start_time']);
          const parsedStart = parseStartTimeOfDay(startVal);
          const start = parsedStart == null ? 0 : parsedStart;
          const midNet = parseDuration(getRowValue(r, ['28km', '28 km', 'mid']));
          const finishNet = parseDuration(getRowValue(r, ['56km', '56 km', 'finish', 'Net Time', 'NetTime', 'time']));
          if (!name || finishNet == null) return null;
          const mid = midNet == null ? null : start + midNet;
          const finish = start + finishNet;
          const bib = getRowValue(r, ['Race No', 'RaceNo', 'Bib']);
          const id = `${year || 'na'}-long-${String(bib ?? `${normalizeRunnerName(name)}-${i}`)}`;
          return {
            id,
            name,
            year,
            start,
            midTime: mid,
            finish,
            netTime: finish - start,
            course: 'long',
            raw: r,
          };
        })
        .filter(Boolean);
    };

    if (shortData) list.push(...processShort(shortData));
    if (longData) list.push(...processLong(longData));

    if (!list.length) {
      setRunners([]);
      return;
    }


    const minStart = Math.min(...list.map((p) => p.start));
    const maxFinish = Math.max(...list.map((p) => p.finish));
    setRunners(list);
    setSimRange([minStart, maxFinish]);
    setSimTime(minStart);
  }, [shortData, longData]);

  // Clear transient selections when switching year scopes.
  useEffect(() => {
    setSelectedWaves([]);
    setSelectedRunners([]);
    setSearchQuery('');
  }, [selectedYear]);

  // Process GPX when loaded — hidden backend decimation (cap points at 5000)


  // Centralized strict wave extraction
  const getWaveKey = (r) => {
    // Only use Column1, trim, and always return a string
    let val = r && r.raw && r.raw.Column1;
    if (val === undefined || val === null) return 'Unknown';
    return String(val).trim() || 'Unknown';
  };

  // UI helpers
  const uniqueWaves = useMemo(() => {
    if (!runners || !runners.length) return [];
    const arr = Array.from(new Set(runners.map(getWaveKey))).filter(Boolean);
    // sort numerically when possible
    arr.sort((a,b) => {
      const na = parseFloat(a);
      const nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return arr;
  }, [runners]);

  // elevation track: normally show the 28k course only (higher resolution than long)
  const elevTrack = useMemo(() => {
    return trackShort || trackLong;
  }, [trackShort, trackLong]);

  // map runners by their wave value (fast lookup)
  const runnersByWave = useMemo(() => {
    const map = {};
    for (const r of runners) {
      const w = getWaveKey(r);
      if (!map[w]) map[w] = [];
      map[w].push(r);
    }
    return map;
  }, [runners]);

  // unique categories and genders for filter controls
  const uniqueCategories = useMemo(() => {
    if (!runners || !runners.length) return [];
    return Array.from(new Set(runners.map((r) => {
      const cat = r.raw && ((r.raw['Category'] || r.raw.Category) || r.raw['Category'] || r.raw.Category);
      return cat || 'Unknown';
    }))).filter(Boolean);
  }, [runners]);

  const uniqueGenders = useMemo(() => {
    if (!runners || !runners.length) return ['Male', 'Female'];
    return Array.from(new Set(runners.map((r) => {
      const g = r.raw && ((r.raw['Gender'] || r.raw.gender) || r.raw['Gender'] || r.raw.gender);
      return g || 'Unknown';
    }))).filter(Boolean);
  }, [runners]);

  // assign a base hue to each wave; colour for long-course runners
  const waveHues = useMemo(() => {
    const map = {};
    const n = uniqueWaves.length || 1;
    uniqueWaves.forEach((w, i) => {
      const key = String(w).trim();
      map[key] = Math.round((i * 360) / n);
    });
    return map;
  }, [uniqueWaves]);

  // Assign a unique color to each wave
  const getWaveColor = (waveKey) => {
    const key = String(waveKey).trim();
    const h = waveHues[key] ?? 0;
    return `hsl(${h}, 85%, 55%)`;
  };

  const runnerOptions = useMemo(() => {
    const q = (searchQuery || '').trim().toLowerCase();
    // don't show any suggestions until user types at least 3 characters
    if (q.length < 3) return [];
    return runners
      .filter((r) => r.name && r.name.toLowerCase().includes(q))
      .slice(0, 100)
      .map((r) => <option key={r.id} value={formatRunnerName(r)} />);
  }, [runners, searchQuery, selectedYear]);

  // Canvas drawing helpers
  const latLonToXY = (lat, lon, w, h, bbox) => {
    // add a small padding around bbox so path doesn't touch canvas edges
    const latPad = (bbox.maxLat - bbox.minLat) * 0.06 || 0.0005;
    const lonPad = (bbox.maxLon - bbox.minLon) * 0.06 || 0.0005;
    const minLat = bbox.minLat - latPad;
    const maxLat = bbox.maxLat + latPad;
    const minLon = bbox.minLon - lonPad;
    const maxLon = bbox.maxLon + lonPad;

    const nx = (lon - minLon) / (maxLon - minLon || 1);
    const ny = (maxLat - lat) / (maxLat - minLat || 1);

    // rotate 180deg by flipping both axes (so north/south + east/west invert)
    const x = (1 - nx) * w;
    const y = (1 - ny) * h;
    return [x, y];
  };

  const getPointAtFraction = (fraction, trackObj) => {
    if (!trackObj) return null;
    const { cum, points, total } = trackObj;
    const target = Math.max(0, Math.min(1, fraction)) * total;
    // binary search in cum
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (cum[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const idx = Math.max(1, lo);
    const d0 = cum[idx - 1];
    const d1 = cum[idx];
    const seg = Math.max(0, Math.min(1, (target - d0) / Math.max(1e-6, d1 - d0)));
    const a = points[idx - 1];
    const b = points[idx];
    const lat = a.lat + (b.lat - a.lat) * seg;
    const lon = a.lon + (b.lon - a.lon) * seg;
    return { lat, lon };
  };

  const getElevationAtFraction = (fraction, trackObj) => {
    if (!trackObj) return null;
    const { cum, elevs, total } = trackObj;
    const target = Math.max(0, Math.min(1, fraction)) * total;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (cum[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const idx = Math.max(1, lo);
    const d0 = cum[idx - 1];
    const d1 = cum[idx];
    const seg = Math.max(0, Math.min(1, (target - d0) / Math.max(1e-6, d1 - d0)));
    const e0 = elevs[idx - 1] ?? 0;
    const e1 = elevs[idx] ?? 0;
    return e0 + (e1 - e0) * seg;
  };

  // Draw: path (offscreen) + runners (live)
  useEffect(() => {
    if (!track || !canvasRef.current) return;
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

    // prepare offscreen (static path or elevation profile depending on viewMode)
    const off = document.createElement('canvas');
    off.width = w * dpr;
    off.height = h * dpr;
    off.style.width = w + 'px';
    off.style.height = h + 'px';
    const offCtx = off.getContext('2d');
    offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    offCtx.fillStyle = '#000';
    offCtx.fillRect(0, 0, w, h);

    if (viewMode === 'map') {
      // draw short track first (dashed) if available
      if (trackShort && trackShort.points) {
        offCtx.strokeStyle = '#888';
        offCtx.lineWidth = 1.5;
        offCtx.setLineDash([6, 4]);
        offCtx.beginPath();
        trackShort.points.forEach((p, i) => {
          const [x, y] = latLonToXY(p.lat, p.lon, w, h, track.bbox);
          if (i === 0) offCtx.moveTo(x, y);
          else offCtx.lineTo(x, y);
        });
        offCtx.stroke();
        offCtx.setLineDash([]);
      }
      // draw main (long) map path
      offCtx.strokeStyle = '#fff';
      offCtx.lineWidth = 2;
      offCtx.beginPath();
      track.points.forEach((p, i) => {
        const [x, y] = latLonToXY(p.lat, p.lon, w, h, track.bbox);
        if (i === 0) offCtx.moveTo(x, y);
        else offCtx.lineTo(x, y);
      });
      offCtx.stroke();
    } else {
      // elevation profile uses elevTrack
      const source = elevTrack || track;
      const { cum, elevs, minElev, maxElev, total } = source;
      const pad = 20;
      const plotW = Math.max(10, w - pad * 2);
      const plotH = Math.max(10, h - pad * 2);
      // background grid
      offCtx.strokeStyle = '#111';
      offCtx.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const gy = pad + (i / 3) * plotH;
        offCtx.beginPath();
        offCtx.moveTo(pad, gy);
        offCtx.lineTo(pad + plotW, gy);
        offCtx.stroke();
      }
      // profile
      offCtx.beginPath();
      elevs.forEach((e, i) => {
        const x = pad + (cum[i] / total) * plotW;
        const ny = (e - minElev) / Math.max(1e-6, maxElev - minElev);
        const y = pad + (1 - ny) * plotH;
        if (i === 0) offCtx.moveTo(x, y);
        else offCtx.lineTo(x, y);
      });
      offCtx.strokeStyle = '#fff';
      offCtx.lineWidth = 2;
      offCtx.stroke();
      // fill under curve
      offCtx.lineTo(pad + plotW, pad + plotH);
      offCtx.lineTo(pad, pad + plotH);
      offCtx.closePath();
      offCtx.fillStyle = '#021';
      offCtx.fill();

      // axis labels
      offCtx.fillStyle = '#888';
      offCtx.font = '10px monospace';
      offCtx.fillText(`${Math.round(maxElev)} m`, 6, pad + 8);
      offCtx.fillText(`${Math.round(minElev)} m`, 6, pad + plotH);
    }

    offscreenRef.current = { canvas: off, w, h };

    // draw initial frame
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(off, 0, 0, w, h);
  }, [trackShort, trackLong, viewMode, canvasStamp]);

  // keep simTimeRef up to date when state changes (user seek / other interactions)
  useEffect(() => {
    simTimeRef.current = simTime;
  }, [simTime]);

  // bump when canvas size/layout changes so offscreen is re-created at new dimensions
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
  }, [canvasRef.current]);

  // interactive transform refs for zoom/pan
  const scaleRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const pointersRef = useRef(new Map());
  const lastPinchDistRef = useRef(null);

  // Animation loop (drawing uses simTimeRef to avoid rerendering every frame)
  useEffect(() => {
    if (!track || !canvasRef.current) return;
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

      // draw background
      ctx.clearRect(0, 0, w, h);
      if (offscreenRef.current && offscreenRef.current.canvas) {
        ctx.save();
        ctx.translate(panRef.current.x, panRef.current.y);
        ctx.scale(scaleRef.current, scaleRef.current);
        ctx.drawImage(offscreenRef.current.canvas, 0, 0, w, h);
      }

      // draw runners/time according to viewMode
      const time = simTimeRef.current;
      const invScale = 1 / Math.max(1e-6, scaleRef.current);

      for (let i = 0; i < runners.length; i++) {
        const r = runners[i];
        const runnerWave = getWaveKey(r);
        const runnerGender = (r.raw && (r.raw['Gender'] || r.raw['gender'])) || 'Unknown';
        const runnerCategory = (r.raw && (r.raw['Category'] || r.raw['category'])) || 'Unknown';

        const passesWave = selectedWaves.length === 0 || selectedWaves.map((w) => String(w).trim()).includes(runnerWave);
        const passesGender = selectedGender === 'All' || runnerGender === selectedGender;
        const passesCategory = selectedCategory === 'All' || runnerCategory === selectedCategory;
        const isSelected = selectedRunners.some((s) => s.id === r.id);
        // filter by course visibility
        if (r.course === 'short' && !showShort) continue;
        if (r.course === 'long' && !showLong) continue;
        const showRunner = isSelected || (passesWave && passesGender && passesCategory);
        if (!showRunner) continue;

        if (time < r.start || time > r.finish) continue;
        let frac;
        if (r.midTime) {
          // two-phase long-course runner for **map**: 0.5 at midTime, 1 at finish
          if (time <= r.midTime) {
            frac = ((time - r.start) / Math.max(1e-6, r.midTime - r.start)) * 0.5;
          } else {
            frac = 0.5 + ((time - r.midTime) / Math.max(1e-6, r.finish - r.midTime)) * 0.5;
          }
        } else if (r.courseFrac && r.courseFrac < 1) {
          frac = ((time - r.start) / Math.max(1e-6, r.finish - r.start)) * r.courseFrac;
        } else {
          frac = (time - r.start) / Math.max(1e-6, r.finish - r.start);
        }
        // compute elevation-specific fraction so that long-course runners
        // traverse the 28k profile backwards then forwards around their
        // 28k split point
        let fracElev = frac;
        if (viewMode === 'elev' && r.course === 'long' && r.midTime) {
          if (time <= r.midTime) {
            const phase = (time - r.start) / Math.max(1e-6, r.midTime - r.start);
            fracElev = 1 - phase; // right->left
          } else {
            const phase = (time - r.midTime) / Math.max(1e-6, r.finish - r.midTime);
            fracElev = phase; // left->right
          }
        }

        if (viewMode === 'map') {
          // choose appropriate track for this runner
          const baseTrack = r.course === 'short' ? trackShort : trackLong;
          const pt = getPointAtFraction(frac, baseTrack);
          if (!pt) continue;
          const [x, y] = latLonToXY(pt.lat, pt.lon, w, h, baseTrack.bbox);
          const waveKey = getWaveKey(r);
          const color = getWaveColor(waveKey);
          const screenRadius = (isSelected ? 5 : 2) * 1.5;
          const worldRadius = screenRadius * invScale;
          ctx.beginPath();
          ctx.fillStyle = color;
          ctx.arc(x, y, worldRadius, 0, Math.PI * 2);
          ctx.fill();
          if (isSelected) {
            ctx.lineWidth = 2 * invScale;
            ctx.strokeStyle = '#fff';
            ctx.stroke();
            ctx.font = `${10 * invScale}px monospace`;
            const label = formatRunnerName(r);
            const metrics = ctx.measureText(label);
            const pad = 4 * invScale;
            const lx = x + 8 * invScale;
            const ly = y - 8 * invScale;
            ctx.fillStyle = '#000b';
            ctx.fillRect(lx - pad, ly - 10 * invScale, metrics.width + pad * 2, 14 * invScale);
            ctx.fillStyle = '#fff';
            ctx.fillText(label, lx, ly + 2 * invScale);
          }
        } else {
          // elevation view: use high-resolution precomputed track if available
          const source = elevTrack || track;
          const e = getElevationAtFraction(fracElev, source);
          if (e == null) continue;
          const pad = 20;
          const plotW = Math.max(10, w - pad * 2);
          const plotH = Math.max(10, h - pad * 2);
          const x = pad + (fracElev * plotW);
          const ny = (e - source.minElev) / Math.max(1e-6, source.maxElev - source.minElev);
          const y = pad + (1 - ny) * plotH;
          const waveKey = getWaveKey(r);
          const color = getWaveColor(waveKey);
          const screenRadius = (isSelected ? 5 : 2) * 1.5;
          ctx.beginPath();
          ctx.fillStyle = color;
          ctx.arc(x, y, screenRadius * invScale, 0, Math.PI * 2);
          ctx.fill();
          if (isSelected) {
            ctx.lineWidth = 2 * invScale;
            ctx.strokeStyle = '#fff';
            ctx.stroke();
            ctx.font = `${10 * invScale}px monospace`;
            ctx.fillStyle = '#fff';
            ctx.fillText(formatRunnerName(r), x + 8 * invScale, y + 2 * invScale);
          }
        }
      }

      if (offscreenRef.current && offscreenRef.current.canvas) ctx.restore();

      // time label (screen space)
      ctx.fillStyle = '#0ff';
      ctx.font = '32px "Press Start 2P", monospace';
      // Adjust time so race starts at 0:00
      const raceStart = simRange[0];
      const relTime = time - raceStart;
      const mm = Math.floor(relTime / 60) % 60;
      const hh = Math.floor(relTime / 3600);
      const timeLabel = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      ctx.fillText(timeLabel, 10, 40);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [trackShort, trackLong, runners, playing, speed, selectedRunners, simRange, filterWave, selectedGender, selectedCategory, viewMode]);



  // ensure page loads scrolled to top (important for small phones)
  useLayoutEffect(() => {
    // ensure we start at top after first paint; mobile browsers often
    // restore previous scroll or leave the address bar area hidden.
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
    const scrollTop = () => {
      window.scrollTo(0, 0);
      document.body.scrollTop = 0;
      document.documentElement.scrollTop = 0;
      const bg = document.querySelector('.retro-bg');
      if (bg) bg.scrollTop = 0;
    };
    scrollTop();
    // repeat shortly after mount in case initial paint shifts layout
    const t = setTimeout(scrollTop, 150);
    window.addEventListener('orientationchange', scrollTop);
    return () => {
      clearTimeout(t);
      window.removeEventListener('orientationchange', scrollTop);
    };
  }, []);

  // control handlers
  const togglePlay = () => setPlaying((p) => !p);
  const onSpeedChange = (ev) => setSpeed(parseFloat(ev.target.value));
  const onSeek = (ev) => {
    const t = Number(ev.target.value);
    setSimTime(t);
    simTimeRef.current = t;
  };
  const onWaveSelect = (ev) => {
    const v = ev.target.value;
    if (!v) {
      setSelectedWaves([]);
      setFilterWave('All');
    } else {
      setSelectedWaves((prev) => prev.includes(v) ? prev : [...prev, v]);
      setFilterWave(v);
    }
    setSelectedRunners([]);
    // clear dropdown back to placeholder
    ev.target.value = '';
  };

  const addSelectedRunner = (r) => {
    if (!r) return;
    setSelectedRunners((prev) => {
      if (selectedYear !== 'All') {
        return prev.some((p) => p.id === r.id) ? prev : [...prev, r];
      }

      const targetName = normalizeRunnerName(r.name);
      const matching = runners.filter((x) => normalizeRunnerName(x.name) === targetName);
      if (!matching.length) return prev;

      const existing = new Set(prev.map((x) => x.id));
      const toAdd = matching.filter((x) => !existing.has(x.id));
      if (!toAdd.length) return prev;
      return [...prev, ...toAdd];
    });
  };

  const removeSelectedRunner = (runnerToRemove) => {
    if (!runnerToRemove) return;
    if (selectedYear !== 'All') {
      setSelectedRunners((prev) => prev.filter((p) => p.id !== runnerToRemove.id));
      return;
    }
    const targetName = normalizeRunnerName(runnerToRemove.name);
    setSelectedRunners((prev) => prev.filter((p) => normalizeRunnerName(p.name) !== targetName));
  };

  const onRunnerInput = (ev) => {
    const v = ev.target.value;
    setSearchQuery(v);
    // if exact match chosen from datalist, add immediately
    const match = runners.find((r) => formatRunnerName(r) === v || r.name === v);
    if (match) {
      addSelectedRunner(match);
      setSearchQuery('');
      ev.target.value = '';
    }
  };

  return (
    <div className="retro-bg">
      <h1 className="retro-title">
        Two Bays {selectedYear === 'All' ? 'All Years' : selectedYear}
      </h1>

      <div className="retro-panel" style={{ maxWidth: 920 }}>


        <div className="controls-row" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center', marginTop: 8, flexWrap: 'wrap' }}>

          <div className="control-pair">
            <label style={{ color: '#fff' }}>Year</label>
            <select value={selectedYear} onChange={(e) => setSelectedYear(e.target.value)}>
              <option value="All">All</option>
              {availableYears.map((y) => (
                <option key={y} value={String(y)}>{y}</option>
              ))}
            </select>
          </div>

          <div className="control-pair">
            <label style={{ color: '#fff' }}>Speed</label>
            <select value={speed} onChange={onSpeedChange}>
              <option value={1}>1x</option>
              <option value={10}>10x</option>
              <option value={50}>50x</option>
              <option value={100}>100x</option>
              <option value={250}>250x</option>
              <option value={500}>500x</option>
              <option value={1000}>1000x</option>
            </select>
          </div>

          <div className="control-pair">
            <label style={{ color: '#fff' }}>Wave</label>
            <select defaultValue="" onChange={onWaveSelect} style={{ minWidth: 120 }}>
              <option value="">All</option>
              {uniqueWaves.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </div>

          <div className="control-pair">
            <label style={{ color: '#fff' }}>Gender</label>
            <select value={selectedGender} onChange={(e) => setSelectedGender(e.target.value)}>
              <option value="All">All</option>
              {uniqueGenders.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>

          <div className="control-pair">
            <label style={{ color: '#fff' }}>Category</label>
            <select value={selectedCategory} onChange={(e) => setSelectedCategory(e.target.value)}>
              <option value="All">All</option>
              {uniqueCategories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="control-pair">
            <label style={{ color: '#fff' }}>View</label>
            <select value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
              <option value="map">Map</option>
              <option value="elev">Elevation</option>
            </select>
          </div>

          <div className="control-pair" style={{ gap: 4, fontSize: '0.85rem', minWidth: 'auto' }}>
            <input type="checkbox" id="showShort" checked={showShort} onChange={(e) => setShowShort(e.target.checked)} />
            <label htmlFor="showShort" style={{ color: '#fff' }}>28k</label>
          </div>
          <div className="control-pair" style={{ gap: 4, fontSize: '0.85rem', minWidth: 'auto' }}>
            <input type="checkbox" id="showLong" checked={showLong} onChange={(e) => setShowLong(e.target.checked)} />
            <label htmlFor="showLong" style={{ color: '#fff' }}>56k</label>
          </div>

          <button onClick={togglePlay} className="play-left-search" style={{ padding: '6px 10px', marginRight: 8 }}>{playing ? 'Pause' : 'Play'}</button>
          <div style={{ position: 'relative' }}>
            <input
              placeholder="Search runner"
              list="runners-list"
              onInput={onRunnerInput}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchQuery.trim()) {
                  const found = runners.find((r) => r.name.toLowerCase().includes(searchQuery.toLowerCase()));
                  if (found) {
                    addSelectedRunner(found);
                    setSearchQuery('');
                    e.target.value = '';
                    e.preventDefault();
                  }
                }
              }}
              style={{ padding: '6px', width: 220 }}
            />
            <datalist id="runners-list">
              {runnerOptions}
            </datalist>
          </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: 360, alignItems: 'center' }}>
              {selectedWaves.length > 0 ? (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#111', padding: '6px 8px', borderRadius: 8, border: '1px solid #444' }}>
                  <div style={{ width: 12, height: 12, borderRadius: 3, background: getWaveColor(filterWave) || '#888', border: '1px solid #000' }} />
                  <div style={{ color: '#fff', fontSize: 12 }}>
                    {selectedWaves.join(', ')} <span style={{ color: '#888' }}>
                      ({selectedWaves.reduce((sum,w) => sum + ((runnersByWave[w]||[]).length),0)})
                    </span>
                  </div>
                  <button onClick={() => { setFilterWave('All'); setSelectedWaves([]); }} style={{ marginLeft: 8, border: 'none', background: 'transparent', color: '#f55', cursor: 'pointer' }}>Clear</button>
                </div>
              ) : (
                selectedRunners.map((r) => (
                  <div key={r.id} className="runner-tag">
                    <span>{formatRunnerName(r)}</span>
                    <button onClick={() => removeSelectedRunner(r)}>✕</button>
                  </div>
                ))
              )}
            </div>
          </div>

        <div style={{ marginTop: 12 }}>
          <input
            type="range"
            min={simRange[0]}
            max={simRange[1]}
            step={1}
            value={simTime}
            onChange={onSeek}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      <div className="retro-canvas-placeholder" style={{ maxWidth: 940 }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: 'min(48vw, 480px)', maxWidth: '900px' }} />
      </div>


    </div>
  );
}

export default App;

