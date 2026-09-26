// Gus: a pixel gas-pump gremlin. One grid, rendered to SVG/PNG by `node mascot/gus.mjs`.

import { writeFileSync } from 'node:fs';

const PALETTE = {
  K: '#14120f', // outline
  R: '#ff4d2e', // pump body
  r: '#c7361c', // body shadow
  Y: '#ffd23f', // screen glow / fuel
  y: '#e0a800', // screen shadow
  W: '#fff8e7', // eye white / highlight
  G: '#c6f432', // nozzle grip (the Robinhood-lime accent)
  g: '#8fb31f', // grip shadow
  H: '#2a2a2a', // hose
  T: '#f4f1e8', // teeth
};

// 32 x 30. '.' is transparent.
export const GUS = [
  '................................',
  '........KKKKKKKKKKKKKK..........',
  '.......KRRRRRRRRRRRRRRK.........',
  '......KRRWRRRRRRRRRRRRRK........',
  '......KRRRKKKKKKKKKKRRRK........',
  '......KRRKYKYYYYYYKYKRRK........',
  '......KRRKYYKYYYYKYYKRRK........',
  '......KRRKYWKYYYYWKYKRRK..KKK...',
  '......KRRKYKKYYYYKKYKRRK.KGGGK..',
  '......KRRKyYYYYYYYYyKRRK.KGgGK..',
  '......KRRKyyyyyyyyyyKRRKKKGGGK..',
  '......KRRRKKKKKKKKKKRRRKHKKGK...',
  '......KRRKRRRRRRRRRRKRRKHH.K....',
  '......KRRKTTTTTTTTTTKRRK.HH.....',
  '......KRRRKKKKKKKKKKRRRK..HH....',
  '......KRRRRRRRRRRRRRRRRK...HH...',
  '......KRRKKKKKKKKKKKRRRK....H...',
  '......KRRKYYYYYYYYYKRRRK....H...',
  '......KRRKYKYKYKYKYKRRRK...HH...',
  '......KRRKYYYYYYYYYKRRRK..HH....',
  '......KRRKKKKKKKKKKKRRRKHHH.....',
  '......KrRRRRRRRRRRRRRRrKH.......',
  '......KrrrrrrrrrrrrrrrrK........',
  '.....KKKKKKKKKKKKKKKKKKKK.......',
  '.....KrrrrrrrrrrrrrrrrrrK.......',
  '.....KKKKKKKKKKKKKKKKKKKK.......',
  '......KK..............KK........',
  '......KK..............KK........',
  '................................',
  '................................',
];

export function gusRects(px = 10, x0 = 0, y0 = 0) {
  const out = [];
  GUS.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const ch = row[x];
      let run = 1;
      while (row[x + run] === ch) run++;
      if (PALETTE[ch]) out.push(`<rect x="${x0 + x * px}" y="${y0 + y * px}" width="${run * px}" height="${px}" fill="${PALETTE[ch]}"/>`);
      x += run;
    }
  });
  return out.join('');
}

export function gusSvg(px = 16) {
  const w = GUS[0].length * px;
  const h = GUS.length * px;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${gusRects(px)}</svg>\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const row of GUS) if (row.length !== 32) throw new Error(`row width ${row.length}: ${row}`);
  writeFileSync(new URL('./gus.svg', import.meta.url), gusSvg());
}
