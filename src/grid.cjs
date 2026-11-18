// Сетка стола: клетки/гексы, привязка фигур, местность, стены, дальность хода.
// Общий модуль: используется и сервером (привязка, проверка), и клиентом (отрисовка, расчёт хода).
const SQ3 = Math.sqrt(3);
const DEF_GRID = { type: 'square', size: 2, ox: 0, oz: 0, ft: 5, orient: 'pointy', diag: 'simple', show: true, color: '#ffffff', opacity: 0.4 };
const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const SQ_ORTHO = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const SQ_DIAG = [[1, 1], [-1, 1], [-1, -1], [1, -1]];

const clamp = (v, a, b, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };
function normGrid(g) {
  g = g || {};
  return {
    type: ['square', 'hex', 'none'].includes(g.type) ? g.type : DEF_GRID.type,
    size: clamp(g.size, 0.4, 8, DEF_GRID.size),
    ox: clamp(g.ox, -200, 200, 0), oz: clamp(g.oz, -200, 200, 0),
    ft: clamp(Math.round(g.ft), 1, 100, 5),
    orient: g.orient === 'flat' ? 'flat' : 'pointy',
    diag: g.diag === 'alt' ? 'alt' : 'simple',
    show: g.show !== false,
    color: /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : DEF_GRID.color,
    opacity: clamp(g.opacity, 0.05, 1, DEF_GRID.opacity),
  };
}
const key = (a, b) => `${a},${b}`;
const parse = (k) => k.split(',').map(Number);
const cmp = (A, B) => (A[0] - B[0] || A[1] - B[1]);

