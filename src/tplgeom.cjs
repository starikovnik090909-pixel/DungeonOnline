// Попадание фишки в шаблон заклинания (общий код для сервера и клиента)
const cell = (g) => (g.type === 'hex' ? g.size * Math.sqrt(3) : g.size);
const unit = (g) => cell(g) / (g.ft || 5); // мир. единиц на фут
function inside(t, tok, g) {
  const u = unit(g), R = t.ft * u, n = tok.kind === 'chip' ? Math.max(1, tok.size || 1) : 1, r = (n * cell(g)) / 2 * 0.7;
  const dx = tok.x - t.x, dz = tok.z - t.z, c = Math.cos(t.rot || 0), s = Math.sin(t.rot || 0);
  const lx = dx * c + dz * s, lz = -dx * s + dz * c;
  if (t.shape === 'sphere') return Math.hypot(dx, dz) <= R + r;
  if (lx < -r || lx > R + r) return false;
  const half = t.shape === 'cone' ? Math.max(0, lx) / 2 : t.shape === 'line' ? 2.5 * u : R / 2;
  return Math.abs(lz) <= half + r;
}
const hits = (t, tokens, g) => Object.values(tokens || {}).filter((k) => inside(t, k, g));
module.exports = { inside, hits, unit, cell };
