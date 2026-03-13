export {
  initTreeSitter,
  selectGrammar,
  parseSource,
  extractSymbolsFromTree,
  hashContent,
  createParsedFile,
} from "./treesitter.js";
export type { TreeSitterTree, TreeSitterNode } from "./treesitter.js";

export {
  createTsMorphProject,
  extractSymbolsFromSourceFile,
  parseFileWithTsMorph,
} from "./tsmorph.js";
export type {
  TsMorphProject,
  TsMorphSourceFile,
  TsMorphFunction,
  TsMorphClass,
  TsMorphMethod,
  TsMorphInterface,
  TsMorphTypeAlias,
  TsMorphEnum,
  TsMorphDeclaration,
  CreateProjectOptions,
} from "./tsmorph.js";

export { classifyFileKind, isParseable } from "./classify.js";

export { parseFiles } from "./parser.js";
export type {
  ParseOptions,
  ParseResult,
  ParseStats,
  ProgressInfo,
} from "./parser.js";