function make(grid) {
  const g = normGrid(grid), s = g.size, hex = g.type === 'hex', none = g.type === 'none';
  const pointy = g.orient !== 'flat';
  const H = { g, hex, none, s };

  H.center = (a, b) => {
    if (!hex) return [g.ox + (a + 0.5) * s, g.oz + (b + 0.5) * s];
    return pointy ? [g.ox + s * (a + b / 2), g.oz + s * (SQ3 / 2) * b] : [g.ox + s * (SQ3 / 2) * a, g.oz + s * (b + a / 2)];
  };
  H.cellOf = (x, z) => {
    if (!hex) return [Math.floor((x - g.ox) / s), Math.floor((z - g.oz) / s)];
    let q, r;
    if (pointy) { r = (z - g.oz) / (s * SQ3 / 2); q = (x - g.ox) / s - r / 2; } else { q = (x - g.ox) / (s * SQ3 / 2); r = (z - g.oz) / s - q / 2; }
    let cx = q, cz = r, cy = -q - r, rx = Math.round(cx), ry = Math.round(cy), rz = Math.round(cz);
    const dx = Math.abs(rx - cx), dy = Math.abs(ry - cy), dz = Math.abs(rz - cz);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
    return [rx, rz];
  };
  H.neighbors = (a, b) => {
    if (hex) return HEX_DIRS.map(([da, db]) => [a + da, b + db, false]);
    return [...SQ_ORTHO.map(([da, db]) => [a + da, b + db, false]), ...SQ_DIAG.map(([da, db]) => [a + da, b + db, true])];
  };
  // углы клетки в мировых координатах
  H.corners = (a, b) => {
    const [cx, cz] = H.center(a, b);
    if (!hex) { const h = s / 2; return [[cx - h, cz - h], [cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h]]; }
    const R = s / SQ3, st = pointy ? 30 : 0, out = [];
    for (let i = 0; i < 6; i++) { const t = ((st + 60 * i) * Math.PI) / 180; out.push([cx + R * Math.cos(t), cz + R * Math.sin(t)]); }
    return out;
  };
  // привязка точки к клетке. n — размер существа в клетках (чётный — к узлу сетки)
  H.snap = (x, z, n = 1) => {
    if (none) return [x, z];
    if (!hex && n % 2 === 0) return [g.ox + Math.round((x - g.ox) / s) * s, g.oz + Math.round((z - g.oz) / s) * s];
    const [a, b] = H.cellOf(x, z); return H.center(a, b);
  };
  // ребро между двумя соседними клетками (только ортогональные соседи у квадратов)
  H.edgeKey = (A, B) => { const [p, q] = cmp(A, B) <= 0 ? [A, B] : [B, A]; return `${p[0]},${p[1]}|${q[0]},${q[1]}`; };
  H.edgeCells = (k) => k.split('|').map(parse);
  H.edgeGeom = (k) => {
    const [A, B] = H.edgeCells(k), ca = H.center(...A), cb = H.center(...B);
    const mx = (ca[0] + cb[0]) / 2, mz = (ca[1] + cb[1]) / 2, dx = cb[0] - ca[0], dz = cb[1] - ca[1], d = Math.hypot(dx, dz) || 1;
    const len = hex ? s / SQ3 : s, px = -dz / d, pz = dx / d;
    return { x: mx, z: mz, len, ang: Math.atan2(pz, px), a: [mx - (px * len) / 2, mz - (pz * len) / 2], b: [mx + (px * len) / 2, mz + (pz * len) / 2] };
  };
  // ближайшее к точке ребро
  H.edgeAt = (x, z) => {
    if (none) return null;
    const A = H.cellOf(x, z); let best = null;
    for (const [a, b, diag] of H.neighbors(A[0], A[1])) {
      if (diag) continue;
      const k = H.edgeKey(A, [a, b]), e = H.edgeGeom(k);
      const vx = e.b[0] - e.a[0], vz = e.b[1] - e.a[1], t = Math.max(0, Math.min(1, ((x - e.a[0]) * vx + (z - e.a[1]) * vz) / (vx * vx + vz * vz)));
      const d = Math.hypot(x - (e.a[0] + vx * t), z - (e.a[1] + vz * t));
      if (!best || d < best.d) best = { key: k, d };
    }
    return best ? best.key : null;
  };
  H.edgeNear = (x, z) => {
    if (none) return null;
    const A = H.cellOf(x, z); let best = null;
    for (const [a, b, diag] of H.neighbors(A[0], A[1])) {
      if (diag) continue;
      const k = H.edgeKey(A, [a, b]), e = H.edgeGeom(k);
      const vx = e.b[0] - e.a[0], vz = e.b[1] - e.a[1], t = Math.max(0, Math.min(1, ((x - e.a[0]) * vx + (z - e.a[1]) * vz) / (vx * vx + vz * vz)));
      const d = Math.hypot(x - (e.a[0] + vx * t), z - (e.a[1] + vz * t));
      if (!best || d < best.d) best = { key: k, d };
    }
    return best;
  };
  // расстояние между клетками в футах (по правилам сетки, без учёта местности)
  H.dist = (A, B) => {
    if (none) return 0;
    if (hex) { const dq = B[0] - A[0], dr = B[1] - A[1]; return ((Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2) * g.ft; }
    const dx = Math.abs(B[0] - A[0]), dy = Math.abs(B[1] - A[1]), n = Math.max(dx, dy), m = Math.min(dx, dy);
    return (g.diag === 'alt' ? n + Math.floor(m / 2) : n) * g.ft;
  };
  return H;
}

// ---- местность ----
// terrain = { cells: { "a,b": 'd'|'b' }, edges: { "a,b|c,d": 'w'|'h'|'d'|'o' } }
//   клетки:  d — труднопроходимая (×2), b — непроходимая преграда
//   рёбра:   w — стена, h — низкая стена (преодоление +1 клетка движения), d — закрытая дверь, o — открытая дверь
const blocksEdge = (k) => k === 'w' || k === 'd';
const EMPTY_TERRAIN = () => ({ cells: {}, edges: {} });
function normTerrain(t) {
  const out = EMPTY_TERRAIN();
  if (t && t.cells) for (const [k, v] of Object.entries(t.cells)) if (/^-?\d+,-?\d+$/.test(k) && (v === 'd' || v === 'b')) out.cells[k] = v;
  if (t && t.edges) for (const [k, v] of Object.entries(t.edges)) if (/^-?\d+,-?\d+\|-?\d+,-?\d+$/.test(k) && 'whdo'.includes(v) && v.length === 1) out.edges[k] = v;
  return out;
}

class Heap {
  constructor() { this.a = []; }
  push(it) { const a = this.a; a.push(it); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].c <= a[i].c) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l].c < a[m].c) m = l; if (r < a.length && a[r].c < a[m].c) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}

