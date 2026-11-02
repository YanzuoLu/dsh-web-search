// Give every host release a fresh URL, so an existing DSH process does not reuse
// Node's cached copy of the previous search backend or its relative modules.
import {createHash} from 'node:crypto'
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises'
const root=new URL('../',import.meta.url)
const names=['index.js',...(await readdir(new URL('lib/',root))).filter(n=>n.endsWith('.js')).sort().map(n=>`lib/${n}`)]
const files=await Promise.all(names.map(async name=>[name,await readFile(new URL(name,root),'utf8')]))
const revision=createHash('sha256').update(files.map(([name,text])=>`${name}\0${text}`).join('\0')).digest('hex').slice(0,12)
const directory=new URL(`dist/host/${revision}/`,root)
await mkdir(new URL('lib/',directory),{recursive:true})
for(const [name,text]of files){
 const path=new URL(name,directory)
 let previous
 try{previous=await readFile(path,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}
 if(previous!==undefined&&previous!==text)throw Error(`Immutable host release collision: ${revision}/${name}`)
 if(previous===undefined)await writeFile(path,text,{flag:'wx'})
}
const patch=`- insert:\n    - id: web-search\n      name: ./dist/host/${revision}/index.js\n`
const path=new URL('cordis.patch.yml',root)
if(await readFile(path,'utf8')!==patch)await writeFile(path,patch)
console.log(`Web search host ${revision}`)
