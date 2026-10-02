// End card: the artist and the song's title, drawn from outlines that tools/endcard_type.py bakes into
// lib/endtype.js (window.ENDTYPE) from any font file, so no font loads at render time. The artist's line on top,
// the title under it at 0.85 of its size.
(function (global) {
  const L = global.LOOK;
  function line(ctx, ln, cx, base, px) {
    ctx.save();
    ctx.translate(cx - (ln.ink * px) / 2, base);
    ctx.scale(px, -px);
    ctx.beginPath();
    for (const c of ln.contours) {
      ctx.moveTo(c[0][0], c[0][1]);
      for (let i = 1; i < c.length; i++) ctx.lineTo(c[i][0], c[i][1]);
      ctx.closePath();
    }
    ctx.fill("evenodd");
    ctx.restore();
  }
  // o: { t0 (when it starts to come up), fade (s), cx, y (the artist line's baseline, px), width (the artist line's
  //      ink width, px), color: [r, g, b] }
  function draw(ctx, t, env, o) {
    const T = global.ENDTYPE;
    if (!T || t < o.t0) return;
    const a = L.ease.sineIO(L.clamp01((t - o.t0) / (o.fade || 2)));
    const px = o.width / T.artist.ink;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = L.css(o.color || [150, 156, 166], a);
    line(ctx, T.artist, o.cx, o.y, px);
    line(ctx, T.title, o.cx, o.y + 2.1 * px, 0.85 * px);
    ctx.restore();
  }
  global.ENDCARD = { draw };
})(window);
