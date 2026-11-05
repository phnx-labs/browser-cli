import manifest from '../package.json';
export function version(): string { return manifest.version; }
export function getCliVersion(): string { return version(); }
