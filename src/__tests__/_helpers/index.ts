/**
 * Barrel export so generated tests can write
 *   `import { notImplemented, toTransitionFrom } from "../test-helpers";`
 * without knowing the internal file layout.
 */
export {
  notImplemented,
  toTransitionFrom,
  TransitionSpec,
} from "./sm";
