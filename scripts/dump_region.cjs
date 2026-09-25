const fs = require('fs');
const s = fs.readFileSync('src/App.jsx', 'utf8');
const lines = s.split(/\r?\n/);
for (let i = 580; i <= 600; i++) {
  const ln = lines[i-1] || '';
  console.log(i + ': ' + ln);
  console.log('  chars:', ln.split('').map(c => c.charCodeAt(0)).join(' '));
}
