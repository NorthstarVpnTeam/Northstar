/**
 * Compact activity chart drawn on a canvas from real throughput samples.
 * No data => explicit "no samples" state (never a decorative graph).
 */

import { el, clear, fmtRate } from '../ui.js';

export function createChart() {
  const wrap = el('div', { class: 'chart-wrap' });
  const canvas = document.createElement('canvas');
  const empty = el('div', { class: 'chart-empty', text: 'No throughput samples yet' });
  wrap.appendChild(canvas);
  wrap.appendChild(empty);

  const legend = el('div', { class: 'chart-legend' }, [
    el('span', { class: 'key' }, [
      el('span', { class: 'swatch', style: { background: '#0071e3' } }),
      'Download',
    ]),
    el('span', { class: 'key' }, [
      el('span', { class: 'swatch', style: { background: '#1f9d55' } }),
      'Upload',
    ]),
    el('span', { class: 'key', id: 'chart-rate', text: '' }),
  ]);

  const root = el('div', {}, [wrap, legend]);

  function draw(samples) {
    const list = Array.isArray(samples) ? samples : [];
    const hasData = list.some((s) => Number.isFinite(s.down) || Number.isFinite(s.up));
    empty.style.display = hasData ? 'none' : 'flex';

    const dpr = window.devicePixelRatio || 1;
    const width = wrap.clientWidth || 600;
    const height = wrap.clientHeight || 150;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const rateNode = legend.querySelector('#chart-rate');
    if (!hasData) {
      if (rateNode) rateNode.textContent = '';
      return;
    }

    const points = list.slice(-60);
    let max = 1;
    for (const p of points) {
      if (Number.isFinite(p.down)) max = Math.max(max, p.down);
      if (Number.isFinite(p.up)) max = Math.max(max, p.up);
    }

    const padTop = 10;
    const padBottom = 16;
    const plotH = height - padTop - padBottom;
    const stepX = points.length > 1 ? (width - 8) / (points.length - 1) : 0;
    const x = (i) => 4 + i * stepX;
    const y = (v) => padTop + plotH - (Math.max(0, v) / max) * plotH;

    // Grid lines (subtle).
    ctx.strokeStyle = 'rgba(128,128,136,0.16)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i += 1) {
      const gy = padTop + (plotH / 3) * i;
      ctx.beginPath();
      ctx.moveTo(4, gy);
      ctx.lineTo(width - 4, gy);
      ctx.stroke();
    }

    const drawSeries = (key, color, fill) => {
      ctx.beginPath();
      let started = false;
      points.forEach((p, i) => {
        const v = p[key];
        if (!Number.isFinite(v)) return;
        const px = x(i);
        const py = y(v);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else ctx.lineTo(px, py);
      });
      if (!started) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();

      if (fill) {
        ctx.lineTo(x(points.length - 1), padTop + plotH);
        ctx.lineTo(x(0), padTop + plotH);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
      }
    };

    drawSeries('down', '#0071e3', 'rgba(0,113,227,0.10)');
    drawSeries('up', '#1f9d55', null);

    const last = points[points.length - 1];
    if (rateNode) {
      const down = fmtRate(last && Number.isFinite(last.down) ? last.down : null);
      const up = fmtRate(last && Number.isFinite(last.up) ? last.up : null);
      rateNode.textContent = `now ↓ ${down ? `${down.value} ${down.unit}` : '—'} · ↑ ${
        up ? `${up.value} ${up.unit}` : '—'
      }`;
    }
  }

  return { root, draw };
}