// Можно ли перейти из клетки A в соседнюю B. Возвращает { cost (в клетках), diag } или null.
function stepInfo(H, T, A, B, diag, par) {
  const kb = key(B[0], B[1]), cellB = T.cells[kb];
  if (cellB === 'b') return null;
  let extra = 0;
  const edge = (P, Q) => { const e = T.edges[H.edgeKey(P, Q)]; return e; };
  if (!diag) {
    const e = edge(A, B);
    if (e && blocksEdge(e)) return null;
    if (e === 'h') extra = 1;
  } else {
    // по диагонали нельзя срезать угол: оба «Г-образных» пути должны быть свободны
    for (const M of [[A[0], B[1]], [B[0], A[1]]]) {
      if (T.cells[key(M[0], M[1])] === 'b') return null;
      const e1 = edge(A, M), e2 = edge(M, B);
      if ((e1 && blocksEdge(e1)) || (e2 && blocksEdge(e2))) return null;
    }
  }
  let mult = cellB === 'd' ? 2 : 1;
  let base = 1;
  if (diag && H.g.diag === 'alt') base = par ? 2 : 1;
  return { cost: base * mult + extra, flip: diag && H.g.diag === 'alt' };
}

// Расчёт дальности хода: Дейкстра от клетки start, бюджет в футах. Возвращает Map "a,b" -> { c (футы), p (предыдущая) }
function reach(H, T, start, budgetFt) {
  const ft = H.g.ft, res = new Map(), best = new Map(), heap = new Heap();
  const sk = (A, p) => `${A[0]},${A[1]},${p}`;
  best.set(sk(start, 0), 0); heap.push({ c: 0, A: start, p: 0, from: null });
  while (heap.size) {
    const cur = heap.pop(), ck = key(cur.A[0], cur.A[1]);
    if (cur.c > (best.get(sk(cur.A, cur.p)) ?? Infinity)) continue;
    if (!res.has(ck) || res.get(ck).c > cur.c) res.set(ck, { c: cur.c, p: cur.from });
    for (const [a, b, diag] of H.neighbors(cur.A[0], cur.A[1])) {
      const st = stepInfo(H, T, cur.A, [a, b], diag, cur.p);
      if (!st) continue;
      const nc = cur.c + st.cost * ft; if (nc > budgetFt + 1e-6) continue;
      const np = st.flip ? 1 - cur.p : cur.p, nk = sk([a, b], np);
      if (nc < (best.get(nk) ?? Infinity)) { best.set(nk, nc); heap.push({ c: nc, A: [a, b], p: np, from: ck }); }
    }
  }
  return res;
}
// путь из результата reach до клетки k: список ключей от старта
function pathTo(res, k) {
  const out = []; let cur = k, guard = 0;
  while (cur && guard++ < 5000) { out.push(cur); const r = res.get(cur); cur = r ? r.p : null; }
  return out.reverse();
}

// футы из строки скорости монстра ("walk 40 ft., fly 80 ft.") — берём ходьбу
function parseSpeed(s) {
  const m = /(?:walk\s+)?(\d+)\s*ft/i.exec(String(s || '')); return m ? Number(m[1]) : 30;
}
const SIZE_CELLS = { tiny: 1, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 };

module.exports = { DEF_GRID, normGrid, make, key, parse, normTerrain, EMPTY_TERRAIN, reach, pathTo, stepInfo, parseSpeed, SIZE_CELLS, blocksEdge };
