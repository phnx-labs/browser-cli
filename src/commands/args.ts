import { Command, InvalidArgumentError } from 'commander';

export function refArgument(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError(`"${value}" is not a ref; pass the integer from \`browser refs\`.`);
  }
  return Number(value);
}

export function intOption(value: string, _previous?: unknown): number {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError(`"${value}" is not an integer.`);
  }
  return Number(value);
}

export function pointArgument(value: string): { x: number; y: number } {
  const parts = value.split(',');
  if (parts.length !== 2) {
    throw new InvalidArgumentError(`"${value}" is not X,Y (e.g. 320,540).`);
  }
  const x = Number(parts[0].trim());
  const y = Number(parts[1].trim());
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new InvalidArgumentError(`"${value}" is not X,Y (e.g. 320,540).`);
  }
  return { x, y };
}

export function bindArgument(command: Command, name: string, parser: (value: string) => number): void {
  const argument = command.registeredArguments.find((item) => item.name() === name);
  if (!argument) throw new Error(`${command.name()} has no <${name}> argument`);
  argument.argParser(parser);
}
