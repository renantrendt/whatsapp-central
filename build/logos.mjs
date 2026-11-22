// Gera as opções de logo "W" (SVG e PNG) e uma folha com todas lado a lado.
import fs from 'node:fs'
import sharp from 'sharp'

const W = 'M 300 380 L 398 650 L 512 452 L 626 650 L 724 380'
const frame = (fill, inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a9a72"/><stop offset="1" stop-color="#17664a"/></linearGradient>
  <linearGradient id="d" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2b29"/><stop offset="1" stop-color="#161615"/></linearGradient>
</defs>
<rect x="100" y="100" width="824" height="824" rx="186" fill="${fill}"/>
${inner}
</svg>`

const options = {
  'a-green-bold': frame('url(#g)', `<path d="${W}" fill="none" stroke="#fff" stroke-width="96" stroke-linecap="round" stroke-linejoin="round"/>`),
  'b-dark-green': frame('url(#d)', `<path d="${W}" fill="none" stroke="#4fb58b" stroke-width="88" stroke-linecap="round" stroke-linejoin="round"/>`),
  'c-two-numbers': frame('url(#g)', `
    <path d="M 300 380 L 406 650 L 512 380" fill="none" stroke="#ffffff" stroke-width="88" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M 512 380 L 618 650 L 724 380" fill="none" stroke="#bfe8d6" stroke-width="88" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>`),
  'd-light-thin': frame('#f6f6f4', `<rect x="100" y="100" width="824" height="824" rx="186" fill="none" stroke="#e4e3df" stroke-width="6"/>
    <path d="${W}" fill="none" stroke="#1f7a5a" stroke-width="56" stroke-linecap="round" stroke-linejoin="round"/>`),
}

const tiles = []
for (const [name, svg] of Object.entries(options)) {
  fs.writeFileSync(`build/logo-options/${name}.svg`, svg)
  const png = await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer()
  fs.writeFileSync(`build/logo-options/${name}.png`, png)
  tiles.push(png)
}
// Folha de comparação: 4 logos com a letra da opção embaixo.
const labels = ['A', 'B', 'C', 'D']
const sheetW = 4 * 300 + 40, sheetH = 380
const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}">
<rect width="100%" height="100%" fill="#ffffff"/>
${labels.map((l, i) => `<text x="${20 + i * 300 + 150}" y="345" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="700" fill="#1c1b19" text-anchor="middle">${l}</text>`).join('')}
</svg>`
const composite = await Promise.all(tiles.map(async (t, i) => ({ input: await sharp(t).resize(270, 270).toBuffer(), left: 20 + i * 300 + 15, top: 20 })))
await sharp(Buffer.from(labelSvg)).composite(composite).png().toFile('build/logo-options/options-sheet.png')
console.log('ok')
