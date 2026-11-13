import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const normalize=id=>id.replaceAll('\\','/');

/**
 * The published @openbci/utilities 1.0.0 UMD contains webpack eval-source-map
 * module factories. Rollup can deconflict their `exports` binding without seeing
 * references hidden inside strings. Decode only those whole module bodies,
 * before CommonJS/Rollup analysis, so normal scope analysis/minification works.
 * No SDK algorithm, module linkage, or application code is substituted.
 */
export function openBciProductionCompatibility() {
  const sdkId=normalize(require.resolve('@openbci/utilities/dist/openbci-utilities.js'));
  return {
    name:'openbci-production-compatibility',
    apply:'build',
    enforce:'pre',
    transform(code,id) {
      if(normalize(id)!==sdkId) return null;
      const fail=()=>{throw new Error('OpenBCI compatibility: unexpected webpack eval module format; review the SDK before building');};
      const edits=[];
      const visit=(node,ancestors=[])=>{
        if(!node || typeof node!=='object') return;
        if(node.type==='CallExpression' && node.callee.type==='Identifier' && node.callee.name==='eval') {
          const [argument]=node.arguments;
          const statement=ancestors.at(-1);
          const block=ancestors.at(-2);
          const factory=ancestors.at(-3);
          // In this SDK each direct eval is the sole body statement, apart
          // from an optional strict directive. Its completion value is unused;
          // all bindings remain private to the same webpack factory function.
          if(node.arguments.length!==1 || argument?.type!=='Literal' || typeof argument.value!=='string'
            || statement?.type!=='ExpressionStatement' || block?.type!=='BlockStatement'
            || factory?.type!=='FunctionExpression' || factory.body!==block
            || factory.params[0]?.name!=='module'
            || !['exports','__webpack_exports__'].includes(factory.params[1]?.name)
            || !argument.value.includes('//# sourceURL=webpack:///')
            || block.body.some(other=>other!==statement && !(other.type==='ExpressionStatement' && other.expression.type==='Literal' && other.expression.value==='use strict'))) fail();
          // Validate syntax before inserting verbatim source. Do not recursively
          // rewrite eval inside decoded libraries (e.g. webpack's global probe).
          this.parse(argument.value);
          edits.push({start:statement.start,end:statement.end,body:argument.value});
        }
        for(const value of Object.values(node)) {
          if(Array.isArray(value)) for(const child of value) visit(child,[...ancestors,node]);
          else if(value && typeof value==='object') visit(value,[...ancestors,node]);
        }
      };
      visit(this.parse(code));
      // Fail closed if a dependency update changes the locked webpack envelope.
      if(edits.length!==16) fail();
      let output=code;
      for(const {start,end,body} of edits.sort((a,b)=>b.start-a.start)) {
        output=output.slice(0,start)+body+'\n'+output.slice(end);
      }
      // The upstream artifact encodes each source module on a single line;
      // there is no usable original source map to preserve here.
      return {code:output,map:null};
    },
  };
}
