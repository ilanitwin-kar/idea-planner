param(
  [int]$Port = 5173
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "Idea Planner: http://localhost:$Port"
Write-Host "החלון הזה צריך להישאר פתוח. לעצירה: Ctrl+C"
Write-Host ""

function Test-PortFree([int]$p) {
  try {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    return -not $c
  } catch {
    return $true
  }
}

if (-not (Test-PortFree $Port)) {
  $msg = "הפורט {0} כבר תפוס. נסי פורט אחר, למשל:" -f $Port
  Write-Host $msg -ForegroundColor Yellow
  Write-Host "  .\serve.ps1 -Port 5174" -ForegroundColor Yellow
  exit 1
}

function Has-Cmd($name) {
  return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

# Prefer Python launcher (py) on Windows; then python; fallback to Node static server.
if (Has-Cmd "py") {
  Write-Host "מריץ שרת עם Python (py)..." -ForegroundColor Green
  py -m http.server $Port
  exit $LASTEXITCODE
}

if (Has-Cmd "python") {
  Write-Host "מריץ שרת עם Python (python)..." -ForegroundColor Green
  python -m http.server $Port
  exit $LASTEXITCODE
}

if (Has-Cmd "node") {
  Write-Host "לא נמצא Python. מריץ שרת עם Node..." -ForegroundColor Green
  node -e @"
const http=require('http');
const fs=require('fs');
const path=require('path');
const port=$Port;
const mime={
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg',
  '.svg':'image/svg+xml; charset=utf-8'
};
function safeJoin(base, target){
  const p=path.normalize(path.join(base, target));
  if(!p.startsWith(base)) return null;
  return p;
}
http.createServer((req,res)=>{
  const url=(req.url||'/').split('?')[0];
  const rel=url==='/'?'/index.html':url;
  const file=safeJoin(process.cwd(), '.'+rel);
  if(!file){ res.statusCode=400; return res.end('bad request'); }
  fs.readFile(file,(err,data)=>{
    if(err){ res.statusCode=404; return res.end('not found'); }
    const ext=path.extname(file).toLowerCase();
    res.setHeader('Content-Type', mime[ext]||'application/octet-stream');
    res.end(data);
  });
}).listen(port, ()=>console.log('Serving on http://localhost:'+port));
"@
  exit $LASTEXITCODE
}

Write-Host "לא מצאתי Python וגם לא Node, ולכן אי אפשר להרים שרת מקומי." -ForegroundColor Red
Write-Host "אם תרצי, אוכל להדריך התקנה קצרה של Python (מומלץ) או Node." -ForegroundColor Red
exit 1

