import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

export function guardCircularSplat(source) {
  // Upstream r186 floors the eigenvalue radius at sqrt(1e-7), greater than
  // the 1e-5 orientation guard. A circular projection therefore calls atan2(0,0)
  // and disappears on affected GPUs. Test the actual off-diagonal/difference,
  // keeping the upstream radius/eigenvalue floors and all other math intact.
  const before = 'If( radius.greaterThan( 0.00001 ), () => {';
  const after = 'If( b.abs().greaterThan( 0.00001 ).or( a.sub( c ).abs().greaterThan( 0.00001 ) ), () => {';
  if (source.split(before).length !== 2) throw new Error('Re-review GaussianSplat circular-projection guard for this upstream version');
  return source.replace(before, after);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await build({entryPoints:['viewer-vendor-three-r186.mjs'],bundle:true,minify:true,
    alias:{three:'three-r186'},format:'iife',platform:'browser',target:'es2020',
    outfile:'viewer-vendor-three-r186.bundle.js',
    plugins:[{name:'r186-circular-splat-guard',setup(builder){
      builder.onLoad({filter:/\/three-r186\/examples\/jsm\/objects\/GaussianSplat\.js$/},async({path})=>({
        contents:guardCircularSplat(await readFile(path,'utf8')),loader:'js',
      }));
    }}],
  });
}
