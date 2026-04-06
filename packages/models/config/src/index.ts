export { buildFeatureModel } from "./feature-model.js";
export type { BuildFeatureModelOptions } from "./feature-model.js";
export { extractConstraintsFromCode } from "./constraints.js";
export type { ExtractedConstraint } from "./constraints.js";
export { validateFeatureModel, validateConfiguration, CONFIG_RULES } from "./z3.js";
export type {
  Z3ValidationResult,
  ConfigValidationResult,
  ConfigValidationIssue,
  MissingDependencyFinding,
  ConflictingSettingsFinding,
} from "./z3.js";
export { generateCoveringArray, computeInteractionStrength } from "./covering-array.js";
export type {
  CoveringArrayOptions,
  CoveringArrayResult,
  InteractionStrengthResult,
} from "./covering-array.js";
