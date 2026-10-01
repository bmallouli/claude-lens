export function sessionIds(stdout: string): string[] {
  return stdout.trimEnd().split('\n').map((row) => row.split('\t')[0]!);
}
