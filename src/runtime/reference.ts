import { getHelpSections } from './help.js';

/**
 * One description of the command tree, shared by `scripts/generate-cli-docs.sh`
 * and `browser help --json`, so the two cannot disagree.
 */
export const REFERENCE_OPTIONS = {
  bin: 'browser',
  description: 'Drive real browsers with their profiles and cookies from the command line. Agents use a persistent task to navigate pages, inspect elements, interact with forms, capture screenshots and network traffic, then close the task. A local IPC service manages browser processes and tabs, using Chrome DevTools Protocol, Firefox WebDriver BiDi or native Arc control; tasks can also run on another machine over SSH.',
  helpSections: getHelpSections,
  regenerate: 'scripts/generate-cli-docs.sh',
};
