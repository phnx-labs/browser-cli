export function encodePwshBase64(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}
