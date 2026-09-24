// Gramps: a pixel turtle in a flat cap and reading glasses who put everything
// in the index in 1993 and has been fishing ever since. One grid, reused by the
// share card and the standalone mascot file.

const PALETTE = {
  K: '#14120f', // outline
  G: '#2f6b45', // shell
  g: '#3f8a58', // shell plates
  h: '#c6f432', // shell highlight (the one lime thing Gramps owns)
  S: '#8fc46a', // skin
  s: '#6a9c4d', // skin shadow
  C: '#7a4e2d', // cap
  c: '#553520', // cap shadow
  W: '#f4f1e8', // lens glare / eye white
  L: '#b9d7ff', // lens
};

// 30 x 22. '.' is transparent.
export const GRAMPS = [
  '..............................',
  '....................cccccc....',
  '...................cCCCCCCc...',
  '..................cCCCCCCCCcc.',
  '........KKKKKKK...KKKKKKKKKKKK',
  '......KKgggggggKK.KSSSSSSSSK..',
  '.....KgGGGgGGGgGGKKSSKKSSKKSSK',
  '....KgGGGGgGGGgGGGKSKssKKssKSK',
  '...KgGGhGGgGGGgGGGKSKLWKKLWKSK',
  '...KggggggggggggggKSSKKSSKKSSK',
  '..KGGGGgGGGGGgGGGGKSSSSSSSSSSK',
  '..KGGhGgGGGGGgGGGGKSSSSSSKKKSK',
  '..KgggggggggggggggKsSSSSKSSSK.',
  '..KKKKKKKKKKKKKKKKKKsSSSSSSK..',
  '...KSSSSSSSSSSSSSSSSSSKKKKK...',
  '...KsssssssssssssssssK........',
  '....KKSSSK.....KSSSKK.........',
  '.....KSSSK.....KSSSK..........',
  '.....KsssK.....KsssK..........',
  '.....KKKKKK....KKKKKK.........',
  '..............................',
  '..............................',
];

/** SVG rects for the grid, one per horizontal run of same-colored pixels. */
export function grampsRects(px = 10, x0 = 0, y0 = 0) {
  const out = [];
  GRAMPS.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let run = 1;
      while (row[x + run] === ch) run++;
      if (PALETTE[ch]) {
        out.push(`<rect x="${x0 + x * px}" y="${y0 + y * px}" width="${run * px}" height="${px}" fill="${PALETTE[ch]}"/>`);
      }
      x += run;
    }
  });
  return out.join('');
}

export const GRAMPS_SIZE = { w: GRAMPS[0].length, h: GRAMPS.length };

export function grampsSvg(px = 16) {
  const { w, h } = GRAMPS_SIZE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * px}" height="${h * px}" viewBox="0 0 ${w * px} ${h * px}" shape-rendering="crispEdges">${grampsRects(px)}</svg>\n`;
}
