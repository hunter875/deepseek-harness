import { pathToFileURL } from 'node:url';
const [modulePath,exportName,input]=process.argv.slice(2);
const implementation=await import(pathToFileURL(modulePath));
const result=await implementation[exportName](JSON.parse(input));
process.stdout.write(JSON.stringify(result));
