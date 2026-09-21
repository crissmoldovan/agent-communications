/**
 * The package name a command line names, read the way `listRegisteredServers` reads it.
 *
 * Shared with the tests rather than re-typed in them: `isOurServer` takes `packageName` as given, and a test that
 * derives it differently from production is testing its own regex.
 */
export function packageFrom(line: string): string | undefined {
  return /(@[\w.-]+\/[\w.-]+|(?<=\s)[\w.-]+-mcp)(?=@|\s|$)/.exec(line)?.[1];
}
