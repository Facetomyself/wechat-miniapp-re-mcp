import { WxmpApp } from '../app.js';
import { bool, booleanProp, entry, numberProp, num, objectSchema, optionalText, result, stringArray, stringProp, text } from './helpers.js';
import { ToolEntry } from './types.js';

export function buildStaticTools(app: WxmpApp): ToolEntry[] {
  return [
    entry('wxmp_scan_packages', 'Scan default or explicit package roots for .wxapkg files.', objectSchema({ roots: { type: 'array', items: { type: 'string' } }, limit: numberProp('Maximum packages.') }), async (args) => result(await app.staticAdapter.scan(stringArray(args, 'roots'), Math.min(10_000, num(args, 'limit', 1000))))),

    entry('wxmp_unpack', 'Run the configured Gwxapkg backend for extraction without embedding it into the MCP core.', objectSchema({ input_path: stringProp('wxapkg file or package directory.'), project_name: stringProp('Workspace project.'), app_id: stringProp('Optional AppID.'), output_name: stringProp('Optional output directory name.'), extra_args: { type: 'array', items: { type: 'string' } } }, ['input_path', 'project_name']), async (args) => result(await app.staticAdapter.decompile({ inputPath: text(args, 'input_path'), projectName: text(args, 'project_name'), appId: optionalText(args, 'app_id'), outputName: optionalText(args, 'output_name'), extraArgs: ['-restore=false', ...stringArray(args, 'extra_args')] }))),

    entry('wxmp_decompile', 'Run full Gwxapkg restore/decompile into the controlled workspace.', objectSchema({ input_path: stringProp('wxapkg file or directory.'), project_name: stringProp('Workspace project.'), app_id: stringProp('Optional AppID.'), output_name: stringProp('Optional output directory name.'), extra_args: { type: 'array', items: { type: 'string' } } }, ['input_path', 'project_name']), async (args) => result(await app.staticAdapter.decompile({ inputPath: text(args, 'input_path'), projectName: text(args, 'project_name'), appId: optionalText(args, 'app_id'), outputName: optionalText(args, 'output_name'), extraArgs: stringArray(args, 'extra_args') }))),

    entry('wxmp_static_search', 'Search restored JS/WXML/WXSS/WXS/JSON sources.', objectSchema({ root: stringProp('Restored source root.'), query: stringProp('Text or regex.'), regex: booleanProp('Regex mode.'), case_sensitive: booleanProp('Case-sensitive.'), limit: numberProp('Max results.') }, ['root', 'query']), async (args) => result(await app.staticAdapter.search(text(args, 'root'), text(args, 'query'), { regex: bool(args, 'regex'), caseSensitive: bool(args, 'case_sensitive'), limit: num(args, 'limit', 200) }))),

    entry('wxmp_build_index', 'Build URL, wx API, route, and file indexes for restored sources.', objectSchema({ root: stringProp('Restored source root.'), project_name: stringProp('Workspace project.') }, ['root', 'project_name']), async (args) => result(await app.staticAdapter.buildIndex(text(args, 'root'), text(args, 'project_name')))),

    entry('wxmp_repack', 'Repack a controlled restored source tree with Gwxapkg.', objectSchema({ input_path: stringProp('Restored source directory.'), project_name: stringProp('Workspace project.'), output_name: stringProp('Output wxapkg filename.') }, ['input_path', 'project_name']), async (args) => result(await app.staticAdapter.repack({ inputPath: text(args, 'input_path'), projectName: text(args, 'project_name'), outputName: optionalText(args, 'output_name') }))),

    entry('wxmp_raw_adapter', 'Invoke the configured static adapter while keeping output inside the controlled workspace.', objectSchema({ project_name: stringProp('Workspace project.'), output_name: stringProp('Optional controlled output name.'), args: { type: 'array', items: { type: 'string' } } }, ['project_name', 'args']), async (args) => result(await app.staticAdapter.raw(stringArray(args, 'args'), text(args, 'project_name'), optionalText(args, 'output_name')))),
  ];
}
